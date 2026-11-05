"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createKeychainSecrets, KEYCHAIN_SERVICE, keychainAccount } = require("../lib/keychain-secrets.js");
const { createMediaProviderSettings } = require("../lib/media-provider-settings.js");
const { testSecrets } = require("./settings-service-fixture.cjs");
const defaults = { image: null, video: null, audio: null };
const credential = "isolated-keychain-api-credential";
const profile = (action = "preserve", value) => ({ id: "p1", provider: "openai", credentialUpdate: { action, ...(value ? { value } : {}) } });
const save = (service, revision, profiles = [profile("replace", credential)]) => service.save({ expectedRevision: revision, profiles, defaults });
function keychainFixture() {
  const items = new Map(), calls = []; let failure = null; let race = false;
  return {
    items, calls,
    fail: value => { failure = value; }, race: () => { race = true; },
    run: async (args, input) => {
      calls.push({ args, input });
      if (failure) return { code: failure, stdout: "private-error-must-not-escape" };
      if (args[0] === "-i") {
        const match = /^add-generic-password -s ([\w.]+) -a ([a-f0-9]{64}) -T \/usr\/bin\/security -w ([a-f0-9]{64})\n$/.exec(input);
        assert.ok(match); assert.equal(match[1], KEYCHAIN_SERVICE);
        if (!items.has(match[2])) items.set(match[2], race ? "ab".repeat(32) : match[3]);
        return { code: 0, stdout: "" };
      }
      const account = args[args.indexOf("-a") + 1];
      return items.has(account) ? { code: 0, stdout: items.get(account) + "\n" } : { code: 44, stdout: "" };
    },
  };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "media-keychain-"));
  const vault = keychainFixture(), requests = [], services = [];
  const adapter = (directory = root, platform = "darwin") => createKeychainSecrets({ getDataPath: () => directory, run: vault.run, platform });
  const create = (secrets = adapter()) => {
    const service = createMediaProviderSettings({ getDataPath: () => root, secrets,
      request: async input => { requests.push(input); return { status: 200, headers: {}, bodyText: '{"data":[]}' }; } });
    services.push(service); return service;
  };
  t.after(async () => { await Promise.all(services.map(service => service.dispose())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file: path.join(root, "aimedia-settings.json"), vault, adapter, create, requests };
}
const safeFailure = error => error.code === "CREDENTIAL_ERROR" && !error.message.includes(credential) && !error.message.includes("private-error");

test("plugin Keychain storage saves, restarts, replaces, preserves and clears without host APIs", async t => {
  const f = await fixture(t); let service = f.create();
  assert.deepEqual((await service.read()).credentialStorageStatus, { backend: "macos-keychain", supported: true, access: "unchecked" });
  await save(service, 0); await service.dispose();
  const disk = await fs.readFile(f.file, "utf8"), envelope = JSON.parse(disk).encryptedCredentials;
  assert.equal(envelope.version, 2); assert.equal(envelope.backend, "macos-keychain");
  assert.ok(!disk.includes(credential));
  service = f.create(); const restored = await service.read();
  assert.equal(restored.profiles[0].credentialConfigured, true);
  assert.equal(restored.credentialStorageStatus.access, "available");
  assert.ok(!JSON.stringify(restored).includes(envelope.ciphertext));
  await service.probe({ profileId: "p1", expectedRevision: 1 });
  assert.equal(f.requests.at(-1).headers.Authorization, `Bearer ${credential}`);
  await save(service, 1, [profile("replace", "isolated-replacement")]); await service.dispose();
  service = f.create(); await save(service, 2, [profile()]); await service.dispose();
  service = f.create(); await service.probe({ profileId: "p1", expectedRevision: 3 });
  assert.equal(f.requests.at(-1).headers.Authorization, "Bearer isolated-replacement");
  await save(service, 3, [profile("clear")]); await service.dispose();
  service = f.create(); assert.equal((await service.read()).profiles[0].credentialConfigured, false);
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).encryptedCredentials, undefined);
  const key = [...f.vault.items.values()][0];
  assert.ok(!disk.includes(key)); assert.ok(!JSON.stringify(f.vault.calls.map(call => call.args)).includes(key));
  assert.ok(!JSON.stringify(f.vault.calls).includes(credential));
});

