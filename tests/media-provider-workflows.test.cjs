"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const defaults = () => ({ image: null, video: null, audio: null });
const profile = extra => ({ id: "comfy", provider: "comfyui", workflow: null, bindings: [], ...extra });
const definition = () => ({ "1": { class_type: "KSampler", inputs: { text: "Sunshine", seed: 1 } } });
const workflow = extra => ({ id: "flow1", name: "Image workflow", kind: "image", connectionId: "comfy", definition: definition(), bindings: [{ purpose: "prompt", nodeId: "1", input: "text" }], enabled: true, ...extra });
const payload = extra => ({ expectedRevision: 0, profiles: [profile()], defaults: defaults(), workflows: [workflow()], ...extra });
const probe = (service, extra) => service.probe({ profileId: "comfy", expectedRevision: 1, workflowId: "flow1", ...extra });
const response = body => ({ status: 200, bodyText: JSON.stringify(body) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bad = code => error => error.code === code && !/session-sensitive|sk-private|workshop-private/.test(error.message);
async function fixture(t, request = async () => { throw Error("Unexpected network"); }) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "aimedia-workflows-"));
  const services = [];
  const create = options => { const service = createMediaProviderSettings({ getDataPath: () => root, request, ...options }); services.push(service); return service; };
  const service = create();
  t.after(async () => { await Promise.all(services.map(item => item.dispose())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file: path.join(root, "aimedia-settings.json"), service, create };
}

test("independent filename ignores workshop data and absent workflows normalize to an empty array", async t => {
  const f = await fixture(t);
  const oldFile = path.join(f.root, "media-providers.json");
  await fs.writeFile(oldFile, "workshop-private corrupt data");
  const empty = await f.service.read();
  assert.deepEqual(Object.keys(empty).sort(), ["catalog", "credentialStorageStatus", "defaults", "profiles", "revision", "singletonConflicts", "workflows"]);
  assert.deepEqual(empty.workflows, []); assert.equal(empty.revision, 0);
  assert.deepEqual(await fs.readdir(f.root), ["media-providers.json"]);
  await f.service.save(payload({ workflows: undefined }));
  assert.equal(await fs.readFile(oldFile, "utf8"), "workshop-private corrupt data");
  await fs.writeFile(f.file, JSON.stringify({ revision: 4, profiles: [], defaults: defaults() }));
  const loaded = await f.create().read();
  assert.equal(loaded.revision, 4); assert.deepEqual(loaded.workflows, []);
});

test("workflow CRUD roundtrip preserves omission, detaches inputs and outputs, reloads and explicitly clears without network", async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw Error("Unexpected network"); });
  const input = payload();
  const saving = f.service.save(input);
  input.workflows[0].definition["1"].inputs.text = "Caller changed";
  input.workflows[0].name = "Caller changed";
  const saved = await saving;
  assert.deepEqual(saved.workflows, [workflow()]);
  saved.workflows[0].name = "Response changed";
  const read = await f.service.read();
  assert.deepEqual(read.workflows, [workflow()]);
  const preserved = await f.service.save({ expectedRevision: 1, profiles: read.profiles, defaults: read.defaults });
  assert.deepEqual(preserved.workflows, [workflow()]);
  const updated = [workflow({ name: "Renamed", kind: "video" }), workflow({ id: "audio", kind: "audio", connectionId: null, enabled: false })];
  await f.service.save(payload({ expectedRevision: 2, workflows: updated }));
  assert.deepEqual((await f.create().read()).workflows, updated);
  const disk = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.deepEqual(disk.workflows, updated);
  assert.equal(/credentialConfigured|lastProbe/.test(JSON.stringify(disk)), false);
  const removed = await f.service.save(payload({ expectedRevision: 3, workflows: [updated[1]] }));
  assert.deepEqual(removed.workflows, [updated[1]]);
  const cleared = await f.service.save(payload({ expectedRevision: 4, workflows: [] }));
  assert.deepEqual(cleared.workflows, []); assert.equal(cleared.revision, 5);
  assert.deepEqual((await f.create().read()).workflows, []);
  assert.equal(calls, 0);
});

