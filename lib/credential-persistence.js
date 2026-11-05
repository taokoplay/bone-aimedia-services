"use strict";

const { assert, fail, keys, identifier } = require("./media-provider-schema.js");
const { profileIdentity } = require("./comfy-resource-snapshots.js");
const MAX_PLAINTEXT = 1024 * 1024;
function envelope(value) {
  keys(value, value?.version === 2 ? ["version", "backend", "ciphertext"] : ["version", "ciphertext"]);
  assert((value.version === 1 || value.version === 2 && value.backend === "macos-keychain") && typeof value.ciphertext === "string" && value.ciphertext.length <= 2 * MAX_PLAINTEXT);
  assert(/^v1:[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext));
  const bytes = Buffer.from(value.ciphertext.slice(3), "base64");
  assert(bytes.length >= 28 && bytes.length <= MAX_PLAINTEXT + 28 && bytes.toString("base64") === value.ciphertext.slice(3));
  return { version: value.version, ...(value.version === 2 ? { backend: value.backend } : {}), ciphertext: value.ciphertext };
}
function safeFailure(error) {
  if (error?.code === "PERMISSION_DENIED") fail("PERMISSION_DENIED", "Credential access was denied. Existing data was preserved.");
  if (error?.code === "CREDENTIAL_UNAVAILABLE") fail("CREDENTIAL_UNAVAILABLE", "Credential encryption is unavailable on this platform.");
  fail("CREDENTIAL_ERROR", "Credentials could not be encrypted or restored safely. Existing data was preserved.");
}
function createCredentialPersistence(secrets) {
  async function invoke(method, value) {
    assert(typeof secrets?.[method] === "function", "CREDENTIAL_UNAVAILABLE", "Credential encryption is unavailable.");
    try { return await secrets[method](value); } catch (error) { safeFailure(error); }
  }
  async function seal(credentials, profiles) {
    if (!credentials.size) return undefined;
    const entries = [...credentials].map(([id, value]) => ({ id, identity: profileIdentity(profiles.find(profile => profile.id === id)), value }));
    const plaintext = JSON.stringify({ version: 1, entries });
    assert(Buffer.byteLength(plaintext) <= MAX_PLAINTEXT, "CREDENTIAL_ERROR", "Credential data exceeds the storage limit.");
    const ciphertext = await invoke("encrypt", plaintext);
    try { return envelope({ version: secrets.storageVersion || 1, ...(secrets.storageVersion === 2 ? { backend: "macos-keychain" } : {}), ciphertext }); } catch (error) { safeFailure(error); }
  }
  async function restore(value, profiles) {
    if (value === undefined) return new Map();
    if (value.version === 1 && secrets?.storageVersion === 2) fail("CREDENTIAL_LEGACY", "Legacy host-encrypted data requires its original encryption environment. Existing data was preserved.");
    assert(value.version !== 2 || secrets?.storageVersion === 2, "CREDENTIAL_UNAVAILABLE", "This credential format requires the Keychain adapter.");
    const plaintext = await invoke("decrypt", value.ciphertext);
    try {
      assert(typeof plaintext === "string" && Buffer.byteLength(plaintext) <= MAX_PLAINTEXT);
      const parsed = JSON.parse(plaintext); keys(parsed, ["version", "entries"]);
      assert(parsed.version === 1 && Array.isArray(parsed.entries) && parsed.entries.length <= 32);
      const credentials = new Map();
      for (const entry of parsed.entries) {
        keys(entry, ["id", "identity", "value"]); identifier(entry.id);
        const profile = profiles.find(item => item.id === entry.id);
        assert(profile && !["dreamina", "libtv"].includes(profile.provider) && !(profile.provider === "comfyui" && profile.authKind === "none"));
        assert(entry.identity === profileIdentity(profile) && !credentials.has(entry.id));
        assert(typeof entry.value === "string" && entry.value.length > 0 && entry.value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(entry.value));
        credentials.set(entry.id, entry.value);
      }
      return credentials;
    } catch (error) { safeFailure(error); }
  }
  return { seal, restore, status: () => secrets?.status?.() || { backend: "injected", supported: !!secrets, access: "unchecked" } };
}
module.exports = { envelope, createCredentialPersistence };
