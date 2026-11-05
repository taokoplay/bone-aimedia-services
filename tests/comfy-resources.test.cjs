"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const defaults = { image: null, video: null, audio: null };
const profile = extra => ({ id: "comfy", provider: "comfyui", ...extra });
const response = value => ({ status: 200, bodyText: JSON.stringify(value) });
const fileInfo = (name = "nested/绘图.json", extra) => ({ path: name, size: 100, modified: 1234, created: 1200, ...extra });
const api = () => ({ "1": { class_type: "KSampler", inputs: { text: "A sunny day", seed: 1 } } });
const historyItem = (id, extra) => ({ prompt: [1, id, { privatePrompt: "third-party" }, { privateExtra: "https://private.example" }], outputs: { "1": { images: [{ filename: "private-image", url: "https://private.example" }] } }, status: { status_str: "success", completed: true }, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bad = code => error => error.code === code && !/session-sensitive|other-sensitive/.test(error.message);
async function fixture(t, handler = async () => { throw Error("Unexpected request"); }) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-resources-"));
  const calls = [];
  const service = createMediaProviderSettings({ getDataPath: () => root, request: async input => { calls.push(input); return handler(input); } });
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { service, root, calls, file: path.join(root, "aimedia-settings.json"), save: (profiles = [profile()], expectedRevision = 0) => service.save({ expectedRevision, profiles, defaults }), browse: (resource = "model-folders", extra) => service.browse({ profileId: "comfy", expectedRevision: 1, resource, ...extra }) };
}
function envelope(value, resource, status = "ok") {
  assert.equal(value.profileId, "comfy"); assert.equal(value.resource, resource); assert.equal(value.status, status);
  assert.ok(Number.isFinite(Date.parse(value.checkedAt))); assert.ok(Array.isArray(value.items));
  assert.equal(typeof value.total, "number"); assert.equal(typeof value.offset, "number"); assert.equal(typeof value.limit, "number");
  assert.equal(typeof value.truncated, "boolean"); assert.equal(typeof value.message, "string");
}

test("browse user path lists folders, models, workflows and API detail with exact safe GET requests and no writes", async t => {
  const folder = "模型 checkpoints";
  const f = await fixture(t, async input => {
    const url = new URL(input.url);
    if (url.pathname === "/prefix/models") return response([folder]);
    if (url.pathname === `/prefix/models/${encodeURIComponent(folder)}`) return response(["nested/模型.safetensors"]);
    if (url.pathname === "/prefix/userdata") return response([fileInfo(), fileInfo("notes.txt")]);
    if (url.pathname === `/prefix/userdata/${encodeURIComponent("workflows/nested/绘图.json")}`) return response(api());
    throw Error("Unexpected route");
  });
  const rawWorkflow = { "9": { class_type: "Raw", inputs: { text: "Configured raw workflow" } } };
  await f.save([profile({ baseUrl: "http://localhost:8188/prefix", comfyUser: "selected-user", credentialUpdate: { action: "replace", value: "session-sensitive" }, workflow: rawWorkflow })]);
  const before = await fs.readFile(f.file, "utf8"); const stat = await fs.stat(f.file);
  const folders = await f.browse(); envelope(folders, "model-folders"); assert.deepEqual(folders.items, [{ name: folder }]);
  assert.equal(folders.offset, 0); assert.equal(folders.limit, 50); assert.equal(folders.truncated, false);
  const models = await f.browse("models", { folder }); envelope(models, "models"); assert.deepEqual(models.items, [{ name: "nested/模型.safetensors" }]);
  const workflows = await f.browse("workflows"); envelope(workflows, "workflows"); assert.deepEqual(workflows.items, [fileInfo()]);
  const detail = await f.browse("workflow", { path: "nested/绘图.json" }); envelope(detail, "workflow");
  assert.deepEqual(detail.definition, api()); assert.equal(detail.format, "api"); assert.equal(detail.importable, true);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.map(item => item.url), [
    "http://localhost:8188/prefix/models", `http://localhost:8188/prefix/models/${encodeURIComponent(folder)}`,
    "http://localhost:8188/prefix/userdata?dir=workflows&recurse=true&full_info=true", `http://localhost:8188/prefix/userdata/${encodeURIComponent("workflows/nested/绘图.json")}`,
  ]);
  for (const call of f.calls) {
    assert.equal(call.method, "GET"); assert.equal(call.body, undefined); assert.equal(call.redirect, "error"); assert.equal(call.timeoutMs, 15000);
    assert.deepEqual(call.headers, { Accept: "application/json", Authorization: "Bearer session-sensitive", "Comfy-User": "selected-user" });
  }
  assert.equal(await fs.readFile(f.file, "utf8"), before); assert.equal((await fs.stat(f.file)).mtimeMs, stat.mtimeMs);
  assert.deepEqual(await fs.readdir(f.root), ["aimedia-settings.json"]);
  const state = await f.service.read(); assert.deepEqual(state.profiles[0].workflow, rawWorkflow); assert.deepEqual(state.workflows, []);
  assert.equal(state.profiles[0].lastProbe, undefined); assert.equal(state.revision, 1);
});