test("global workflow/profile CAS preserves the winner and resolves omission inside the queue", async t => {
  const { service } = await fixture(t);
  await service.save(payload());
  const results = await Promise.allSettled([
    service.save(payload({ expectedRevision: 1, workflows: [workflow({ name: "Winner" })] })),
    service.save(payload({ expectedRevision: 1, workflows: undefined, profiles: [profile({ name: "Loser" })] })),
  ]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "CONFLICT");
  const write = service.save(payload({ expectedRevision: 2, workflows: [workflow({ name: "Queued workflow" })] }));
  const preserve = service.save({ expectedRevision: 3, profiles: [profile({ name: "Queued profile" })], defaults: defaults() });
  await write;
  const final = await preserve;
  assert.equal(final.revision, 4); assert.equal(final.workflows[0].name, "Queued workflow");
  assert.equal(final.profiles[0].name, "Queued profile");
});

test("removing or changing a referenced connection rejects atomically; explicit unbind or delete succeeds", async t => {
  const calls = [];
  const f = await fixture(t, async input => { calls.push(input); return response(input.url.endsWith("system_stats") ? { system: {}, devices: [] } : { KSampler: { input: {} } }); });
  await f.service.save(payload({ profiles: [profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } })] }));
  const disk = await fs.readFile(f.file, "utf8");
  for (const profiles of [[], [profile({ provider: "openai", credentialUpdate: { action: "replace", value: "replacement-sensitive" } })]]) {
    await assert.rejects(f.service.save({ expectedRevision: 1, profiles, defaults: defaults() }), bad("INVALID_ARGUMENT"));
    assert.equal(await fs.readFile(f.file, "utf8"), disk);
  }
  await probe(f.service);
  assert.equal(calls[0].headers.Authorization, "Bearer session-sensitive");
  assert.equal((await f.service.read()).revision, 1);
  await f.service.save(payload({ expectedRevision: 1, profiles: [], workflows: [workflow({ connectionId: null })] }));
  assert.equal((await f.service.read()).workflows[0].connectionId, null);
  await f.service.save(payload({ expectedRevision: 2 }));
  const empty = await f.service.save(payload({ expectedRevision: 3, profiles: [], workflows: [] }));
  assert.deepEqual(empty.profiles, []); assert.deepEqual(empty.workflows, []);
});

test("workflow schema rejects malformed definitions, identifiers, bindings and dangling connections", async t => {
  const { service } = await fixture(t);
  const invalid = [
    { id: "" }, { id: "x".repeat(129) }, { id: "not stable" }, { name: "" }, { name: "x".repeat(129) },
    { kind: "text" }, { enabled: "yes" }, { enabled: undefined }, { connectionId: "missing" }, { connectionId: undefined },
    { definition: {} }, { definition: null }, { definition: [] }, { definition: { "1": { class_type: "", inputs: {} } } },
    { definition: { "1": { class_type: "K", inputs: [] } } }, { definition: { "1": { class_type: "K", inputs: {}, extra: true } } },
    { bindings: undefined }, { bindings: "wrong" }, { bindings: [{ purpose: "execute", nodeId: "1", input: "text" }] },
    { bindings: [{ purpose: "prompt", nodeId: "missing", input: "text" }] }, { bindings: [{ purpose: "prompt", nodeId: "1", input: "missing" }] },
    { bindings: [{ purpose: "prompt", nodeId: "1", input: "text" }, { purpose: "prompt", nodeId: "1", input: "seed" }] },
    { bindings: [{ purpose: "prompt", nodeId: "1", input: "text" }, { purpose: "seed", nodeId: "1", input: "text" }] },
    { bindings: Array(13).fill({ purpose: "prompt", nodeId: "1", input: "text" }) }, { extra: true },
  ];
  for (const fields of invalid) await assert.rejects(service.save(payload({ workflows: [workflow(fields)] })), bad("INVALID_ARGUMENT"));
  for (const workflows of [null, {}, [workflow(), workflow()], Array.from({ length: 65 }, (_, i) => workflow({ id: `w${i}` }))]) {
    await assert.rejects(service.save(payload({ workflows })), bad("INVALID_ARGUMENT"));
  }
  await assert.rejects(service.save(payload({ profiles: [profile({ provider: "openai" })] })), bad("INVALID_ARGUMENT"));
  const saved = await service.save(payload({ profiles: [profile({ enabled: false })] }));
  assert.equal(saved.workflows[0].connectionId, "comfy", "Disabled saved connections remain valid references");
  await assert.rejects(probe(service), bad("DISABLED"));
});