test("missing original key cannot be regenerated during restore or later saves", async t => {
  const f = await fixture(t), service = f.create(); await save(service, 0);
  const disk = await fs.readFile(f.file, "utf8"), items = new Map(f.vault.items); f.vault.items.clear();
  const additions = f.vault.calls.filter(call => call.input).length;
  await assert.rejects(save(service, 1), safeFailure);
  const restarted = f.create(); await assert.rejects(restarted.read(), safeFailure);
  await assert.rejects(save(restarted, 1), safeFailure);
  assert.equal(f.vault.calls.filter(call => call.input).length, additions);
  assert.equal(await fs.readFile(f.file, "utf8"), disk);
  for (const [id, value] of items) f.vault.items.set(id, value);
  assert.equal((await restarted.read()).profiles[0].credentialConfigured, true);
});

test("locked, denied, unavailable or malformed Keychain data preserves configuration and allows retry", async t => {
  const f = await fixture(t), service = f.create(); await save(service, 0);
  const disk = await fs.readFile(f.file, "utf8");
  for (const code of [36, 128, "ENOENT", "ETIMEDOUT"]) {
    f.vault.fail(code);
    await assert.rejects(save(service, 1), safeFailure);
    await assert.rejects(f.create().read(), safeFailure);
    assert.equal(await fs.readFile(f.file, "utf8"), disk);
  }
  f.vault.fail(null); const account = keychainAccount(f.root), key = f.vault.items.get(account);
  f.vault.items.set(account, "corrupt"); await assert.rejects(f.create().read(), safeFailure);
  f.vault.items.set(account, key); assert.equal((await f.create().read()).profiles[0].credentialConfigured, true);
});

test("fresh nonces, ciphertext authentication and data-directory binding protect credentials", async t => {
  const f = await fixture(t), adapter = f.adapter();
  const one = await adapter.encrypt(credential), two = await adapter.encrypt(credential);
  assert.notEqual(one, two); assert.equal(await f.adapter().decrypt(one), credential);
  const bytes = Buffer.from(one.slice(3), "base64"); bytes[13] ^= 1;
  await assert.rejects(adapter.decrypt(`v1:${bytes.toString("base64")}`), safeFailure);
  const other = path.join(f.root, "other");
  f.vault.items.set(keychainAccount(other), f.vault.items.get(keychainAccount(f.root)));
  await assert.rejects(f.adapter(other).decrypt(one), safeFailure);
});

test("a concurrent creator's committed master key is used instead of overwriting it", async t => {
  const f = await fixture(t); f.vault.race();
  const ciphertext = await f.adapter().encrypt(credential);
  assert.equal([...f.vault.items.values()][0], "ab".repeat(32));
  assert.equal(await f.adapter().decrypt(ciphertext), credential);
});

test("unsupported platforms can save ordinary configs but refuse credential persistence", async t => {
  const f = await fixture(t), service = f.create(f.adapter(f.root, "linux"));
  await save(service, 0, [profile()]); const disk = await fs.readFile(f.file, "utf8");
  assert.equal((await service.read()).credentialStorageStatus.supported, false);
  await assert.rejects(save(service, 1), { code: "CREDENTIAL_UNAVAILABLE" });
  assert.equal(await fs.readFile(f.file, "utf8"), disk); assert.equal(f.vault.calls.length, 0);
});

test("legacy host envelopes remain intact and are never decrypted under a new Keychain key", async t => {
  const f = await fixture(t), legacy = f.create(testSecrets()); await save(legacy, 0); await legacy.dispose();
  const disk = await fs.readFile(f.file, "utf8"), service = f.create();
  await assert.rejects(service.read(), { code: "CREDENTIAL_LEGACY" });
  await assert.rejects(save(service, 1, []), { code: "CREDENTIAL_LEGACY" });
  assert.equal(await fs.readFile(f.file, "utf8"), disk); assert.equal(f.vault.calls.length, 0);
});

test("failed config commit keeps the original credential usable after storage repair", async t => {
  const f = await fixture(t), service = f.create(); await save(service, 0);
  const backup = path.join(f.root, "backup.json"); await fs.rename(f.file, backup); await fs.mkdir(f.file);
  await assert.rejects(save(service, 1, [profile("replace", "not-committed")]), { code: "STORAGE_ERROR" });
  assert.equal((await service.read()).revision, 1);
  await fs.rmdir(f.file); await fs.rename(backup, f.file);
  await f.create().probe({ profileId: "p1", expectedRevision: 1 });
  assert.equal(f.requests.at(-1).headers.Authorization, `Bearer ${credential}`);
});