test("browse rejects unsaved, disabled, non-Comfy and stale profiles before requests", async t => {
  const f = await fixture(t);
  await assert.rejects(f.browse("queue", { expectedRevision: 0 }), bad("NOT_FOUND"));
  await f.save([profile({ enabled: false }), profile({ id: "cloud", provider: "openai" })]);
  await assert.rejects(f.browse("queue"), bad("DISABLED"));
  await assert.rejects(f.browse("queue", { profileId: "cloud" }), bad("INVALID_ARGUMENT"));
  await assert.rejects(f.browse("queue", { expectedRevision: 0 }), bad("CONFLICT"));
  await assert.rejects(f.browse("queue", { profileId: "missing" }), bad("NOT_FOUND"));
  assert.equal(f.calls.length, 0);
});

test("browse input has strict resource, key, directory and pagination semantics", async t => {
  const f = await fixture(t); await f.save();
  for (const extra of [
    { resource: "prompt" }, { resource: "/models" }, { url: "https://other.example" }, { suffix: "/queue" }, { method: "POST" },
    { folder: "checkpoints" }, { path: "flow.json" }, { resource: "models" }, { resource: "workflow" },
    { offset: -1 }, { offset: 1.5 }, { offset: "1" }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "50" }, { limit: null },
    { expectedRevision: -1 }, { expectedRevision: "1" }, { profileId: "bad id" },
    { resource: "workflow", path: "flow.json", offset: 1 }, { resource: "workflow", path: "flow.txt" },
    { resource: "models", folder: "nested/folder" },
  ]) await assert.rejects(f.browse("model-folders", extra), bad("INVALID_ARGUMENT"));
  assert.equal(f.calls.length, 0);
});

test("model folders and workflow details require previous successful profile-local listings", async t => {
  const f = await fixture(t, async input => response(input.url.endsWith("/models") ? ["checkpoints"] : [fileInfo()]));
  await f.save([profile(), profile({ id: "second" })]);
  assert.equal((await f.browse("models", { folder: "checkpoints" })).status, "unavailable");
  assert.equal((await f.browse("workflow", { path: "nested/绘图.json" })).status, "unavailable");
  assert.equal(f.calls.length, 0);
  const folders = await f.browse(); const workflows = await f.browse("workflows");
  folders.items.push({ name: "injected" }); workflows.items.push(fileInfo("injected.json"));
  for (const extra of [{ folder: "injected" }, { folder: "checkpoints", profileId: "second" }]) assert.equal((await f.browse("models", extra)).status, "unavailable");
  for (const extra of [{ path: "injected.json" }, { path: "nested/绘图.json", profileId: "second" }]) assert.equal((await f.browse("workflow", extra)).status, "unavailable");
  assert.equal(f.calls.length, 2);
  await f.save([profile()], 1);
  assert.equal((await f.browse("models", { folder: "checkpoints", expectedRevision: 2 })).status, "unavailable");
  assert.equal((await f.browse("workflow", { path: "nested/绘图.json", expectedRevision: 2 })).status, "unavailable");
  assert.equal(f.calls.length, 2);
});