test("workflows preserve profile defaults and format limits and never become implicit defaults", async t => {
  const { service } = await fixture(t);
  for (const extra of [
    { defaults: { ...defaults(), image: "flow1" } },
    { defaults: { ...defaults(), image: "comfy" }, profiles: [profile({ enabled: false })] },
    { profiles: [profile({ format: "x".repeat(65) })] },
    { profiles: [profile({ format: "bad\nformat" })] },
  ]) await assert.rejects(service.save(payload(extra)), bad("INVALID_ARGUMENT"));
  const saved = await service.save(payload({ defaults: { image: "comfy", video: "comfy", audio: "comfy" }, profiles: [profile({ format: "x".repeat(64) })] }));
  assert.deepEqual(saved.defaults, { image: "comfy", video: "comfy", audio: "comfy" });
  assert.equal(saved.profiles[0].format.length, 64);
});

test("workflow count, node count and UTF-8 definition byte limits accept boundaries and reject overflow", async t => {
  const { service } = await fixture(t);
  const manyNodes = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), { class_type: "K", inputs: {} }]));
  const sizedDefinition = bytes => {
    const value = { "1": { class_type: "K", inputs: { text: "" } } };
    const count = bytes - Buffer.byteLength(JSON.stringify(value));
    value["1"].inputs.text = "界".repeat(Math.floor(count / 3)) + "x".repeat(count % 3);
    return value;
  };
  await assert.rejects(service.save(payload({ workflows: [workflow({ definition: manyNodes(301), bindings: [] })] })), bad("INVALID_ARGUMENT"));
  await assert.rejects(service.save(payload({ workflows: [workflow({ definition: sizedDefinition(200 * 1024 + 1) })] })), bad("INVALID_ARGUMENT"));
  const flows = Array.from({ length: 64 }, (_, i) => workflow({ id: `w${i}`, definition: manyNodes(300), bindings: [] }));
  flows[0].definition = sizedDefinition(200 * 1024);
  const saved = await service.save(payload({ workflows: flows }));
  assert.equal(saved.workflows.length, 64); assert.equal(Object.keys(saved.workflows[1].definition).length, 300);
  assert.equal(Buffer.byteLength(JSON.stringify(saved.workflows[0].definition)), 200 * 1024);
});

test("whole serialized settings over 8 MiB reject without disk or session mutation", async t => {
  const f = await fixture(t);
  await f.service.save(payload());
  const original = await fs.readFile(f.file, "utf8");
  const large = definition(); large["1"].inputs.text = "x".repeat(150000);
  await assert.rejects(f.service.save(payload({ expectedRevision: 1, workflows: Array.from({ length: 64 }, (_, i) => workflow({ id: `w${i}`, definition: large })) })), bad("STORAGE_ERROR"));
  assert.equal(await fs.readFile(f.file, "utf8"), original);
  assert.deepEqual((await f.service.read()).workflows, [workflow()]);
  assert.equal((await f.service.read()).revision, 1);
});

