"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const defaults = { image: null, video: null, audio: null };
const profile = extra => ({ id: "comfy", provider: "comfyui", authKind: "none", ...extra });
const reply = value => ({ status: 200, bodyText: JSON.stringify(value) });
const definition = { "1": { class_type: "CLIPTextEncode", inputs: { text: "cached prompt" } } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function provider(input) {
  const route = new URL(input.url).pathname;
  if (route === "/models") return reply(["checkpoints", "loras", "vae"]);
  if (route.startsWith("/models/")) return reply(Array.from({ length: 70 }, (_, i) => `model-${i}.safetensors`));
  if (route === "/userdata") return reply(Array.from({ length: 120 }, (_, i) => ({ path: `flow-${i}.json`, size: 100, created: 123, modified: 456 })));
  if (route.startsWith("/userdata/")) return reply(definition);
  throw Error("Unexpected request");
}
async function fixture(t, handler = provider) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "resource-sync-"));
  const calls = [];
  const service = createMediaProviderSettings({ getDataPath: () => root, request: async input => { calls.push(input); return handler(input); } });
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const input = expectedRevision => ({ profileId: "comfy", expectedRevision });
  return { root, calls, service, input,
    save: (extra = {}, expectedRevision = 0) => service.save({ expectedRevision, profiles: [profile(extra)], defaults }),
    sync: (resource, expectedRevision = 1) => service.syncResources({ ...input(expectedRevision), resource }),
    read: (expectedRevision = 1) => service.resourceSnapshot(input(expectedRevision)),
    detail: (file = "flow-0.json", expectedRevision = 1) => service.readResourceWorkflow({ ...input(expectedRevision), path: file }) };
}

test("sync saves complete model/workflow catalogs and viewed JSON across restart without changing settings", async t => {
  const f = await fixture(t); await f.save();
  const before = await fs.readFile(path.join(f.root, "aimedia-settings.json"), "utf8");
  assert.deepEqual(await f.read(), { profileId: "comfy", revision: 1, models: null, workflows: null });
  assert.deepEqual(await fs.readdir(f.root), ["aimedia-settings.json"]);
  const models = await f.sync("models");
  assert.equal(models.models.folders.length, 3);
  assert.equal(models.models.folders[0].items.length, 70);
  assert.equal(f.calls.length, 4);
  const workflows = await f.sync("workflows");
  assert.equal(workflows.workflows.items.length, 120);
  assert.deepEqual((await f.detail()).definition, definition);
  assert.equal((await f.service.read()).workflows.length, 0);
  assert.equal(await fs.readFile(path.join(f.root, "aimedia-settings.json"), "utf8"), before);
  assert(f.calls.every(c => c.method === "GET" && c.redirect === "error" && c.body === undefined));
  await f.service.dispose();
  const restarted = createMediaProviderSettings({ getDataPath: () => f.root, request: async () => { throw Error("Offline: no network expected"); } });
  t.after(() => restarted.dispose());
  const restored = await restarted.resourceSnapshot(f.input(1));
  assert.deepEqual(restored, workflows);
  const cached = await restarted.readResourceWorkflow({ ...f.input(1), path: "flow-0.json" });
  assert.deepEqual(cached.definition, definition);
  restored.models.folders[0].items.length = 0;
  assert.equal((await restarted.resourceSnapshot(f.input(1))).models.folders[0].items.length, 70);
});

test("partial/failed synchronization retains both last-success catalogs and timestamps", async t => {
  let failed = false;
  const f = await fixture(t, input => failed && input.url.endsWith("/models/loras") ? { status: 503, bodyText: "private failure" } : provider(input));
  await f.save(); await f.sync("models"); await f.sync("workflows");
  const before = await f.read();
  const disk = await fs.readFile(path.join(f.root, "aimedia-resource-snapshots.json"), "utf8");
  failed = true;
  await assert.rejects(f.sync("models"), { code: "SYNC_FAILED" });
  assert.deepEqual(await f.read(), before);
  assert.equal(await fs.readFile(path.join(f.root, "aimedia-resource-snapshots.json"), "utf8"), disk);
});