test("unsafe paths including multiply encoded traversal fail both input and entire response", async t => {
  let body;
  const f = await fixture(t, async () => response(body)); await f.save();
  const paths = ["../bad.json", "a/../bad.json", "./bad.json", "/bad.json", "a//bad.json", "a\\bad.json", "C:/bad.json", "https://bad.json", "//host/bad.json", "%2e%2e/bad.json", "%252e%252e/bad.json", "a%2fbad.json", "bad\u0000.json", "bad\n.json", "bad.json?token=x", "bad.json#fragment", "a/ .. /bad.json", "<img>.json", "user@host.json"];
  for (const name of paths) {
    await assert.rejects(f.browse("workflow", { path: name }), bad("INVALID_ARGUMENT"));
    body = [fileInfo("safe.json"), fileInfo(name)];
    const value = await f.browse("workflows", { limit: 1 }); envelope(value, "workflows", "unavailable"); assert.deepEqual(value.items, []);
  }
  body = ["checkpoints", "../private"];
  assert.equal((await f.browse()).status, "unavailable");
  assert.equal((await f.browse("models", { folder: "checkpoints" })).status, "unavailable");
});

test("all current session credentials and auth-like metadata are rejected before pagination", async t => {
  let body;
  const f = await fixture(t, async () => response(body));
  await f.save([profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } }), profile({ id: "other", credentialUpdate: { action: "replace", value: "other-sensitive" } })]);
  for (const name of ["session-sensitive", "other-sensitive", "Bearer abc", "Basic abc", "api_key=abc", "Authorization: abc", "sk-123456789", "https://user:pass@host", "//remote/path"]) {
    body = ["checkpoints", name];
    const value = await f.browse("model-folders", { limit: 1 }); assert.equal(value.status, "unavailable"); assert.deepEqual(value.items, []);
    assert.equal(JSON.stringify(value).includes(name), false);
    body = { queue_running: [[1, name]], queue_pending: [] };
    assert.equal((await f.browse("queue")).status, "unavailable");
    body = { job: historyItem("job", { status: { status_str: name, completed: true } }) };
    assert.equal((await f.browse("history")).status, "unavailable");
  }
});

test("workflow API import and canvas/unknown preview do not execute or persist workflow data", async t => {
  let definition = api();
  const f = await fixture(t, async input => response(input.url.includes("?dir=") ? [fileInfo()] : definition));
  await f.save(); await f.browse("workflows");
  const original = await fs.readFile(f.file, "utf8");
  for (const [value, format, importable] of [
    [api(), "api", true], [{ nodes: [{ id: 1, type: "KSampler", widgets_values: ["你好"] }], links: [], version: 0.4 }, "canvas", false],
    [{ description: "Unknown workflow format" }, "unknown", false], [{}, "unknown", false],
  ]) {
    definition = value;
    const result = await f.browse("workflow", { path: "nested/绘图.json" });
    assert.equal(result.status, "ok"); assert.equal(result.format, format); assert.equal(result.importable, importable); assert.deepEqual(result.definition, value);
  }
  assert.ok(f.calls.every(call => call.method === "GET" && call.body === undefined && !call.url.includes("/prompt")));
  assert.equal(await fs.readFile(f.file, "utf8"), original);
});