test("embedded credentials and prototype keys reject; known session credentials cannot enter any workflow field", async t => {
  const f = await fixture(t);
  for (const inputs of [
    { api_key: "sk-private" }, { authorization: "value" }, { nested: { headers: {} } },
    { text: "Bearer sk-private" }, { url: "https://user:sk-private@example.test" },
    { url: "https://example.test?token=sk-private" }, JSON.parse('{"__proto__":{}}'),
    JSON.parse('{"nested":{"constructor":{}}}'), JSON.parse('{"nested":{"prototype":{}}}'),
  ]) await assert.rejects(f.service.save(payload({ workflows: [workflow({ definition: { "1": { class_type: "K", inputs } }, bindings: [] })] })), bad("INVALID_ARGUMENT"));
  await f.service.save(payload({ profiles: [profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } })] }));
  for (const fields of [
    { name: "session-sensitive" }, { id: "session-sensitive" },
    { definition: { "1": { class_type: "K", inputs: { text: "session-sensitive" } } } },
  ]) await assert.rejects(f.service.save(payload({ expectedRevision: 1, workflows: [workflow(fields)] })), bad("INVALID_ARGUMENT"));
  const publicState = JSON.stringify(await f.service.read());
  assert.equal(publicState.includes("session-sensitive"), false);
  assert.equal((await fs.readFile(f.file, "utf8")).includes("session-sensitive"), false);
  assert.equal((await f.service.read()).profiles[0].credentialConfigured, true);
});

test("invalid persisted workflows fail safely without resetting or overwriting the file", async t => {
  const f = await fixture(t);
  for (const workflows of [[workflow({ connectionId: "missing" })], [workflow({ definition: {} })], [workflow({ bindings: [{ purpose: "prompt", nodeId: "2", input: "text" }] })]]) {
    const raw = JSON.stringify({ revision: 7, profiles: [profile()], defaults: defaults(), workflows });
    await fs.writeFile(f.file, raw);
    const service = f.create();
    await assert.rejects(service.read(), bad("STORAGE_ERROR"));
    await assert.rejects(service.save(payload({ expectedRevision: 7 })), bad("STORAGE_ERROR"));
    assert.equal(await fs.readFile(f.file, "utf8"), raw);
  }
});

test("saved standalone workflow selects node comparison without changing the stored profile or executing anything", async t => {
  const calls = [];
  const f = await fixture(t, async input => { calls.push(input); return response(input.url.endsWith("system_stats") ? { system: {}, devices: [] } : { KSampler: { input: {} } }); });
  const missing = { "2": { class_type: "MissingNode", inputs: {} } };
  await f.service.save(payload({ profiles: [profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } })], workflows: [workflow(), workflow({ id: "missing", definition: missing, bindings: [] })] }));
  const disk = await fs.readFile(f.file, "utf8");
  assert.equal((await probe(f.service)).status, "connected");
  const absent = await probe(f.service, { workflowId: "missing" });
  assert.equal(absent.status, "unavailable"); assert.match(absent.message, /missing/);
  const state = await f.service.read();
  assert.equal(state.profiles[0].workflow, null); assert.deepEqual(state.profiles[0].bindings, []);
  assert.deepEqual(state.workflows, [workflow(), workflow({ id: "missing", definition: missing, bindings: [] })]);
  assert.equal(await fs.readFile(f.file, "utf8"), disk);
  assert.deepEqual(calls.map(item => new URL(item.url).pathname), ["/system_stats", "/object_info", "/system_stats", "/object_info"]);
  assert.ok(calls.every(item => item.method === "GET" && item.body === undefined && item.redirect === "error" && item.headers.Authorization === "Bearer session-sensitive"));
  const saved = await f.service.save({ expectedRevision: state.revision, profiles: state.profiles, defaults: state.defaults });
  assert.equal(saved.profiles[0].lastProbe, undefined); assert.equal(saved.profiles[0].credentialConfigured, true);
  assert.equal(/lastProbe|credentialConfigured|session-sensitive/.test(await fs.readFile(f.file, "utf8")), false);
});

