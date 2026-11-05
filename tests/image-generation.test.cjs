"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { createImageGeneration } = require("../lib/image-generation.js");
const { createMediaProviderSettings, testSecrets } = require("./settings-service-fixture.cjs");
const { createPlugin } = require("../main.js");
const { png } = require("./image-fixture.cjs");
const secret = "fixture-image-auth-only", defaults = { image: null, video: null, audio: null };
const profile = { id: "gpt", provider: "openai", name: "GPT fixture", baseUrl: "http://127.0.0.1:12345/v1", models: [{ id: "gpt-image-2", kind: "image", name: "GPT Image 2" }], credentialUpdate: { action: "replace", value: secret } };
const input = () => ({ requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2", prompt: "A blue ceramic cup on a white table.", size: "1024x1024", quality: "low" });
const submit = job => ({ jobId: job.id, requestHash: job.requestHash, confirm: true });
const response = (body, status = 200) => ({ status, headers: {}, bodyText: JSON.stringify(body) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, transport = async () => response({ data: [{ b64_json: png().toString("base64") }] })) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "image-service-"));
  const calls = [], services = [], configs = [];
  const request = async value => { calls.push(value); return transport(value); };
  const newSettings = () => { const settings = createMediaProviderSettings({ getDataPath: () => root, request }); configs.push(settings); return settings; };
  const settings = newSettings(); await settings.save({ expectedRevision: 0, profiles: [profile], defaults });
  const create = (config = settings) => { const service = createImageGeneration({ getDataPath: () => root, settings: config, request }); services.push(service); return service; };
  t.after(async () => { await Promise.all(services.map(s => s.dispose())); await Promise.all(configs.map(s => s.dispose())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, settings, newSettings, calls, create, service: create() };
}
async function settled(service, id) {
  const deadline = Date.now() + 5000;
  for (;;) { const job = await service.get({ jobId: id }); if (job.state !== "submitting") return job; assert.ok(Date.now() < deadline, "Test job did not settle"); await new Promise(resolve => setImmediate(resolve)); }
}

test("prepare→submit→PNG→restart→chunk read executes one authenticated request and protects private data", async t => {
  const f = await fixture(t), spec = input();
  const prepared = await f.service.prepare(spec); assert.equal(prepared.state, "prepared"); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.service.prepare(spec), prepared);
  assert.equal((await f.service.submit(submit(prepared))).state, "submitting");
  const final = await settled(f.service, prepared.id); assert.equal(final.state, "succeeded");
  const sent = f.calls[0]; assert.equal(sent.url, "http://127.0.0.1:12345/v1/images/generations");
  assert.equal(sent.headers.Authorization, `Bearer ${secret}`); assert.equal(sent.redirect, "error");
  assert.deepEqual(JSON.parse(sent.body), { model: "gpt-image-2", prompt: spec.prompt, n: 1, size: "1024x1024", quality: "low", output_format: "png" });
  await f.service.dispose(); const restarted = f.create(f.newSettings());
  assert.deepEqual(await restarted.get({ jobId: prepared.id }), final);
  assert.equal((await restarted.submit(submit(prepared))).state, "succeeded"); assert.equal(f.calls.length, 1);
  const part = await restarted.readResult({ jobId: final.id, expectedSha256: final.result.sha256, offset: 0 });
  assert.equal(part.eof, true); assert.deepEqual(Buffer.from(part.base64, "base64"), png());
  assert.equal(final.result.sha256, createHash("sha256").update(png()).digest("hex"));
  const listed = await restarted.list({}); assert.equal(listed.jobs[0].request.prompt, undefined);
  const json = JSON.stringify([prepared, final, listed]); assert.ok(!json.includes(secret) && !json.includes(f.root));
  const disk = await fs.readFile(path.join(f.root, "image-jobs", final.id + ".json"), "utf8"); assert.ok(!disk.includes(secret));
});

test("parallel instances claim the same paid request only once", async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return response({ data: [{ b64_json: png().toString("base64") }] }); });
  const other = f.create(), job = await f.service.prepare(input());
  const results = await Promise.all([f.service.submit(submit(job)), other.submit(submit(job)), f.service.submit(submit(job))]);
  await entered.promise; assert.equal(f.calls.length, 1); assert.ok(results.every(r => ["submitting", "unknown"].includes(r.state)));
  gate.resolve(); await settled(f.service, job.id); await settled(other, job.id);
  assert.equal(f.calls.length, 1);
});