test("workflow previews reject credentials, unsafe keys, unsafe API shapes, depth and UTF8 limits", async t => {
  let definition;
  const f = await fixture(t, async input => response(input.url.includes("?dir=") ? [fileInfo()] : definition));
  await f.save([profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } }), profile({ id: "other", credentialUpdate: { action: "replace", value: "other-sensitive" } })]);
  await f.browse("workflows");
  let deep = {}; for (let i = 0; i < 26; i++) deep = { nested: deep };
  const invalid = [
    null, [], { nodes: [{ api_key: "anything" }] }, { nodes: [{ text: "session-sensitive" }] }, { nodes: [{ text: "other-sensitive" }] },
    { nodes: [{ text: "Bearer something" }] }, { nodes: [{ text: "https://user:password@remote.example/path" }] },
    JSON.parse('{"nodes":[],"extra":{"__proto__":{}}}'), JSON.parse('{"constructor":{}}'), { nodes: [], extra: { headers: {} } },
    { "1": { class_type: "K", inputs: [] } }, { "1": { class_type: "", inputs: {} } },
    Object.fromEntries(Array.from({ length: 301 }, (_, i) => [String(i), { class_type: "K", inputs: {} }])),
    { nodes: Array(301).fill({ id: 1 }) }, { text: "界".repeat(70000) }, deep,
  ];
  for (const value of invalid) {
    definition = value;
    const output = await f.browse("workflow", { path: "nested/绘图.json" });
    envelope(output, "workflow", "unavailable"); assert.equal(output.definition, undefined);
    assert.equal(/session-sensitive|other-sensitive/.test(JSON.stringify(output)), false);
  }
});

test("directory pagination validates all entries and accepts 10000 but rejects overflow", async t => {
  let names = Array.from({ length: 10000 }, (_, i) => `folder${i}`);
  const f = await fixture(t, async () => response(names)); await f.save();
  let value = await f.browse("model-folders", { offset: 9980, limit: 100 });
  assert.equal(value.status, "ok"); assert.equal(value.total, 10000); assert.equal(value.items.length, 20); assert.equal(value.items[0].name, "folder9980"); assert.equal(value.truncated, true);
  value = await f.browse("model-folders", { offset: 10000, limit: 100 }); assert.deepEqual(value.items, []); assert.equal(value.total, 10000);
  names.push("overflow"); value = await f.browse(); assert.equal(value.status, "unavailable"); assert.deepEqual(value.items, []);
  names = ["valid", 5]; assert.equal((await f.browse("model-folders", { limit: 1 })).status, "unavailable");
  names = Array.from({ length: 80 }, (_, i) => `folder${i}`);
  value = await f.browse(); assert.equal(value.items.length, 50); assert.equal(value.total, 80); assert.equal(value.truncated, true);
});

test("workflow listing validates numeric fields and non-JSON records before filtering", async t => {
  let body;
  const f = await fixture(t, async () => response(body)); await f.save();
  for (const value of [null, {}, ["flow.json"], [fileInfo("good.json"), fileInfo("bad.txt", { modified: "123" })], [fileInfo("a.json", { size: -1 })], [fileInfo("a.json", { created: 1.5 })], Array(10001).fill(fileInfo())]) {
    body = value; const result = await f.browse("workflows"); assert.equal(result.status, "unavailable"); assert.deepEqual(result.items, []);
  }
  body = [fileInfo("a.json"), fileInfo("b.JSON"), fileInfo("notes.txt")];
  const result = await f.browse("workflows", { offset: 1, limit: 1 }); assert.deepEqual(result.items, [fileInfo("b.JSON")]); assert.equal(result.total, 2); assert.equal(result.truncated, true);
});

test("queue and history expose only bounded server-wide metadata and strip third party payloads", async t => {
  const f = await fixture(t, async input => response(input.url.endsWith("/queue")
    ? { queue_running: [[1.5, "running-id", { prompt: "privatePrompt" }, { owner: "third-party" }]], queue_pending: [[-1, "pending-id", { url: "https://private.example" }]] }
    : { "job-ok": historyItem("job-ok"), "job-error": historyItem("job-error", { status: { status_str: "error", completed: false } }), "job-unknown": historyItem("job-unknown", { status: { status_str: "future-state" } }), "job-old": historyItem("job-old", { status: undefined }) }));
  await f.save();
  const queue = await f.browse("queue"); envelope(queue, "queue");
  assert.deepEqual(queue.items, [{ promptId: "running-id", number: 1.5, state: "running" }, { promptId: "pending-id", number: -1, state: "pending" }]);
  const history = await f.browse("history"); envelope(history, "history");
  assert.deepEqual(history.items, [
    { promptId: "job-ok", status: "success", completed: true, outputCount: 1 }, { promptId: "job-error", status: "error", completed: false, outputCount: 1 },
    { promptId: "job-unknown", status: "unknown", completed: null, outputCount: 1 }, { promptId: "job-old", status: "unknown", completed: null, outputCount: 1 },
  ]);
  for (const value of [queue, history]) { assert.match(value.message, /Server-wide.*not plugin-owned/); assert.equal(/privatePrompt|third-party|https:|private-image/.test(JSON.stringify(value)), false); }
  assert.equal(new URL(f.calls[1].url).search, "?max_items=100"); assert.ok(f.calls.every(call => call.method === "GET"));
});