test("workflow probes reject missing, disabled, unbound, wrong-target, non-Comfy and stale selections before network", async t => {
  let calls = 0;
  const { service } = await fixture(t, async () => { calls++; throw Error("Unexpected network"); });
  await service.save(payload({ profiles: [profile(), profile({ id: "other" }), profile({ id: "cloud", provider: "openai" })], workflows: [workflow(), workflow({ id: "off", enabled: false }), workflow({ id: "unbound", connectionId: null })] }));
  for (const [extra, code] of [
    [{ workflowId: "unknown" }, "NOT_FOUND"], [{ workflowId: "off" }, "DISABLED"],
    [{ workflowId: "unbound" }, "INVALID_ARGUMENT"], [{ profileId: "other" }, "INVALID_ARGUMENT"],
    [{ profileId: "cloud" }, "INVALID_ARGUMENT"], [{ expectedRevision: 0 }, "CONFLICT"],
    [{ workflowId: null }, "INVALID_ARGUMENT"], [{ workflowId: "bad id" }, "INVALID_ARGUMENT"],
  ]) await assert.rejects(probe(service, extra), bad(code));
  assert.equal(calls, 0);
});

test("workflow probe dedup and global revision discard late results after workflow edits", async t => {
  const started = deferred(); const done = deferred(); let calls = 0;
  const { service } = await fixture(t, async () => { calls++; started.resolve(); return done.promise; });
  await service.save(payload({ workflows: [workflow(), workflow({ id: "second" })] }));
  const running = probe(service); await started.promise;
  await assert.rejects(probe(service, { workflowId: "second" }), bad("PROBE_PENDING"));
  await service.save(payload({ expectedRevision: 1, workflows: [workflow({ name: "Changed" })] }));
  done.resolve(response({ system: {}, devices: [] }));
  await assert.rejects(running, bad("CONFLICT"));
  assert.equal(calls, 1); assert.equal((await service.read()).profiles[0].lastProbe, undefined);
});

test("disposal drains queued workflow saves, clears credentials and rejects late discovery", async t => {
  const started = deferred(); const done = deferred();
  const f = await fixture(t, async () => { started.resolve(); return done.promise; });
  await f.service.save(payload({ profiles: [profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } })] }));
  const running = probe(f.service); await started.promise;
  await f.service.dispose();
  done.resolve(response({ system: {}, devices: [] }));
  await assert.rejects(running, bad("CONFLICT"));
  await assert.rejects(f.service.read(), bad("DISPOSED"));
  const reloaded = await f.create().read();
  assert.deepEqual(reloaded.workflows, [workflow()]); assert.equal(reloaded.profiles[0].credentialConfigured, true);
  const entered = deferred(); const release = deferred(); let paths = 0;
  const service = f.create({ getDataPath: async () => { paths++; if (paths === 2) { entered.resolve(); await release.promise; } return f.root; } });
  await service.read();
  const first = service.save(payload({ expectedRevision: 1, workflows: [] }));
  const second = service.save(payload({ expectedRevision: 2 }));
  const settled = Promise.allSettled([first, second]);
  await entered.promise;
  let drained = false; const drain = service.dispose().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release.resolve(); await drain;
  assert.ok((await settled).every(item => item.status === "rejected" && item.reason.code === "DISPOSED"));
  assert.deepEqual((await f.create().read()).workflows, [workflow()]);
});

test("discovery response cap counts UTF-8 bytes rather than code units", async t => {
  const f = await fixture(t, async () => response({ data: [], ignored: "界".repeat(750000) }));
  await f.service.save(payload({ profiles: [profile({ provider: "openai", credentialUpdate: { action: "replace", value: "session-sensitive" } })], workflows: [] }));
  const result = await f.service.probe({ profileId: "comfy", expectedRevision: 1 });
  assert.equal(result.status, "unavailable"); assert.equal(JSON.stringify(result).includes("session-sensitive"), false);
});
