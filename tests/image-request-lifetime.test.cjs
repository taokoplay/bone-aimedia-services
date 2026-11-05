"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createPlugin } = require("../main.js");
const { testSecrets } = require("./settings-service-fixture.cjs");
const { png } = require("./image-fixture.cjs");
const { generateGptImage } = require("../lib/gpt-image-adapter.js");
const turn = { sessionId: "lifetime-session", turnId: "lifetime-turn", mode: "agent" };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "image-lifetime-"));
  const context = new AsyncLocalStorage(), tools = new Map(), entered = deferred();
  let requests = 0, deadline, finishNetwork;
  const host = {
    plugin: { getDataPath: async () => root, getManifest: async () => ({ version: "test" }) },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) },
    net: { fetch: args => {
      requests++; deadline = args.timeoutMs;
      const invocation = context.getStore(); assert.ok(invocation, "Transport must execute under its Agent tool invocation");
      return new Promise((resolve, reject) => {
        invocation.reject = () => reject(Object.assign(Error("Private host message"), { code: "PLUGIN_TOOL_ABORTED" }));
        finishNetwork = () => { invocation.reject = null; resolve({ status: 200, headers: {}, bodyText: JSON.stringify({ data: [{ b64_json: png(8, 8).toString("base64") }] }) }); };
        entered.resolve();
      });
    } },
  };
  const plugin = createPlugin(host, () => testSecrets()); await plugin.onLoad();
  await plugin.onPanelInvoke("aimedia.save", { expectedRevision: 0, profiles: [{ id: "gpt", name: "Fixture", provider: "openai", models: [{ id: "gpt-image-2", kind: "image", name: "GPT" }], modelId: "gpt-image-2", credentialUpdate: { action: "replace", value: "fixture-secret" } }], defaults: { image: "gpt", audio: null, video: null } });
  t.after(async () => { finishNetwork?.(); await plugin.onUnload(); await fs.rm(root, { recursive: true, force: true }); });
  function call(name, input) {
    const invocation = { closed: false, reject: null };
    const promise = context.run(invocation, async () => {
      try { return await tools.get(name).execute(input, turn); }
      finally { invocation.closed = true; invocation.reject?.(); }
    });
    return { promise, invocation };
  }
  return { plugin, call, entered: entered.promise, finish: () => finishNetwork(), get requests() { return requests; }, get deadline() { return deadline; } };
}
async function storageRoundTrip(plugin, id) {
  // Real local API reads give the initiating invocation a chance to settle; no
  // arbitrary sleep or real provider delay is necessary at this test level.
  await plugin.onPanelInvoke("aimedia.image.list", {});
  return plugin.onPanelInvoke("aimedia.image.get", { jobId: id });
}
test("generate_image keeps the originating host API call alive even with waitMs=0", async t => {
  const f = await fixture(t);
  const run = f.call("generate_image", { requestKey: "slow-one", prompt: "A blue cup", waitMs: 0 });
  await f.entered;
  const jobs = await f.plugin.onPanelInvoke("aimedia.image.list", {}), id = jobs.jobs[0].id;
  await storageRoundTrip(f.plugin, id);
  assert.equal(run.invocation.closed, false, "Returning here would cancel the in-flight host network API");
  f.finish(); const reply = await run.promise;
  assert.equal(reply.structuredContent.job.state, "succeeded");
  assert.equal(reply.content[1].type, "image"); assert.equal(f.deadline, 90000);
  assert.equal((await storageRoundTrip(f.plugin, id)).state, "succeeded");
  await f.call("generate_image", { requestKey: "slow-one", prompt: "A blue cup", waitMs: 0 }).promise;
  assert.equal(f.requests, 1);
});
test("legacy submit_image also owns its network request until result persistence", async t => {
  const f = await fixture(t);
  const prepared = await f.call("prepare_image", { requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2", prompt: "Legacy cup", size: "1024x1024", quality: "low" }).promise;
  const input = { jobId: prepared.id, requestHash: prepared.requestHash, confirm: true };
  const run = f.call("submit_image", input); await f.entered;
  await storageRoundTrip(f.plugin, prepared.id);
  assert.equal(run.invocation.closed, false);
  f.finish(); const reply = await run.promise; assert.equal(reply.state, "succeeded");
  await f.call("submit_image", input).promise; assert.equal(f.requests, 1);
});
test("host invocation interruption remains unknown with an accurate safe code", async () => {
  const result = await generateGptImage({ profile: { baseUrl: "https://example.test/v1" }, secret: "fixture-secret", input: { modelId: "gpt-image-2", prompt: "cup", size: "1024x1024", quality: "low" }, checkCurrent() {},
    request: async () => { throw Object.assign(Error("Sensitive provider payload"), { code: "PLUGIN_TOOL_ABORTED" }); } });
  assert.deepEqual(result, { state: "unknown", error: { code: "TOOL_ABORTED" }, charging: "unknown" });
  assert.ok(!JSON.stringify(result).includes("Sensitive"));
});