test("history cap remains explicitly truncated even when the whole returned window fits", async t => {
  let count = 100;
  const f = await fixture(t, async () => response(Object.fromEntries(Array.from({ length: count }, (_, i) => [`job${i}`, historyItem(`job${i}`)]))));
  await f.save();
  let value = await f.browse("history", { limit: 100 }); assert.equal(value.total, 100); assert.equal(value.items.length, 100); assert.equal(value.truncated, true); assert.match(value.message, /at most 100.*only returned/);
  value = await f.browse("history", { offset: 95, limit: 10 }); assert.equal(value.items.length, 5); assert.equal(value.truncated, true);
  count = 99; assert.equal((await f.browse("history", { limit: 100 })).truncated, false);
  count = 101; value = await f.browse("history"); assert.equal(value.status, "unavailable"); assert.deepEqual(value.items, []);
});

test("queue/history validate every projected record before exposing a partial page", async t => {
  let body;
  const f = await fixture(t, async () => response(body)); await f.save();
  for (const value of [[], {}, { queue_running: [], queue_pending: null }, { queue_running: [[1, "safe"], ["bad", "id"]], queue_pending: [] }, { queue_running: [[1, "https://bad"]], queue_pending: [] }, { queue_running: Array(10001).fill([1, "id"]), queue_pending: [] }]) {
    body = value; assert.equal((await f.browse("queue", { limit: 1 })).status, "unavailable");
  }
  for (const item of [null, {}, historyItem("bad", { outputs: [] }), historyItem("bad", { outputs: { "1": "bad" } }), historyItem("different"), historyItem("bad", { status: { completed: "yes" } }), historyItem("bad", { status: [] }), historyItem("bad", { prompt: [] })]) {
    body = { safe: historyItem("safe"), bad: item };
    const value = await f.browse("history", { limit: 1 }); assert.equal(value.status, "unavailable"); assert.deepEqual(value.items, []);
  }
});

test("404/405/501 endpoints are unsupported and status/json/UTF8 response failures are unavailable", async t => {
  let outcome;
  const f = await fixture(t, async () => outcome); await f.save();
  for (const status of [404, 405, 501]) {
    outcome = { status, bodyText: "private-error" };
    const value = await f.browse(); envelope(value, "model-folders", "unsupported"); assert.deepEqual(value.items, []); assert.equal(value.total, 0);
  }
  for (const value of [null, { status: "200", bodyText: "[]" }, { status: 302, bodyText: "[]" }, { status: 401, bodyText: "private-error" }, { status: 500, bodyText: "private-error" }, { status: 200, bodyText: "<html>private-error</html>" }, { status: 200, bodyText: "{broken" }, { status: 200, bodyText: 123 }, response({}), response(["界".repeat(750000)]), response(Array(10001).fill("x"))]) {
    outcome = value; const output = await f.browse(); envelope(output, "model-folders", "unavailable"); assert.deepEqual(output.items, []); assert.equal(JSON.stringify(output).includes("private-error"), false);
  }
});

