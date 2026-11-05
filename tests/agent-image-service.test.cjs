"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const { createImageGeneration } = require("../lib/image-generation.js");
const { createAgentImageService } = require("../lib/agent-image-service.js");
const { createAgentImageTools } = require("../tools/agent-images.js");
const { modelRef } = require("../lib/media-model-catalog.js");
const { png } = require("./image-fixture.cjs");
const ctx = (extra = {}) => ({ sessionId: "session-a", turnId: "turn-a", mode: "agent", ...extra });
const input = extra => ({ requestKey: "blue-cup-1", prompt: "A blue cup on a white table", quality: "low", waitMs: 1000, ...extra });
const profile = (id, extra = {}) => ({ id, provider: "openai", name: id, models: [{ id: "gpt-image-2", name: "GPT Image 2", kind: "image" }], credentialUpdate: { action: "replace", value: "synthetic-agent-key" }, ...extra });
const defaults = { image: null, video: null, audio: null };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, transport = async () => ({ status: 200, bodyText: JSON.stringify({ data: [{ b64_json: png(4, 4).toString("base64") }] }) })) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "agent-media-"));
  const calls = [], instances = [];
  const request = async args => { calls.push(args); return transport(args); };
  const settings = createMediaProviderSettings({ getDataPath: () => root, request });
  await settings.save({ expectedRevision: 0, profiles: [profile("gpt")], defaults });
  const create = () => {
    const images = createImageGeneration({ getDataPath: () => root, settings, request });
    const agent = createAgentImageService({ settings, images });
    const tools = new Map(createAgentImageTools({ access: (method, args, context) => agent[method](args, context) }).map(tool => [tool.name, tool]));
    const call = (name, args, context = ctx()) => tools.get(name).execute(args, context);
    const instance = { images, agent, tools, call, dispose: async () => { agent.dispose(); await images.dispose(); } }; instances.push(instance); return instance;
  };
  t.after(async () => { await Promise.all(instances.map(i => i.dispose())); await settings.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, settings, create, calls, ...create() };
}
const data = reply => reply.structuredContent;
test("Agent catalog→single-call generation→image content→restart works without a panel", async t => {
  const f = await fixture(t);
  const catalog = data(await f.call("media_catalog", { action: "list", kind: "image" }));
  assert.equal(catalog.models[0].modelRef, modelRef("gpt", "gpt-image-2")); assert.equal(f.calls.length, 0);
  const result = await f.call("generate_image", input());
  assert.equal(data(result).job.state, "succeeded");
  assert.deepEqual(Buffer.from(result.content[1].data, "base64"), png(4, 4));
  assert.equal(result.content[1].type, "image"); assert.ok(!result.content[0].text.includes(result.content[1].data));
  const id = data(result).job.id;
  assert.equal(data(await f.call("image_job", { action: "list" })).jobs[0].request.prompt, undefined);
  await f.dispose(); const next = f.create();
  const repeated = await next.call("generate_image", input({ waitMs: 0 }), ctx({ turnId: "turn-b" }));
  assert.equal(data(repeated).job.id, id); assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(data(repeated)).includes("sessionHash")); assert.ok(!JSON.stringify(data(repeated)).includes("synthetic-agent-key"));
});
test("retries retain the original model after settings change; changed intent with same key conflicts", async t => {
  const f = await fixture(t), first = data(await f.call("generate_image", input()));
  await f.settings.save({ expectedRevision: 1, profiles: [profile("other")], defaults: { ...defaults, image: "other" } });
  assert.equal(data(await f.call("generate_image", input())).job.id, first.job.id);
  const changed = data(await f.call("generate_image", input({ prompt: "Different prompt" })));
  assert.equal(changed.error.code, "GENERATION_REQUEST_CONFLICT"); assert.equal(f.calls.length, 1);
});
test("multiple models ask once; explicit selection persists per session without changing defaults", async t => {
  const f = await fixture(t);
  await f.settings.save({ expectedRevision: 1, profiles: [profile("gpt"), profile("other")], defaults });
  const ambiguous = data(await f.call("generate_image", input()));
  assert.equal(ambiguous.selection.status, "selection-required"); assert.equal(f.calls.length, 0);
  const chosen = await f.call("generate_image", input({ modelRef: modelRef("other", "gpt-image-2") }));
  assert.equal(data(chosen).job.request.profileId, "other");
  await f.dispose(); const next = f.create();
  const followup = data(await next.call("generate_image", input({ requestKey: "blue-cup-2" }), ctx({ turnId: "turn-b" })));
  assert.equal(followup.job.request.profileId, "other"); assert.deepEqual((await f.settings.read()).defaults, defaults);
  const anotherSession = data(await next.call("generate_image", input(), ctx({ sessionId: "session-b" })));
  assert.equal(anotherSession.selection.status, "selection-required");
});
test("invalid explicit reference never silently switches to a configured model", async t => {
  const f = await fixture(t), result = data(await f.call("generate_image", input({ modelRef: modelRef("missing", "gpt-image-2") })));
  assert.equal(result.selection.status, "unavailable"); assert.equal(f.calls.length, 0);
});
test("trusted context, mode and action boundaries deny writes and cross-session job access", async t => {
  const f = await fixture(t);
  for (const context of [undefined, {}, ctx({ turnId: "" }), ctx({ mode: "plan" }), ctx({ mode: "goal" })]) {
    const result = await f.tools.get("generate_image").execute(input(), context); assert.equal(data(result).ok, false);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(data(await f.call("media_catalog", { action: "list" }, ctx({ mode: "plan" }))).ok, true);
  const result = data(await f.call("generate_image", input()));
  assert.equal(data(await f.call("image_job", { action: "result", jobId: result.job.id }, ctx({ sessionId: "other" }))).error.code, "NOT_FOUND");
  assert.equal(data(await f.call("image_job", { action: "list" }, ctx({ sessionId: "other" }))).jobs.length, 0);
  assert.equal(data(await f.call("generate_image", { ...input(), sessionId: "fake" })).error.code, "INVALID_ARGUMENT");
  assert.deepEqual(f.tools.get("media_catalog").planSafeActions, ["list"]);
  assert.equal(f.tools.get("generate_image").planSafeActions, undefined);
  assert.equal(f.tools.get("export_image_result").planSafeActions, undefined);
});
test("parallel callers and instances share a durable single submission", async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return { status: 200, bodyText: JSON.stringify({ data: [{ b64_json: png().toString("base64") }] }) }; });
  const next = f.create();
  const pending = Promise.all([f.call("generate_image", input({ waitMs: 0 })), next.call("generate_image", input({ waitMs: 0 }))]);
  await entered.promise; assert.equal(f.calls.length, 1); gate.resolve();
  const results = await pending; assert.equal(data(results[0]).job.id, data(results[1]).job.id);
});
test("cancelled invocation does not resubmit the paid request", async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return { status: 200, bodyText: JSON.stringify({ data: [{ b64_json: png().toString("base64") }] }) }; });
  const controller = new AbortController();
  const running = f.call("generate_image", input({ waitMs: 10000 }), ctx({ signal: controller.signal }));
  await entered.promise; controller.abort();
  gate.resolve(); assert.equal(data(await running).error.code, "TOOL_ABORTED");
  const final = data(await f.call("generate_image", input())); assert.equal(final.job.state, "succeeded"); assert.equal(f.calls.length, 1);
});
test("provider timeout stays unknown, finite waits are bounded, no retries", async t => {
  const f = await fixture(t, async () => { throw Object.assign(Error("synthetic-agent-key"), { code: "TIMEOUT" }); });
  const first = data(await f.call("generate_image", input())); assert.equal(first.job.state, "unknown");
  const again = data(await f.call("generate_image", input())); assert.equal(again.job.id, first.job.id); assert.equal(f.calls.length, 1);
  assert.equal(data(await f.call("image_job", { action: "wait", jobId: first.job.id, waitMs: 15001 })).error.code, "INVALID_ARGUMENT");
  assert.equal(data(await f.call("image_job", { action: "get", jobId: first.job.id, waitMs: 1 })).error.code, "INVALID_ARGUMENT");
});
test("legacy image jobs remain readable and new source metadata is never exposed", async t => {
  const f = await fixture(t), { randomUUID } = require("node:crypto");
  const legacy = await f.images.prepare({ requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2", prompt: "Legacy prompt" });
  assert.equal((await f.images.get({ jobId: legacy.id })).state, "prepared");
  assert.equal(data(await f.call("image_job", { action: "get", jobId: legacy.id })).error.code, "NOT_FOUND");
  const current = data(await f.call("generate_image", input()));
  const publicJob = await f.images.get({ jobId: current.job.id }); assert.equal(publicJob.agentRequest, undefined);
  const persisted = JSON.parse(await fs.readFile(path.join(f.root, "image-jobs", current.job.id + ".json"), "utf8"));
  assert.equal(persisted.version, 2); assert.equal(persisted.agentRequest.version, 1);
  assert.ok(!JSON.stringify(persisted).includes("session-a"));
});

test("cancellation during storage lookup prevents a not-yet-dispatched request", async t => {
  const f = await fixture(t), { randomUUID } = require("node:crypto");
  const prepared = await f.images.prepare({ requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2", prompt: "Cancelled before submission" });
  const gate = deferred(), entered = deferred(), controller = new AbortController(); let hold = true;
  const delayed = createImageGeneration({ getDataPath: async () => { if (hold) { hold = false; entered.resolve(); await gate.promise; } return f.root; }, settings: f.settings,
    request: async args => { f.calls.push(args); return { status: 400, bodyText: "{}" }; } });
  t.after(() => delayed.dispose());
  const running = delayed.submit({ jobId: prepared.id, requestHash: prepared.requestHash, confirm: true }, () => { if (controller.signal.aborted) throw Object.assign(Error("Cancelled"), { code: "TOOL_ABORTED" }); });
  const rejection = assert.rejects(running, { code: "TOOL_ABORTED" });
  await entered.promise; controller.abort(); gate.resolve(); await rejection;
  assert.equal(f.calls.length, 0); assert.equal((await f.images.get({ jobId: prepared.id })).state, "prepared");
});

test("Agent disposal aborts export before further host writes", async t => {
  const f = await fixture(t), result = data(await f.call("generate_image", input()));
  const { createImageResultExporter } = require("../lib/image-result-export.js");
  const gate = deferred(), entered = deferred(); let writes = 0;
  const host = { workspace: { get: async () => ({ path: f.root }) }, fs: {
    stat: async () => { entered.resolve(); await gate.promise; throw Object.assign(Error("Absent"), { code: "NOT_FOUND" }); },
    readText: async () => "", writeText: async () => { writes++; },
  } };
  const exporter = createImageResultExporter({ host, readResult: f.images.resultBytes });
  const agent = createAgentImageService({ settings: f.settings, images: f.images, exporter });
  const pending = agent.exportResult({ jobId: result.job.id }, ctx());
  const rejection = assert.rejects(pending, error => ["ABORTED", "DISPOSED"].includes(error.code));
  await entered.promise; agent.dispose(); gate.resolve(); await rejection; assert.equal(writes, 0);
});

test("tool errors retain sanitized partial-export recovery information", async t => {
  const f = await fixture(t), result = data(await f.call("generate_image", input()));
  const { createImageResultExporter } = require("../lib/image-result-export.js");
  const written = new Map(); let writes = 0;
  const host = { workspace: { get: async () => ({ path: f.root }) }, fs: {
    stat: async file => { if (!written.has(file)) throw Object.assign(Error("Absent"), { code: "NOT_FOUND" }); return { size: Buffer.byteLength(written.get(file)) }; },
    readText: async file => written.get(file), writeText: async (file, value) => { if (++writes === 2) throw Error("Private raw error"); written.set(file, value); },
  } };
  const exporter = createImageResultExporter({ host, readResult: f.images.resultBytes });
  const agent = createAgentImageService({ settings: f.settings, images: f.images, exporter }); t.after(() => agent.dispose());
  const tool = createAgentImageTools({ access: (method, args, context) => agent[method](args, context) }).find(tool => tool.name === "export_image_result");
  const failure = data(await tool.execute({ jobId: result.job.id }, ctx()));
  assert.equal(failure.ok, false); assert.equal(failure.error.code, "EXPORT_FAILED"); assert.equal(failure.recovery.status, "incomplete");
  assert.ok(failure.recovery.handoffPath.startsWith("bone-media/exports/")); assert.equal(written.size, 1);
  assert.ok(!JSON.stringify(failure).includes("Private raw error") && !JSON.stringify(failure).includes("base64"));
});

test("fresh host data directory mode 0755 permits Agent discovery before first preparation", async t => {
  const f = await fixture(t); await fs.chmod(f.root, 0o755);
  assert.equal(data(await f.call("media_catalog", { action: "list" })).ok, true);
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o755);
  const result = data(await f.call("generate_image", input()));
  assert.equal(result.job?.state, "succeeded", JSON.stringify(result)); assert.equal(f.calls.length, 1);
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o700);
});