test("input, hash, confirmation and changed configuration are rejected before dispatch", async t => {
  const f = await fixture(t), spec = input(), job = await f.service.prepare(spec);
  for (const patch of [{ modelId: "dall-e-3" }, { profileId: "missing" }, { expectedRevision: 0 }, { prompt: secret }, { prompt: "" }, { size: "4096x4096" }, { outputCount: 2 }]) await assert.rejects(f.service.prepare({ ...input(), ...patch }));
  await assert.rejects(f.service.prepare({ ...spec, prompt: "Changed" }), { code: "GENERATION_REQUEST_CONFLICT" });
  await assert.rejects(f.service.submit({ ...submit(job), confirm: false }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.service.submit({ ...submit(job), requestHash: "0".repeat(64) }), { code: "GENERATION_REQUEST_CONFLICT" });
  await f.settings.save({ expectedRevision: 1, profiles: [{ ...profile, credentialUpdate: { action: "clear" } }], defaults });
  await assert.rejects(f.service.submit(submit(job)), { code: "CONFLICT" }); assert.equal(f.calls.length, 0);
});

test("timeouts and disconnects stay unknown across restart and never resubmit", async t => {
  const f = await fixture(t, async () => { throw Object.assign(Error(secret), { code: "TIMEOUT" }); });
  const job = await f.service.prepare(input()); await f.service.submit(submit(job));
  const final = await settled(f.service, job.id); assert.equal(final.state, "unknown"); assert.equal(final.error.code, "TIMEOUT");
  assert.equal(final.charging, "unknown"); assert.ok(!JSON.stringify(final).includes(secret));
  await f.service.dispose(); await f.create().submit(submit(job)); assert.equal(f.calls.length, 1);
});

test("HTTP failures, URL-only results and corrupt images are classified without reflecting provider bodies", async t => {
  for (const [reply, state, code] of [
    [response({ error: secret }, 401), "failed", "AUTHENTICATION_REQUIRED"],
    [response({ error: secret }, 500), "unknown", "HTTP_ERROR"],
    [response({ data: [{ url: "https://foreign.example/image?token=" + secret }] }), "result-pending", "RESULT_UNAVAILABLE"],
    [response({ data: [{ b64_json: Buffer.from(secret).toString("base64") }] }), "result-pending", "RESULT_INVALID"],
    [response({ data: [{ b64_json: png().toString("base64") + "=" }] }), "result-pending", "RESULT_INVALID"],
  ]) {
    const f = await fixture(t, async () => reply), job = await f.service.prepare(input()); await f.service.submit(submit(job));
    const final = await settled(f.service, job.id); assert.equal(final.state, state); assert.equal(final.error.code, code);
    assert.ok(!JSON.stringify(final).includes(secret)); assert.equal(f.calls.length, 1);
    await f.service.submit(submit(job)); assert.equal(f.calls.length, 1);
  }
});

test("graceful disposal drains an already dispatched paid response before restart", async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return response({ data: [{ b64_json: png().toString("base64") }] }); });
  const job = await f.service.prepare(input()); await f.service.submit(submit(job)); await entered.promise;
  const disposing = f.service.dispose();
  await assert.rejects(f.service.prepare(input()), { code: "DISPOSED" });
  gate.resolve(); await disposing;
  const restarted = f.create();
  assert.equal((await restarted.submit(submit(job))).state, "succeeded"); assert.equal(f.calls.length, 1);
});

test("configuration edits after dispatch preserve an already paid result", async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return response({ data: [{ b64_json: png().toString("base64") }] }); });
  const job = await f.service.prepare(input()); await f.service.submit(submit(job)); await entered.promise;
  await f.settings.save({ expectedRevision: 1, profiles: [], defaults }); gate.resolve();
  assert.equal((await settled(f.service, job.id)).state, "succeeded");
});

