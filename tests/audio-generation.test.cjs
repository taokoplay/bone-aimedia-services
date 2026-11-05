"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createAudioGeneration } = require("../lib/audio-generation.js");
const { createImageGeneration } = require("../lib/image-generation.js");
const { createGenerationBudget } = require("../lib/media-generation.js");
const { generateMinimaxSpeech, AUDIO_REQUEST_TIMEOUT_MS } = require("../lib/minimax-speech-adapter.js");
const { prepareInput } = require("../lib/audio-generation-schema.js");
const { SUPPORTED_AUDIO_MODEL_IDS, isSupportedAudioModel } = require("../lib/audio-models.js");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const { validMp3 } = require("./audio-fixture.cjs"), { png } = require("./image-fixture.cjs");
const secret = "synthetic-audio-credential", defaults = { image: null, video: null, audio: null };
const profile = { id: "speech", provider: "minimax", name: "Speech fixture", baseUrl: "https://api.minimax.cn/v1", models: SUPPORTED_AUDIO_MODEL_IDS.map(id => ({ id, kind: "audio", name: id })), credentialUpdate: { action: "replace", value: secret } };
const imageProfile = { id: "gpt", provider: "openai", name: "Image fixture", baseUrl: "http://127.0.0.1:1/v1", models: [{ id: "gpt-image-2", name: "GPT", kind: "image" }], credentialUpdate: { action: "replace", value: "synthetic-image-credential" } };
const input = () => ({ requestId: randomUUID(), profileId: "speech", expectedRevision: 1, modelId: "speech-2.8-hd", operation: "speech", text: "A synthetic speech test.", voiceId: "English_expressive_narrator" });
const submit = job => ({ jobId: job.id, requestHash: job.requestHash, confirm: true });
const response = (body, status = 200) => ({ status, bodyText: JSON.stringify(body) });
const success = () => response({ base_resp: { status_code: 0 }, data: { status: 2, audio: validMp3().toString("hex") }, extra_info: { audio_length: 999999999, audio_sample_rate: 1, audio_size: 1 } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function trackedBudget(limit = 2) {
  const shared = createGenerationBudget(limit); let active = 0;
  return { reserve() { const release = shared.reserve(); active++; let released = false; return () => { if (!released) { released = true; active--; release(); } }; }, get active() { return active; } };
}
async function fixture(t, transport = async () => success(), budget) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "audio-service-")), calls = [], configs = [], services = [];
  const request = async value => { calls.push(value); return transport(value); };
  const newSettings = () => { const settings = createMediaProviderSettings({ getDataPath: () => root, request }); configs.push(settings); return settings; };
  const settings = newSettings(); await settings.save({ expectedRevision: 0, profiles: [profile, imageProfile], defaults });
  const create = (config = settings, factory = createAudioGeneration) => { const service = factory({ getDataPath: () => root, settings: config, request, budget }); services.push(service); return service; };
  t.after(async () => { await Promise.all(services.map(s => s.dispose())); await Promise.all(configs.map(s => s.dispose())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, settings, newSettings, calls, create, service: create() };
}
test("public prepare → submitAndWait → list/get/read → restart preserves audio and private provenance", async t => {
  const f = await fixture(t), spec = input(), source = { version: 1, sessionHash: "a".repeat(64), turnHash: "b".repeat(64), requestKeyHash: "c".repeat(64), inputHash: "d".repeat(64), modelRef: "media:speech:speech-2.8-hd", explicitModel: true };
  const prepared = await f.service.prepare(spec, source); assert.equal(prepared.kind, "audio"); assert.equal(prepared.state, "prepared"); assert.equal(f.calls.length, 0);
  assert.equal(prepared.request.format, "mp3"); assert.equal(prepared.request.speed, 1); assert.equal(prepared.request.outputCount, 1);
  assert.deepEqual(await f.service.prepare(spec, source), prepared);
  await assert.rejects(f.service.prepare(spec, { ...source, sessionHash: "e".repeat(64) }), { code: "GENERATION_REQUEST_CONFLICT" });
  const final = await f.service.submitAndWait(submit(prepared)); assert.equal(final.state, "succeeded");
  assert.equal(final.result.durationMs, 288); assert.equal(final.result.sampleRate, 32000); assert.equal(final.result.byteLength, validMp3().length);
  const sent = f.calls[0]; assert.equal(sent.url, profile.baseUrl + "/t2a_v2"); assert.equal(sent.timeoutMs, AUDIO_REQUEST_TIMEOUT_MS); assert.equal(sent.redirect, "error");
  assert.equal(sent.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(sent.body), { model: spec.modelId, text: spec.text, stream: false, output_format: "hex", voice_setting: { voice_id: spec.voiceId, speed: 1, vol: 1, pitch: 0 }, audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 } });
  assert.deepEqual((await f.service.agentRecord(final.id)).source, source); assert.equal((await f.service.agentRecords()).length, 1);
  assert.deepEqual((await f.service.resultBytes(final.id)).bytes, validMp3());
  await f.service.dispose(); const restarted = f.create(f.newSettings());
  assert.deepEqual(await restarted.get({ jobId: final.id }), final);
  assert.deepEqual(await restarted.submitAndWait(submit(prepared)), final); assert.equal(f.calls.length, 1);
  const listed = await restarted.list(); assert.equal(listed.limit, 200); assert.equal(listed.jobs[0].request.text, undefined);
  const part = await restarted.readResult({ jobId: final.id, expectedSha256: final.result.sha256, offset: 0 });
  assert.equal(part.mimeType, "audio/mpeg"); assert.equal(part.eof, true); assert.deepEqual(Buffer.from(part.base64, "base64"), validMp3());
  for (const value of [prepared, final, listed]) { const json = JSON.stringify(value); assert.ok(!json.includes(secret) && !json.includes(f.root)); assert.equal(value.agentRequest, undefined); assert.equal(value.version, undefined); }
  const disk = JSON.parse(await fs.readFile(path.join(f.root, "audio-jobs", final.id + ".json"), "utf8")); assert.equal(disk.version, 2); assert.deepEqual(disk.agentRequest, source);
  assert.ok(!JSON.stringify(disk).includes(secret));
});
test("only supported speech models and strictly bounded public parameters prepare", async t => {
  const f = await fixture(t);
  assert.equal(SUPPORTED_AUDIO_MODEL_IDS.length, 8); assert.equal(isSupportedAudioModel("speech-99"), false); assert.equal(isSupportedAudioModel(null), false);
  for (const modelId of SUPPORTED_AUDIO_MODEL_IDS) assert.equal((await f.service.prepare({ ...input(), modelId })).request.modelId, modelId);
  for (const patch of [{ modelId: "speech-99" }, { profileId: "gpt" }, { operation: "sound-effect" }, { text: "" }, { text: "x".repeat(1001) }, { text: "bad\ud800" }, { text: "a\u0000b" }, { text: "Bearer fixture" }, { text: secret }, { voiceId: "" }, { voiceId: "x".repeat(129) }, { voiceId: "bad\nvoice" }, { voiceId: "bad\ud800" }, { voiceId: secret }, { voiceId: "api_key=value" }, { speed: 0.49 }, { speed: 2.01 }, { speed: NaN }, { speed: "1" }, { speed: null }, { format: "wav" }, { outputCount: 1 }]) await assert.rejects(f.service.prepare({ ...input(), ...patch }));
  assert.equal(prepareInput({ ...input(), text: "😀".repeat(1000), voiceId: "v".repeat(128), speed: 0.5 }).request.speed, 0.5);
  assert.equal(prepareInput({ ...input(), speed: 2 }).request.speed, 2);
  const spec = input(), job = await f.service.prepare(spec);
  await assert.rejects(f.service.prepare({ ...spec, text: "different" }), { code: "GENERATION_REQUEST_CONFLICT" });
  await assert.rejects(f.service.submit({ ...submit(job), confirm: false }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.service.submit({ ...submit(job), requestHash: "0".repeat(64) }), { code: "GENERATION_REQUEST_CONFLICT" });
  assert.equal(f.calls.length, 0);
});
test("vendor rejection, unknown acceptance, HTTP, hex, URL and transport errors stay safe", async () => {
  const cases = [
    ...[[1004, "AUTHENTICATION_REQUIRED"], [1002, "RATE_LIMITED"], [1039, "RATE_LIMITED"], [1042, "INVALID_ARGUMENT"], [2013, "INVALID_ARGUMENT"]].map(([code, safe]) => [response({ base_resp: { status_code: code, status_msg: secret } }), "failed", safe]),
    ...[1000, 1001, 9999, "0", null, undefined].map(code => [response({ base_resp: { status_code: code }, data: { status: 2, audio: validMp3().toString("hex") } }), "unknown", "GENERATION_UNKNOWN"]),
    [response({ base_resp: { status_code: 0 }, data: { status: 1 } }), "unknown", "GENERATION_UNKNOWN"],
    [{ status: 200, bodyText: "{" + secret }, "unknown", "GENERATION_UNKNOWN"],
    ...[[401, "failed", "AUTHENTICATION_REQUIRED"], [403, "failed", "AUTHENTICATION_REQUIRED"], [404, "failed", "ENDPOINT_NOT_FOUND"], [429, "failed", "HTTP_ERROR"], [408, "unknown", "HTTP_ERROR"], [500, "unknown", "HTTP_ERROR"], [302, "unknown", "REDIRECT_DISALLOWED"]].map(([status, state, code]) => [response({ error: secret }, status), state, code]),
    ...["", "0", "ffz0", " ff00", validMp3().toString("hex").toUpperCase(), "https://example.invalid/" + secret, Buffer.from(secret).toString("hex"), validMp3().subarray(0, -1).toString("hex")].map(audio => [response({ base_resp: { status_code: 0 }, data: { status: 2, audio } }), "result-pending", "RESULT_INVALID"]),
    [response({ base_resp: { status_code: 0 }, data: { status: 2, audio_url: "https://example.invalid/" + secret } }), "result-pending", "RESULT_UNAVAILABLE"],
    [{ status: 200, bodyText: "x".repeat(16 * 1024 * 1024 * 2 + 256 * 1024 + 1) }, "result-pending", "RESPONSE_TOO_LARGE"],
  ];
  for (const [reply, state, code] of cases) {
    let calls = 0;
    const result = await generateMinimaxSpeech({ profile, secret, input: prepareInput(input()).request, checkCurrent() {}, request: async () => { calls++; return reply; } });
    assert.equal(result.state, state); assert.equal(result.error.code, code); assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes(secret));
  }
});
test("timeout, invocation abort and host rejection persist and never resubmit on restart", async t => {
  for (const [code, state, safe] of [["TIMEOUT", "unknown", "TIMEOUT"], ["PLUGIN_TOOL_ABORTED", "unknown", "TOOL_ABORTED"], ["EPIPE", "unknown", "NETWORK_ERROR"], ["PERMISSION_DENIED", "failed", "PERMISSION_DENIED"]]) {
    const budget = trackedBudget(), f = await fixture(t, async () => { throw Object.assign(Error(secret), { code }); }, budget);
    const job = await f.service.prepare(input()), final = await f.service.submitAndWait(submit(job));
    assert.equal(final.state, state); assert.equal(final.error.code, safe); assert.equal(budget.active, 0);
    await f.service.dispose(); assert.equal((await f.create().submitAndWait(submit(job))).state, state); assert.equal(f.calls.length, 1);
  }
});
test("settings capture is detached and checks revisions, credentials and lifecycle before dispatch", async t => {
  const budget = trackedBudget(), f = await fixture(t, undefined, budget), job = await f.service.prepare(input());
  const selected = prepareInput(input()).request;
  const pending = f.settings.withAudioProfile(selected, captured => captured); selected.modelId = "unsupported";
  const captured = await pending; assert.equal(captured.secret, secret);
  await f.settings.save({ expectedRevision: 1, profiles: [{ ...profile, credentialUpdate: { action: "clear" } }, imageProfile], defaults });
  assert.throws(captured.checkCurrent, { code: "CONFLICT" });
  await assert.rejects(f.service.submit(submit(job)), { code: "CONFLICT" }); assert.equal(budget.active, 0);
  await assert.rejects(f.service.prepare({ ...input(), expectedRevision: 2 }), { code: "CREDENTIAL_REQUIRED" });
  await f.settings.save({ expectedRevision: 2, profiles: [{ ...profile, enabled: false }], defaults });
  await assert.rejects(f.service.prepare({ ...input(), expectedRevision: 3 }), { code: "DISABLED" });
  await f.settings.dispose(); await assert.rejects(f.service.prepare({ ...input(), expectedRevision: 3 }), { code: "DISPOSED" }); assert.equal(f.calls.length, 0);
});
test("paid responses finish across settings changes and graceful disposal", async t => {
  const entered = deferred(), gate = deferred(), budget = trackedBudget(); t.after(() => gate.resolve());
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return success(); }, budget);
  const job = await f.service.prepare(input()); await f.service.submit(submit(job)); await entered.promise;
  await f.settings.save({ expectedRevision: 1, profiles: [], defaults });
  let drained = false; const closing = f.service.dispose().then(() => { drained = true; });
  assert.equal(drained, false); assert.equal(budget.active, 1); await assert.rejects(f.service.prepare(input()), { code: "DISPOSED" });
  gate.resolve(); await closing; assert.equal(budget.active, 0);
  assert.equal((await f.create().get({ jobId: job.id })).state, "succeeded"); assert.equal(f.calls.length, 1);
});
test("image and audio share two active reservations until responses are persisted", async t => {
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()], budget = trackedBudget(); t.after(() => gates.forEach(g => g.resolve()));
  let index = 0;
  const f = await fixture(t, async sent => { const i = index++; if (i < 2) { entered[i].resolve(); await gates[i].promise; } return sent.url.endsWith("t2a_v2") ? success() : response({ data: [{ b64_json: png().toString("base64") }] }); }, budget);
  const image = f.create(f.settings, createImageGeneration), a = await f.service.prepare(input()), b = await f.service.prepare(input());
  const img = await image.prepare({ requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2", prompt: "Synthetic test" });
  const waiting = f.service.submitAndWait(submit(a)); await entered[0].promise;
  const imageWaiting = image.submitAndWait(submit(img)); await entered[1].promise; assert.equal(budget.active, 2);
  await assert.rejects(f.service.submit(submit(b)), { code: "GENERATION_BUSY" });
  assert.equal((await f.service.get({ jobId: b.id })).state, "prepared");
  assert.equal((await f.service.submit(submit(a))).state, "submitting"); assert.equal(budget.active, 2);
  gates[0].resolve(); assert.equal((await waiting).state, "succeeded"); assert.equal(budget.active, 1);
  assert.equal((await f.service.submitAndWait(submit(b))).state, "succeeded");
  gates[1].resolve(); assert.equal((await imageWaiting).state, "succeeded"); assert.equal(budget.active, 0); assert.equal(f.calls.length, 3);
});
test("parallel instances release the losing claim reservation and dispatch only once", async t => {
  const captured = deferred(), gate = deferred(), entered = deferred(), budget = trackedBudget(); t.after(() => { gate.resolve(); captured.resolve(); });
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return success(); }, budget), other = f.create();
  const job = await f.service.prepare(input()), original = f.settings.withAudioProfile; let captures = 0;
  f.settings.withAudioProfile = (value, work) => original(value, async state => { if (++captures === 2) captured.resolve(); await captured.promise; return work(state); });
  const submitted = await Promise.all([f.service.submit(submit(job)), other.submit(submit(job))]); await entered.promise;
  assert.equal(f.calls.length, 1); assert.equal(budget.active, 1); assert.ok(submitted.every(j => ["submitting", "unknown"].includes(j.state)));
  gate.resolve(); await Promise.all([f.service.dispose(), other.dispose()]); assert.equal(budget.active, 0);
  assert.equal((await f.create().get({ jobId: job.id })).state, "succeeded");
});
test("cancellation before claim and before dispatch never calls the provider or leaks a reservation", async t => {
  const budget = trackedBudget(), f = await fixture(t, undefined, budget), job = await f.service.prepare(input());
  let cancelled = false;
  const aborted = () => { if (cancelled) throw Object.assign(Error("cancelled"), { code: "TOOL_ABORTED" }); };
  const originalProfile = f.settings.withAudioProfile;
  f.settings.withAudioProfile = (value, work) => originalProfile(value, state => { cancelled = true; return work(state); });
  await assert.rejects(f.service.submit(submit(job), aborted), { code: "TOOL_ABORTED" }); assert.equal(budget.active, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.service.get({ jobId: job.id })).state, "prepared");
  f.settings.withAudioProfile = originalProfile; cancelled = false;
  const originalRename = fs.rename;
  t.mock.method(fs, "rename", async (from, to) => {
    const result = await originalRename(from, to);
    if (to === path.join(f.root, "audio-jobs", job.id + ".json")) {
      const saved = JSON.parse(await fs.readFile(to, "utf8"));
      if (saved.state === "submitting") cancelled = true;
    }
    return result;
  });
  const final = await f.service.submitAndWait(submit(job), aborted);
  assert.equal(final.state, "failed"); assert.equal(final.error.code, "TOOL_ABORTED"); assert.equal(final.charging, "not-submitted");
  assert.equal(budget.active, 0); await f.service.submit(submit(job)); assert.equal(f.calls.length, 0);
});
test("disposal while profile capture is pending releases a reservation without a claim", async t => {
  const captured = deferred(), gate = deferred(), budget = trackedBudget(); t.after(() => gate.resolve());
  const f = await fixture(t, undefined, budget), job = await f.service.prepare(input()), original = f.settings.withAudioProfile;
  f.settings.withAudioProfile = (value, work) => original(value, async state => { captured.resolve(); await gate.promise; return work(state); });
  const pending = f.service.submit(submit(job)); const rejection = assert.rejects(pending, { code: "DISPOSED" }); await captured.promise;
  assert.equal(budget.active, 1); const closing = f.service.dispose(); gate.resolve(); await rejection; await closing;
  assert.equal(budget.active, 0); assert.equal(f.calls.length, 0);
  assert.equal((await f.create().get({ jobId: job.id })).state, "prepared");
});
test("budget reservations are synchronous, bounded and release idempotently", () => {
  for (const limit of [0, -1, 1.2, Infinity]) assert.throws(() => createGenerationBudget(limit), { code: "INVALID_ARGUMENT" });
  const budget = createGenerationBudget(1), release = budget.reserve(); assert.equal(typeof release, "function");
  assert.throws(() => budget.reserve(), { code: "GENERATION_BUSY" }); release(); release();
  const next = budget.reserve(); assert.throws(() => budget.reserve(), { code: "GENERATION_BUSY" }); next();
});