test("rename preserves cache; endpoint, user, credential or deletion invalidates it", async t => {
  const f = await fixture(t); await f.save(); const original = await f.sync("models");
  await f.save({ name: "Renamed" }, 1);
  assert.deepEqual((await f.read(2)).models, original.models);
  await f.save({ baseUrl: "http://localhost:8190" }, 2);
  assert.equal((await f.read(3)).models, null);
  await f.save({}, 3);
  assert.equal((await f.read(4)).models, null);
  await f.sync("models", 4);
  await f.save({ comfyUser: "another-user" }, 4);
  assert.equal((await f.read(5)).models, null);
  await f.sync("models", 5);
  await f.save({ authKind: "bearer", credentialUpdate: { action: "replace", value: "fixture-secret-alpha" } }, 5);
  assert.equal((await f.read(6)).models, null);
  await f.sync("models", 6);
  await f.save({ authKind: "bearer", credentialUpdate: { action: "replace", value: "fixture-secret-beta" } }, 6);
  assert.equal((await f.read(7)).models, null);
  await f.sync("models", 7);
  const disk = await fs.readFile(path.join(f.root, "aimedia-resource-snapshots.json"), "utf8");
  assert(!disk.includes("fixture-secret"));
  await f.service.save({ expectedRevision: 7, profiles: [], defaults });
  await f.save({}, 8);
  assert.equal((await f.read(9)).models, null);
});

test("sync deduplicates per connection and cannot commit after configuration changes or disposal", async t => {
  for (const dispose of [false, true]) {
    const started = deferred(), release = deferred();
    const f = await fixture(t, async () => { started.resolve(); return release.promise; });
    await f.save();
    const running = f.sync("workflows"); await started.promise;
    await assert.rejects(f.sync("models"), { code: "PROBE_PENDING" });
    await assert.rejects(f.service.probe(f.input(1)), { code: "PROBE_PENDING" });
    if (dispose) await f.service.dispose(); else await f.save({ baseUrl: "http://localhost:8190" }, 1);
    release.resolve(reply([{ path: "late.json", size: 10, created: 1, modified: 1 }]));
    await assert.rejects(running, { code: "CONFLICT" });
    await assert.rejects(fs.stat(path.join(f.root, "aimedia-resource-snapshots.json")), { code: "ENOENT" });
  }
});

test("successful workflow resync invalidates cached bodies; unseen workflow paths never fetch", async t => {
  const f = await fixture(t); await f.save();
  await assert.rejects(f.detail(), { code: "NOT_FOUND" });
  assert.equal(f.calls.length, 0);
  await f.sync("workflows"); await f.detail(); const before = f.calls.length;
  await f.detail(); assert.equal(f.calls.length, before);
  await f.sync("workflows"); await f.detail(); assert.equal(f.calls.length, before + 2);
  await assert.rejects(f.detail("unlisted.json"), { code: "NOT_FOUND" });
  await assert.rejects(f.detail("../private.json"), { code: "INVALID_ARGUMENT" });
});

test("snapshot routes reject stale revisions, non-Comfy profiles and unknown fields before network", async t => {
  const f = await fixture(t); await f.save();
  await assert.rejects(f.read(0), { code: "CONFLICT" });
  await assert.rejects(f.sync("queue"), { code: "INVALID_ARGUMENT" });
  assert.throws(() => f.service.resourceSnapshot({ ...f.input(1), url: "http://invalid.test" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(f.sync("models", 0), { code: "CONFLICT" });
  await f.save({ enabled: false }, 1);
  await assert.rejects(f.sync("models", 2), { code: "DISABLED" });
  assert.equal(f.calls.length, 0);
});
