"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const defaults = { image: null, video: null, audio: null };
const secret = "fixture-sensitive-key";
const profile = extra => ({ id: "mini", provider: "minimax", models: [], modelId: "", ...extra });
const response = data => ({ status: 200, bodyText: JSON.stringify(data) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "minimax-discovery-"));
  const calls = [];
  const service = createMediaProviderSettings({ getDataPath: () => root, request: async input => { calls.push(input); return handler(input); } });
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const save = (extra = {}, revision = 0) => service.save({ expectedRevision: revision, profiles: [profile(extra)], defaults });
  return { service, calls, root, save, probe: () => service.probe({ profileId: "mini", expectedRevision: 1 }) };
}
const isModels = request => request.url.endsWith("/models");

test("MiniMax zero-model profile fetches cloud media models and separate account voices", async t => {
  const f = await fixture(t, async request => response(isModels(request) ? { data: [
    { id: "image-cloud", name: "Cloud image" }, { id: "MiniMax-Hailuo-cloud" }, { id: "T2V-cloud" }, { id: "I2V-cloud" },
    { id: "speech-cloud", name: "Cloud speech" }, { id: "MiniMax-M2" }, { id: "gpt-4" }, { id: "speech-cloud" },
    { id: "image-" + secret }, { id: "https://invalid.example" }, { id: "image-safe", name: secret },
  ] } : { base_resp: { status_code: 0 }, system_voice: { items: [{ voice_id: "voice-1", voice_name: "Voice One" }] }, voice_cloning: [{ voice_id: "voice-1" }, { voice_id: "clone-1" }], voice_generation: { items: [{ voice_id: secret }] } }));
  await f.save({ credentialUpdate: { action: "replace", value: secret } });
  const value = await f.probe();
  assert.equal(value.status, "connected");
  assert.deepEqual(value.models.map(m => [m.id, m.kind]), [["image-cloud", "image"], ["MiniMax-Hailuo-cloud", "video"], ["T2V-cloud", "video"], ["I2V-cloud", "video"], ["speech-cloud", "audio"], ["image-safe", "image"]]);
  assert.deepEqual(value.voices, [{ id: "voice-1", name: "Voice One" }, { id: "clone-1", name: "clone-1" }]);
  assert.equal(value.catalogs.models.status, "connected"); assert.equal(value.catalogs.voices.status, "connected");
  assert.equal(JSON.stringify(value).includes(secret), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.find(isModels).method, "GET");
  const voiceCall = f.calls.find(c => !isModels(c));
  assert.equal(voiceCall.method, "POST"); assert.equal(voiceCall.body, '{"voice_type":"all"}');
  assert(f.calls.every(c => c.headers.Authorization === `Bearer ${secret}` && c.redirect === "error" && c.timeoutMs === 15000));
  const saved = await f.service.read();
  assert.deepEqual(saved.profiles[0].models, []); assert.equal(saved.profiles[0].voice, "");
  assert.equal((await fs.readFile(path.join(f.root, "aimedia-settings.json"), "utf8")).includes(secret), false);
});

test("MiniMax accepts documented model envelopes and never invents models for chat-only responses", async t => {
  for (const models of [["speech-future"], { models: [{ name: "speech-future" }] }, { data: [{ id: "MiniMax-M2.5" }] }]) {
    const f = await fixture(t, async req => response(isModels(req) ? models : { system_voice: [] }));
    await f.save({ credentialUpdate: { action: "replace", value: secret } });
    const result = await f.probe();
    assert.equal(result.catalogs.models.status, "connected");
    assert.deepEqual(result.models.map(m => m.id), models.data ? [] : ["speech-future"]);
  }
});

test("MiniMax partial failures preserve the successful catalog and report failure independently", async t => {
  for (const failed of ["models", "voices"]) {
    const f = await fixture(t, async req => (isModels(req) === (failed === "models"))
      ? { status: 404, bodyText: secret }
      : response(isModels(req) ? { data: [{ id: "image-cloud" }] } : { system_voice: [{ voice_id: "voice-cloud" }] }));
    await f.save({ credentialUpdate: { action: "replace", value: secret } });
    const value = await f.probe();
    assert.equal(value.status, "connected");
    assert.equal(value.catalogs[failed].status, "unavailable");
    assert.equal(value.catalogs[failed].code, "ENDPOINT_NOT_FOUND");
    assert.equal(value.models.length, failed === "models" ? 0 : 1);
    assert.equal(value.voices.length, failed === "voices" ? 0 : 1);
    assert(!JSON.stringify(value).includes(secret));
  }
});