test("permission codes are allowlisted and raw host errors never escape", async t => {
  let code;
  const f = await fixture(t, async () => { throw Object.assign(Error("session-sensitive https://private.example"), { code }); }); await f.save();
  for (const value of ["PERMISSION_DENIED", "HOST_PERMISSION_DENIED", "NETWORK_PERMISSION_DENIED", "NET_PERMISSION_DENIED", "CAPABILITY_DENIED", "FORBIDDEN", "APPROVAL_REQUIRED", "RAW_PRIVATE_ERROR", undefined]) {
    code = value; const output = await f.browse(); assert.equal(output.status, "unavailable");
    assert.equal(output.code, ["RAW_PRIVATE_ERROR", undefined].includes(code) ? "NETWORK_ERROR" : code);
    assert.equal(/session-sensitive|private.example|RAW_PRIVATE_ERROR/.test(JSON.stringify(output)), false);
  }
});

test("failed refresh revokes older folder and workflow membership", async t => {
  let fail = false;
  const f = await fixture(t, async input => fail ? { status: 404, bodyText: "" } : response(input.url.endsWith("/models") ? ["checkpoints"] : [fileInfo()]));
  await f.save(); await f.browse(); await f.browse("workflows"); fail = true;
  await f.browse(); await f.browse("workflows");
  const count = f.calls.length;
  assert.equal((await f.browse("models", { folder: "checkpoints" })).status, "unavailable");
  assert.equal((await f.browse("workflow", { path: "nested/绘图.json" })).status, "unavailable");
  assert.equal(f.calls.length, count);
});

test("browse shares per-profile pending dedup with probe in both directions", async t => {
  let release = deferred(); let started = deferred(); let blocking = true;
  const f = await fixture(t, async input => { if (blocking) { started.resolve(); return release.promise; } return response(input.url.endsWith("system_stats") ? { system: {}, devices: [] } : { KSampler: { input: {} } }); });
  await f.save();
  const browsing = f.browse(); await started.promise;
  await assert.rejects(f.browse("queue"), bad("PROBE_PENDING"));
  await assert.rejects(f.service.probe({ profileId: "comfy", expectedRevision: 1 }), bad("PROBE_PENDING"));
  release.resolve(response(["checkpoints"])); await browsing;
  release = deferred(); started = deferred();
  const probing = f.service.probe({ profileId: "comfy", expectedRevision: 1 }); await started.promise;
  await assert.rejects(f.browse(), bad("PROBE_PENDING"));
  blocking = false; release.resolve(response({ system: {}, devices: [] })); assert.equal((await probing).status, "connected");
  assert.equal(f.calls.length, 2);
});

test("late listing after credential save cannot return data or restore membership", async t => {
  const release = deferred(); const started = deferred();
  const f = await fixture(t, async () => { started.resolve(); return release.promise; });
  await f.save([profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } })]);
  const browsing = f.browse(); await started.promise;
  await f.save([profile({ credentialUpdate: { action: "replace", value: "replacement-sensitive" } })], 1);
  release.resolve(response(["checkpoints"])); await assert.rejects(browsing, bad("CONFLICT"));
  assert.equal((await f.browse("models", { expectedRevision: 2, folder: "checkpoints" })).status, "unavailable");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].headers.Authorization, "Bearer session-sensitive");
  assert.equal((await f.service.read()).profiles[0].lastProbe, undefined);
});

test("late workflow detail after save and late listing after disposal cannot escape", async t => {
  const release = deferred(); const started = deferred();
  const f = await fixture(t, async input => {
    if (input.url.includes("?dir=")) return response([fileInfo()]);
    started.resolve(); return release.promise;
  });
  await f.save(); await f.browse("workflows");
  const browsing = f.browse("workflow", { path: "nested/绘图.json" }); await started.promise;
  await f.save([profile({ name: "Edited" })], 1);
  release.resolve(response(api())); await assert.rejects(browsing, bad("CONFLICT"));
  assert.equal((await f.browse("workflow", { expectedRevision: 2, path: "nested/绘图.json" })).status, "unavailable");
  const stop = deferred(); const entered = deferred();
  const g = await fixture(t, async () => { entered.resolve(); return stop.promise; }); await g.save();
  const pending = g.browse(); await entered.promise; await g.service.dispose();
  stop.resolve(response(["checkpoints"])); await assert.rejects(pending, bad("CONFLICT"));
  await assert.rejects(g.browse(), bad("DISPOSED"));
});