test("result hash mismatch, corruption and invalid offsets cannot expose arbitrary files", async t => {
  const f = await fixture(t), job = await f.service.prepare(input()); await f.service.submit(submit(job));
  const final = await settled(f.service, job.id), args = { jobId: job.id, expectedSha256: final.result.sha256, offset: 0 };
  await assert.rejects(f.service.readResult({ ...args, expectedSha256: "0".repeat(64) }), { code: "RESULT_UNAVAILABLE" });
  for (const offset of [-1, 0.5, 1000000]) await assert.rejects(f.service.readResult({ ...args, offset }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.service.get({ jobId: "../../settings" }), { code: "INVALID_ARGUMENT" });
  await fs.writeFile(path.join(f.root, "image-jobs", job.id + ".png"), Buffer.from("tampered"));
  await assert.rejects(f.service.readResult(args), { code: "RESULT_INVALID" });
});

test("entry Agent tools and panel share the same generation lifecycle and safe errors", async t => {
  const f = await fixture(t), tools = new Map();
  const host = { plugin: { getDataPath: async () => f.root, getManifest: async () => ({ version: "0.3.0" }) }, commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) }, net: { fetch: async () => response({ data: [{ b64_json: png().toString("base64") }] }) } };
  const entry = createPlugin(host, () => testSecrets()); await entry.onLoad(); t.after(() => entry.onUnload());
  assert.equal(tools.size, 12); assert.equal(tools.get("submit_image").risk, "high");
  const job = await tools.get("prepare_image").execute(input());
  const sent = await entry.onPanelInvoke("aimedia.invoke", { channel: "aimedia.image.submit", payload: submit(job) }); assert.equal(sent.ok, true);
  const adapter = { get: input => tools.get("get_image_job").execute(input) };
  const final = await settled(adapter, job.id); assert.equal(final.state, "succeeded");
  assert.equal((await tools.get("list_image_jobs").execute({})).jobs.length, 1);
  const result = await tools.get("read_image_result").execute({ jobId: job.id, expectedSha256: final.result.sha256, offset: 0 }); assert.equal(result.eof, true);
  const rejected = await entry.onPanelInvoke("aimedia.invoke", { channel: "aimedia.image.prepare", payload: { ...input(), modelId: "unsupported" } });
  assert.deepEqual(rejected.error, { code: "GENERATION_UNSUPPORTED" });
  assert.equal((await tools.get("get_capabilities").execute({})).operations.find(op => op.id === "image.generate").ready, true);
});

test("restart recovers a committed PNG when the final task record was interrupted", async t => {
  const f = await fixture(t), job = await f.service.prepare(input()); await f.service.submit(submit(job));
  const final = await settled(f.service, job.id); await f.service.dispose();
  const file = path.join(f.root, "image-jobs", job.id + ".json");
  const saved = JSON.parse(await fs.readFile(file, "utf8")); delete saved.result; saved.state = "submitting"; saved.revision = 2;
  await fs.writeFile(file, JSON.stringify(saved));
  const restarted = f.create(), restored = await restarted.get({ jobId: job.id });
  assert.equal(restored.state, "succeeded"); assert.deepEqual(restored.result, final.result);
  assert.equal((await restarted.list({})).jobs[0].state, "succeeded");
  assert.equal((await restarted.readResult({ jobId: job.id, expectedSha256: final.result.sha256, offset: 0 })).eof, true);
  await restarted.submit(submit(job)); assert.equal(f.calls.length, 1);
});

test("interrupted dispatch without an image remains unknown and cannot resubmit", async t => {
  const f = await fixture(t), job = await f.service.prepare(input());
  const file = path.join(f.root, "image-jobs", job.id + ".json");
  const saved = JSON.parse(await fs.readFile(file, "utf8")); saved.state = "submitting"; saved.revision = 2; saved.charging = "unknown";
  await fs.writeFile(file, JSON.stringify(saved));
  await fs.writeFile(path.join(f.root, "image-jobs", job.id + ".submitted"), "image-job-submitted-v1\n", { mode: 0o600 });
  const restarted = f.create(); assert.equal((await restarted.get({ jobId: job.id })).state, "unknown");
  await restarted.submit(submit(job)); assert.equal(f.calls.length, 0);
});