test("MiniMax missing keys, denied requests and invalid response shapes remain honest and sanitized", async t => {
  const empty = await fixture(t, () => { throw Error("Unexpected network"); });
  await empty.save();
  assert.equal((await empty.probe()).code, "CREDENTIAL_REQUIRED"); assert.equal(empty.calls.length, 0);
  for (const handler of [
    async () => { throw Object.assign(Error(secret), { code: "PERMISSION_DENIED" }); },
    async () => response({ base_resp: { status_code: 1004, status_msg: secret }, data: [{ id: "image-cloud" }], system_voice: [] }),
    async () => response({ data: "invalid", system_voice: {} }),
  ]) {
    const f = await fixture(t, handler); await f.save({ credentialUpdate: { action: "replace", value: secret } });
    const result = await f.probe();
    assert.equal(result.status, "unavailable"); assert.deepEqual(result.models, []); assert.deepEqual(result.voices, []);
    assert(!JSON.stringify(result).includes(secret));
  }
});

test("MiniMax waits for both catalog requests and rejects obsolete results after save", async t => {
  const modelStart = deferred(), voiceStart = deferred(), models = deferred(), voices = deferred();
  const f = await fixture(t, async req => { if (isModels(req)) { modelStart.resolve(); return models.promise; } voiceStart.resolve(); return voices.promise; });
  await f.save({ credentialUpdate: { action: "replace", value: secret } });
  const running = f.probe();
  await Promise.all([modelStart.promise, voiceStart.promise]);
  models.resolve({ status: 500, bodyText: secret });
  await assert.rejects(f.probe(), { code: "PROBE_PENDING" });
  await f.save({ name: "Changed" }, 1);
  voices.resolve(response({ system_voice: [{ voice_id: "late-voice" }] }));
  await assert.rejects(running, { code: "CONFLICT" });
  assert.equal((await f.service.read()).profiles[0].lastProbe, undefined);
});

test("MiniMax remote models and voices are each bounded to 100 entries", async t => {
  const f = await fixture(t, async req => response(isModels(req)
    ? { data: Array.from({ length: 150 }, (_, i) => ({ id: `image-${i}` })) }
    : { system_voice: Array.from({ length: 150 }, (_, i) => ({ voice_id: `voice-${i}` })) }));
  await f.save({ credentialUpdate: { action: "replace", value: secret } });
  const value = await f.probe();
  assert.equal(value.models.length, 100); assert.equal(value.voices.length, 100);
});

test("MiniMax catalog selection requests only the chosen endpoint without changing the saved voice", async t => {
  for (const catalog of ["models", "voices"]) {
    const f = await fixture(t, async req => {
      assert.equal(isModels(req), catalog === "models");
      return response(catalog === "models" ? { data: [{ id: "image-cloud" }] } : { system_voice: [{ voice_id: "voice-cloud" }] });
    });
    await f.save({ voice: "legacy-voice", credentialUpdate: { action: "replace", value: secret } });
    const value = await f.service.probe({ profileId: "mini", expectedRevision: 1, catalog });
    assert.equal(value.status, "connected");
    assert.deepEqual(Object.keys(value.catalogs), [catalog]);
    assert.deepEqual(value.scope, { kind: "profile", profileId: "mini", catalog });
    assert.equal(value.models.length, catalog === "models" ? 1 : 0);
    assert.equal(value.voices.length, catalog === "voices" ? 1 : 0);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.service.read()).profiles[0].voice, "legacy-voice");
  }
});

test("catalog selection rejects invalid or non-MiniMax requests before networking", async t => {
  const f = await fixture(t, () => { throw Error("Unexpected network"); });
  await f.save({ credentialUpdate: { action: "replace", value: secret } });
  for (const catalog of ["all", "audio", "", null]) await assert.rejects(f.service.probe({ profileId: "mini", expectedRevision: 1, catalog }), { code: "INVALID_ARGUMENT" });
  await f.save({ provider: "openai", credentialUpdate: { action: "replace", value: secret } }, 1);
  await assert.rejects(f.service.probe({ profileId: "mini", expectedRevision: 2, catalog: "models" }), { code: "INVALID_ARGUMENT" });
  assert.equal(f.calls.length, 0);
});