test("queued browse captures saved revision and credential and detaches caller input", async t => {
  const f = await fixture(t, async () => response(["checkpoints"]));
  const saving = f.save([profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } })]);
  const input = { profileId: "comfy", expectedRevision: 1, resource: "model-folders", limit: 1 };
  const browsing = f.service.browse(input); input.resource = "queue"; input.profileId = "other"; input.limit = 99;
  await saving;
  const value = await browsing; envelope(value, "model-folders"); assert.equal(value.limit, 1);
  assert.equal(f.calls[0].headers.Authorization, "Bearer session-sensitive"); assert.ok(f.calls[0].url.endsWith("/models"));
});

test("malformed Unicode and generic token assignments cannot enter resource metadata or requests", async t => {
  let body;
  const f = await fixture(t, async () => response(body)); await f.save();
  for (const value of ["\ud800", "\udfff", "token=private", "refresh_token=private", "credential=private"]) {
    await assert.rejects(f.browse("models", { folder: value }), bad("INVALID_ARGUMENT"));
    body = [value];
    assert.equal((await f.browse()).status, "unavailable");
  }
});

test("workflow preview rejects additional authentication keys", async t => {
  let body;
  const f = await fixture(t, async input => response(input.url.includes("?dir=") ? [fileInfo()] : body));
  await f.save(); await f.browse("workflows");
  for (const key of ["refresh_token", "sessionToken", "id_token", "auth", "authentication"]) {
    body = { nodes: [], extra: { [key]: "unrecognized-private-value" } };
    const value = await f.browse("workflow", { path: "nested/绘图.json" });
    assert.equal(value.status, "unavailable"); assert.equal(value.definition, undefined);
  }
});

test("exact response and workflow byte boundaries accept valid data and reject one-byte overflow", async t => {
  let outcome;
  const f = await fixture(t, async input => input.url.includes("?dir=") ? response([fileInfo()]) : outcome); await f.save();
  outcome = { status: 200, bodyText: "[]" + " ".repeat(2 * 1024 * 1024 - 2) };
  let value = await f.browse(); assert.equal(value.status, "ok"); assert.deepEqual(value.items, []); assert.equal(value.truncated, false);
  outcome.bodyText += " "; assert.equal((await f.browse()).status, "unavailable");
  await f.browse("workflows");
  const definition = { "1": { class_type: "K", inputs: { a: "x".repeat(100000), b: "" } } };
  definition["1"].inputs.b = "y".repeat(200 * 1024 - Buffer.byteLength(JSON.stringify(definition)));
  outcome = response(definition);
  value = await f.browse("workflow", { path: "nested/绘图.json" }); assert.equal(value.status, "ok"); assert.equal(value.importable, true);
  definition["1"].inputs.b += "y"; outcome = response(definition);
  assert.equal((await f.browse("workflow", { path: "nested/绘图.json" })).status, "unavailable");
});

test("different profiles may browse concurrently with independently captured credentials", async t => {
  const release = deferred(); const entered = deferred(); let started = 0;
  const f = await fixture(t, async () => { if (++started === 2) entered.resolve(); return release.promise; });
  await f.save([profile({ credentialUpdate: { action: "replace", value: "session-sensitive" } }), profile({ id: "second", credentialUpdate: { action: "replace", value: "other-sensitive" } })]);
  const first = f.browse(); const second = f.browse("model-folders", { profileId: "second" });
  await entered.promise;
  release.resolve(response(["checkpoints"]));
  const values = await Promise.all([first, second]); assert.ok(values.every(value => value.status === "ok"));
  assert.deepEqual(f.calls.map(call => call.headers.Authorization), ["Bearer session-sensitive", "Bearer other-sensitive"]);
});
