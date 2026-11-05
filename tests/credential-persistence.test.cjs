"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMediaProviderSettings, testSecrets } = require("./settings-service-fixture.cjs");
const defaults = { image: null, video: null, audio: null };
const key = "fixture-persistent-private-key";
const profile = extra => ({ id: "p1", provider: "openai", ...extra });
const replace = value => ({ credentialUpdate: { action: "replace", value } });
const save = (service, profiles, expectedRevision = 0) => service.save({ expectedRevision, profiles, defaults });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "media-sealed-"));
  const services = [], requests = [];
  const create = (extra = {}) => {
    const service = createMediaProviderSettings({ getDataPath: () => root, request: async input => { requests.push(input); return { status: 200, headers: {}, bodyText: '{"data":[]}' }; }, ...extra });
    services.push(service); return service;
  };
  t.after(async () => { await Promise.all(services.map(service => service.dispose())); await fs.rm(root, { force: true, recursive: true }); });
  return { root, file: path.join(root, "aimedia-settings.json"), create, requests };
}
const safeError = code => error => error.code === code && !error.message.includes(key) && !error.message.includes("v1:");

test("saving credentials survives a new service and authenticates without exposing plaintext", async t => {
  const f = await fixture(t), first = f.create();
  await save(first, [profile(replace(key))]); await first.dispose();
  const restarted = f.create(), loaded = await restarted.read();
  assert.equal(loaded.profiles[0].credentialConfigured, true);
  assert.ok(!JSON.stringify(loaded).includes(key));
  const disk = await fs.readFile(f.file, "utf8");
  assert.ok(!disk.includes(key)); assert.ok(!disk.includes("credentialUpdate"));
  assert.equal(JSON.parse(disk).encryptedCredentials.version, 1);
  assert.equal((await restarted.probe({ profileId: "p1", expectedRevision: 1 })).status, "connected");
  assert.equal(f.requests[0].headers.Authorization, `Bearer ${key}`);
});

test("replacement, clearing, deletion and endpoint changes persist across reload", async t => {
  const f = await fixture(t); let service = f.create(), revision = 0;
  for (const [profiles, expected] of [
    [[profile(replace(key))], true], [[profile({ name: "Renamed" })], true],
    [[profile(replace("fixture-replaced-key"))], true],
    [[profile({ credentialUpdate: { action: "clear" } })], false],
    [[profile(replace(key))], true], [[profile({ baseUrl: "https://custom.example/v1" })], false],
    [[profile(replace(key))], true], [[], false], [[profile()], false],
  ]) {
    await save(service, profiles, revision++); await service.dispose(); service = f.create();
    const state = await service.read();
    assert.equal(state.profiles[0]?.credentialConfigured || false, expected);
    if (revision === 3) { await service.probe({ profileId: "p1", expectedRevision: revision }); assert.equal(f.requests.at(-1).headers.Authorization, "Bearer fixture-replaced-key"); }
    if (!expected) assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).encryptedCredentials, undefined);
  }
});

test("missing or denied host encryption never reports a successful credential save", async t => {
  for (const secrets of [undefined, {}, { encrypt: async () => { throw Object.assign(Error(key), { code: "PERMISSION_DENIED" }); } }]) {
    const f = await fixture(t), service = f.create({ secrets });
    await assert.rejects(save(service, [profile(replace(key))]), safeError(secrets?.encrypt ? "PERMISSION_DENIED" : "CREDENTIAL_UNAVAILABLE"));
    assert.equal((await service.read()).revision, 0);
    await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
  }
});

test("encryption failure preserves previously committed configuration and credential", async t => {
  const f = await fixture(t), secrets = testSecrets(), service = f.create({ secrets });
  await save(service, [profile(replace(key))]); const before = await fs.readFile(f.file, "utf8");
  secrets.encrypt = async () => { throw Error(key); };
  await assert.rejects(save(service, [profile(replace("replacement-value"))], 1), safeError("CREDENTIAL_ERROR"));
  assert.equal((await service.read()).revision, 1); assert.equal(await fs.readFile(f.file, "utf8"), before);
  await service.probe({ profileId: "p1", expectedRevision: 1 }); assert.equal(f.requests[0].headers.Authorization, `Bearer ${key}`);
  assert.equal((await f.create().read()).profiles[0].credentialConfigured, true);
});

test("wrong plugin, wrong key and tampered ciphertext fail closed without overwriting data", async t => {
  const f = await fixture(t), first = f.create(); await save(first, [profile(replace(key))]); await first.dispose();
  const before = await fs.readFile(f.file, "utf8");
  for (const secrets of [testSecrets("another.plugin"), testSecrets("bone.aimedia.services", Buffer.alloc(32, 91)), { decrypt: async () => { throw Object.assign(Error(key), { code: "PERMISSION_DENIED" }); } }, undefined]) {
    const service = f.create({ secrets });
    await assert.rejects(service.read(), error => ["CREDENTIAL_ERROR", "CREDENTIAL_UNAVAILABLE", "PERMISSION_DENIED"].includes(error.code) && !error.message.includes(key));
    await assert.rejects(save(service, [])); assert.equal(await fs.readFile(f.file, "utf8"), before);
  }
  const corrupt = JSON.parse(before), bytes = Buffer.from(corrupt.encryptedCredentials.ciphertext.slice(3), "base64"); bytes[13] ^= 1;
  corrupt.encryptedCredentials.ciphertext = `v1:${bytes.toString("base64")}`;
  await fs.writeFile(f.file, JSON.stringify(corrupt)); const service = f.create();
  await assert.rejects(service.read(), safeError("CREDENTIAL_ERROR"));
  await fs.writeFile(f.file, before);
  assert.equal((await service.read()).profiles[0].credentialConfigured, true, "Retry recovers after the original envelope is restored");
});

test("legacy configs stay readable and plaintext cannot enter the public ciphertext contract", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ revision: 3, profiles: [profile()], defaults }));
  const service = f.create(); assert.equal((await service.read()).profiles[0].credentialConfigured, false);
  await assert.rejects(service.save({ expectedRevision: 3, profiles: [], defaults, encryptedCredentials: { version: 1, ciphertext: key } }), { code: "INVALID_ARGUMENT" });
  await save(service, [profile(replace(key))], 3); await service.dispose();
  assert.equal((await f.create().read()).profiles[0].credentialConfigured, true);
});

test("changing public identity on disk cannot reuse an authenticated credential", async t => {
  const f = await fixture(t), service = f.create(); await save(service, [profile(replace(key))]); await service.dispose();
  const persisted = JSON.parse(await fs.readFile(f.file, "utf8")); persisted.profiles[0].baseUrl = "https://custom.example/v1";
  await fs.writeFile(f.file, JSON.stringify(persisted));
  await assert.rejects(f.create().read(), safeError("CREDENTIAL_ERROR")); assert.equal(f.requests.length, 0);
});

test("disposal while encryption is pending cannot commit or reinstall secrets", async t => {
  const f = await fixture(t); let started, release;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const delegate = testSecrets();
  const service = f.create({ secrets: { encrypt: async value => { started(); await gate; return delegate.encrypt(value); } } });
  const saving = save(service, [profile(replace(key))]), rejected = assert.rejects(saving, { code: "DISPOSED" });
  await entered; const draining = service.dispose(); release(); await rejected; await draining;
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});
