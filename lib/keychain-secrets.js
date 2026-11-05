"use strict";

const { execFile } = require("node:child_process");
const { createHash, randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const path = require("node:path");
const { assert, fail } = require("./media-provider-schema.js");
const KEYCHAIN_SERVICE = "bone.aimedia.services.credentials.v2";
const MAX_BYTES = 1024 * 1024;

function keychainAccount(dataPath) {
  assert(typeof dataPath === "string" && path.isAbsolute(dataPath), "CREDENTIAL_ERROR", "Credential storage requires a stable absolute directory.");
  return createHash("sha256").update(path.resolve(dataPath)).digest("hex");
}

function runSecurity(args, input) {
  return new Promise(resolve => {
    // Never place key material in argv, a shell command, an environment variable,
    // or a temporary file. Interactive security accepts commands over this pipe.
    const child = execFile("/usr/bin/security", args, {
      timeout: 15000, killSignal: "SIGKILL", maxBuffer: 16384, encoding: "utf8",
    }, (error, stdout) => resolve({ code: error ? error.code : 0, stdout }));
    child.stdin.on("error", () => { /* Process completion reports a closed pipe. */ });
    child.stdin.end(input);
  });
}

function createKeychainSecrets({ getDataPath, run = runSecurity, platform = process.platform }) {
  let account; let used = false; let access = "unchecked";
  const supported = platform === "darwin";
  async function namespace() {
    assert(supported, "CREDENTIAL_UNAVAILABLE", "Persistent credentials currently require macOS Keychain.");
    const next = keychainAccount(await getDataPath());
    assert(!account || account === next, "CREDENTIAL_ERROR", "Credential storage directory changed.");
    account = next;
    return account;
  }
  async function key(create) {
    const identity = await namespace();
    const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", identity, "-w"];
    let result = await run(args);
    if (result.code === 44 && create && !used) {
      const generated = randomBytes(32);
      try {
        // Fixed tokens plus a hex key; no user input enters the command parser.
        // No -U: a competing creator's key must never be overwritten. No -A:
        // only the security executable is trusted to read this item.
        const added = await run(["-i"], `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${identity} -T /usr/bin/security -w ${generated.toString("hex")}\n`);
        assert(added.code === 0, "CREDENTIAL_ERROR", "Keychain could not store an encryption key.");
        // Interactive exit status does not describe each subcommand. Read back
        // the committed item, including when another process won creation.
        result = await run(args);
      } finally { generated.fill(0); }
    }
    assert(result.code === 0 && typeof result.stdout === "string" && /^[a-f0-9]{64}\n?$/.test(result.stdout), "CREDENTIAL_ERROR", "The original Keychain encryption key is missing, locked or unavailable.");
    used = true; access = "available";
    return { key: Buffer.from(result.stdout.trim(), "hex"), aad: Buffer.from(`${KEYCHAIN_SERVICE}\0${identity}`) };
  }
  async function protect(work) {
    try { return await work(); }
    catch (error) {
      access = "unavailable";
      if (error?.code === "CREDENTIAL_UNAVAILABLE") fail("CREDENTIAL_UNAVAILABLE", "Persistent credentials currently require macOS Keychain.");
      fail("CREDENTIAL_ERROR", "Keychain credentials could not be saved or restored. Existing configuration was preserved.");
    }
  }
  return {
    storageVersion: 2,
    status: () => ({ backend: "macos-keychain", supported, access }),
    encrypt: value => protect(async () => {
      assert(typeof value === "string" && Buffer.byteLength(value) <= MAX_BYTES);
      const material = await key(true);
      try {
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", material.key, nonce);
        cipher.setAAD(material.aad);
        const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return `v1:${Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64")}`;
      } finally { material.key.fill(0); }
    }),
    decrypt: value => protect(async () => {
      assert(typeof value === "string" && value.length <= MAX_BYTES * 2 && /^v1:[A-Za-z0-9+/]+={0,2}$/.test(value));
      const bytes = Buffer.from(value.slice(3), "base64");
      assert(bytes.length >= 28 && bytes.length <= MAX_BYTES + 28 && bytes.toString("base64") === value.slice(3));
      // Decryption must never generate a replacement for a missing original key.
      const material = await key(false);
      try {
        const decipher = createDecipheriv("aes-256-gcm", material.key, bytes.subarray(0, 12));
        decipher.setAAD(material.aad); decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
      } finally { material.key.fill(0); }
    }),
  };
}

module.exports = { KEYCHAIN_SERVICE, keychainAccount, createKeychainSecrets };
