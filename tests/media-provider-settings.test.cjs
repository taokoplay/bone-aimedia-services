"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const { getMediaProviderCatalog } = require("../lib/media-provider-catalog.js");
const defaults = () => ({ image: null, video: null, audio: null });
const profile = (provider = "openai", extra = {}) => ({ id: "p1", provider, ...extra });
const credential = value => ({ action: "replace", value });
const response = body => ({ status: 200, bodyText: JSON.stringify(body), headers: {} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, request = async () => { throw new Error("Unexpected network"); }) {
  const parent = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "media-settings-test-"));
  const root = path.join(parent, "private");
  const service = createMediaProviderSettings({ getDataPath: () => root, request });
  t.after(async () => { service.dispose(); await fs.rm(parent, { recursive: true, force: true }); });
  return { service, root, parent, file: path.join(root, "aimedia-settings.json"), request };
}
const save = (service, profiles, expectedRevision = 0, selected = defaults()) => service.save({ expectedRevision, profiles, defaults: selected });
const probe = (service, expectedRevision = 1) => service.probe({ profileId: "p1", expectedRevision });
const bad = code => error => error.code === code && !/super-secret|secret-key/.test(error.message);
const flow = () => ({ "1": { class_type: "KSampler", inputs: { seed: 1, text: "A sunny day" } } });

test("catalog is detached JSON data with exact supported defaults", () => {
  const catalog = getMediaProviderCatalog();
  assert.deepEqual(catalog.map(item => item.id), ["dreamina", "openai", "minimax", "xiaomi", "comfyui", "libtv"]);
  assert.deepEqual(catalog[0].defaultModels.map(item => item.id), ["5.0", "seedance2.0"]);
  assert.equal(catalog[3].defaultModels[0].id, "mimo-v2.5-tts");
  assert.deepEqual(catalog[4].defaultModels, []);
  catalog[0].name = "changed";
  assert.equal(getMediaProviderCatalog()[0].name, "即梦 Dreamina");
  assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
});

test("absent read is revision zero with no writes; save is network-free; restart restores credentials", async t => {
  const { service, root, file, request } = await fixture(t);
  const empty = await service.read();
  assert.equal(empty.revision, 0); assert.deepEqual(empty.profiles, []); assert.deepEqual(empty.defaults, defaults());
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
  const saved = await save(service, [profile("xiaomi", { credentialUpdate: credential("super-secret") })]);
  assert.equal(saved.revision, 1); assert.equal(saved.profiles[0].credentialConfigured, true);
  assert.equal(saved.profiles[0].voice, "mimo_default"); assert.equal(saved.profiles[0].modelId, "");
  assert.equal(JSON.stringify(saved).includes("super-secret"), false);
  const disk = await fs.readFile(file, "utf8");
  assert.equal(/super-secret|credentialUpdate|credentialConfigured|lastProbe/.test(disk), false);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const restarted = createMediaProviderSettings({ getDataPath: () => root, request });
  t.after(() => restarted.dispose());
  const loaded = await restarted.read();
  assert.equal(loaded.revision, 1); assert.equal(loaded.profiles[0].credentialConfigured, true);
  assert.deepEqual(loaded.defaults, defaults());
});

test("credential preserve, clear, replace and identity change remain consistent", async t => {
  const calls = [];
  const { service } = await fixture(t, async input => { calls.push(input); return response({ data: [] }); });
  await save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  await save(service, [profile("openai", { name: "Renamed" })], 1);
  await probe(service, 2); assert.equal(calls[0].headers.Authorization, "Bearer super-secret");
  let value = await save(service, [profile("openai", { baseUrl: "https://example.com/v1" })], 2);
  assert.equal(value.profiles[0].credentialConfigured, false);
  value = await save(service, [profile("xiaomi", { credentialUpdate: credential("second-secret") })], 3);
  assert.equal(value.profiles[0].credentialConfigured, true);
  value = await save(service, [profile("openai")], 4);
  assert.equal(value.profiles[0].credentialConfigured, false);
  await save(service, [profile("openai", { credentialUpdate: credential("third-secret") })], 5);
  value = await save(service, [profile("openai", { credentialUpdate: { action: "clear" } })], 6);
  assert.equal(value.profiles[0].credentialConfigured, false);
  await save(service, [], 7);
  value = await save(service, [profile()], 8);
  assert.equal(value.profiles[0].credentialConfigured, false);
});

test("CAS serializes concurrent whole-config saves without key mutation on stale revision", async t => {
  const { service } = await fixture(t);
  const results = await Promise.allSettled([
    save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]),
    save(service, [profile("xiaomi", { credentialUpdate: credential("other-secret") })]),
  ]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].reason.code, "CONFLICT");
  const value = await service.read(); assert.equal(value.revision, 1); assert.equal(value.profiles[0].provider, "openai");
  assert.equal(value.profiles[0].credentialConfigured, true);
});

test("persistence failure preserves revision, profile, and session credential", async t => {
  const calls = [];
  const { service, file } = await fixture(t, async input => { calls.push(input); return response({ data: [] }); });
  await save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  const original = await fs.readFile(file);
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(save(service, [profile("xiaomi", { credentialUpdate: credential("replacement-secret") })], 1), bad("STORAGE_ERROR"));
  const value = await service.read(); assert.equal(value.revision, 1); assert.equal(value.profiles[0].provider, "openai");
  await probe(service); assert.equal(calls[0].headers.Authorization, "Bearer super-secret");
  await fs.rmdir(file); await fs.writeFile(file, original);
});

test("corrupt, oversized, unknown persisted fields fail without resetting disk", async t => {
  for (const content of ["{broken", "x".repeat(8 * 1024 * 1024 + 1), JSON.stringify({ revision: 0, profiles: [], defaults: defaults(), credential: "secret-key" })]) {
    const f = await fixture(t); await fs.mkdir(f.root); await fs.writeFile(f.file, content);
    await assert.rejects(f.service.read(), bad("STORAGE_ERROR"));
    await assert.rejects(save(f.service, []), bad("STORAGE_ERROR"));
    assert.equal(await fs.readFile(f.file, "utf8"), content);
  }
});

test("private root and config symlinks are rejected without changing their targets", async t => {
  const f = await fixture(t); const target = path.join(f.parent, "target"); await fs.mkdir(target);
  await fs.symlink(target, f.root);
  await assert.rejects(f.service.read(), bad("STORAGE_ERROR"));
  await fs.unlink(f.root); await fs.mkdir(f.root);
  const outside = path.join(target, "outside.json"); await fs.writeFile(outside, "untouched"); await fs.symlink(outside, f.file);
  await assert.rejects(f.service.read(), bad("STORAGE_ERROR"));
  await assert.rejects(save(f.service, []), bad("STORAGE_ERROR"));
  assert.equal(await fs.readFile(outside, "utf8"), "untouched");
});

test("unknown fields, bounded schemas, invalid defaults and credential fields reject", async t => {
  const { service } = await fixture(t);
  const invalid = [
    [profile("unknown")], [profile("openai", { other: true })], [profile("openai", { enabled: "yes" })],
    [profile("openai", { credentialUpdate: { action: "preserve", value: "secret-key" } })],
    [profile("openai", { credentialUpdate: credential("bad\nkey") })],
    [profile("openai", { credentialUpdate: credential("k".repeat(8193)) })],
    [profile("dreamina", { credentialUpdate: credential("secret-key") })], [profile("libtv", { credentialUpdate: credential("secret-key") })],
    [profile("openai", { name: "n".repeat(129) })], [profile("openai", { models: Array(101).fill({ id: "x", name: "x", kind: "image" }) })],
    [profile("openai", { modelId: "missing" })], [profile(), profile()], Array.from({ length: 33 }, (_, i) => profile("openai", { id: `p${i}` })),
  ];
  for (const profiles of invalid) await assert.rejects(save(service, profiles), bad("INVALID_ARGUMENT"));
  for (const selected of [{}, { ...defaults(), image: "missing" }, { ...defaults(), video: "p1" }, { ...defaults(), extra: null }]) await assert.rejects(save(service, [profile()], 0, selected), bad("INVALID_ARGUMENT"));
  await assert.rejects(save(service, [profile("openai", { enabled: false })], 0, { ...defaults(), image: "p1" }), bad("INVALID_ARGUMENT"));
  await assert.rejects(service.save({ expectedRevision: 0, profiles: [], defaults: defaults(), unknown: true }), bad("INVALID_ARGUMENT"));
  assert.equal((await service.read()).revision, 0);
});

test("URL restrictions pin official origins, reject credentials and metadata, permit safe custom endpoints", async t => {
  const { service } = await fixture(t);
  for (const [provider, baseUrl] of [
    ["openai", "http://example.com/v1"], ["openai", "https://user:secret-key@example.com"], ["openai", "https://example.com?token=secret-key"], ["openai", "https://example.com#x"],
    ["comfyui", "http://example.com:8188"], ["comfyui", "http://169.254.169.254"], ["comfyui", "https://metadata.google.internal"], ["comfyui", "http://0.0.0.0"], ["comfyui", "http://[::]"],
    ["xiaomi", "https://evil.example/v1"], ["minimax", "https://api.minimax.cn:8443/v1"], ["libtv", "https://evil.example/mcp"],
  ]) await assert.rejects(save(service, [profile(provider, { baseUrl })]), bad("INVALID_ARGUMENT"));
  let rev = 0;
  for (const [provider, baseUrl] of [["openai", "https://custom.example/v1///"], ["comfyui", "http://localhost:8188"], ["comfyui", "http://192.168.1.3:8188"], ["comfyui", "http://[::1]:8188"], ["comfyui", "https://remote.example"]]) {
    const value = await save(service, [profile(provider, { baseUrl })], rev++);
    assert.equal(value.profiles[0].baseUrl.endsWith("/"), false);
  }
});

test("workflow validation rejects credentials, prototype keys, bad bindings and size limits", async t => {
  const { service } = await fixture(t);
  const invalid = [
    { workflow: { "1": { class_type: "K", inputs: { api_key: "secret-key" } } } },
    { workflow: { "1": { class_type: "K", inputs: { url: "https://user:secret-key@example.com" } } } },
    { workflow: { "1": { class_type: "K", inputs: { url: "https://example.com?token=secret-key" } } } },
    { workflow: { "1": { class_type: "K", inputs: { text: "Authorization: Bearer secret-key" } } } },
    { workflow: JSON.parse('{"1":{"class_type":"K","inputs":{"__proto__":{}}}}') },
    { workflow: { "1": { class_type: "K", inputs: { text: "x".repeat(200 * 1024 + 1) } } } },
    { workflow: Object.fromEntries(Array.from({ length: 301 }, (_, i) => [String(i), { class_type: "K", inputs: {} }])) },
    { workflow: flow(), bindings: [{ purpose: "prompt", nodeId: "2", input: "text" }] },
    { workflow: flow(), bindings: [{ purpose: "prompt", nodeId: "1", input: "missing" }] },
    { workflow: flow(), bindings: [{ purpose: "execute", nodeId: "1", input: "text" }] },
    { workflow: flow(), bindings: Array(13).fill({ purpose: "prompt", nodeId: "1", input: "text" }) },
  ];
  for (const fields of invalid) await assert.rejects(save(service, [profile("comfyui", fields)]), bad("INVALID_ARGUMENT"));
  await assert.rejects(save(service, [profile("openai", { workflow: flow() })]), bad("INVALID_ARGUMENT"));
  const value = await save(service, [profile("comfyui", { workflow: flow(), bindings: [{ purpose: "prompt", nodeId: "1", input: "text" }] })]);
  assert.equal(value.profiles[0].bindings[0].input, "text");
});

test("OpenAI and Xiaomi use saved origin, Bearer, GET models, redirect error and bounded safe output", async t => {
  for (const provider of ["openai", "xiaomi"]) {
    const calls = [];
    const f = await fixture(t, async input => { calls.push(input); return response({ [provider === "openai" ? "data" : "models"]: [{ id: "safe-model", name: "Model" }, { id: "https://evil.example" }, { id: "super-secret" }, { id: "safe-model" }, { id: "other", name: "super-secret" }] }); });
    await save(f.service, [profile(provider, { credentialUpdate: credential("super-secret") })]);
    const result = await probe(f.service);
    assert.equal(result.status, "connected"); assert.match(result.message, /catalog.*only/);
    assert.deepEqual(result.models.map(item => item.id), ["safe-model", "other"]);
    assert.equal(JSON.stringify(result).includes("super-secret"), false);
    assert.equal(calls.length, 1); assert.equal(calls[0].method, "GET"); assert.equal(calls[0].body, undefined);
    assert.equal(calls[0].headers.Authorization, "Bearer super-secret"); assert.equal(calls[0].redirect, "error"); assert.equal(calls[0].timeoutMs, 15000);
    assert.equal(calls[0].url, `${getMediaProviderCatalog().find(item => item.id === provider).defaultBaseUrl}/models`);
    assert.deepEqual((await f.service.read()).profiles[0].lastProbe, result);
    assert.equal((await fs.readFile(f.file, "utf8")).includes("lastProbe"), false);
  }
});

test("MiniMax discovers models and safe voice fields without a selected audio model", async t => {
  const calls = [];
  const { service } = await fixture(t, async input => { calls.push(input); return response(input.url.endsWith('/models') ? { data: [{ id: 'image-cloud' }] } : { base_resp: { status_code: 0 }, system_voice: [{ voice_id: "voice1", voice_name: "Voice One", secret: "super-secret" }], voice_cloning: [{ voice_id: "voice2", name: "Voice Two" }], voice_generation: [{ voice_id: "https://bad" }] }); });
  await save(service, [profile("minimax", { credentialUpdate: credential("super-secret") })]);
  const result = await probe(service);
  assert.equal(result.status, "connected"); assert.deepEqual(result.models, [{ id: 'image-cloud', name: 'image-cloud', kind: 'image' }]);
  assert.deepEqual(result.voices, [{ id: "voice1", name: "Voice One" }, { id: "voice2", name: "Voice Two" }]);
  assert.equal(calls[1].url, "https://api.minimax.cn/v1/get_voice"); assert.equal(calls[1].method, "POST"); assert.equal(calls[1].body, '{"voice_type":"all"}');
  assert.equal(calls[1].headers["Content-Type"], "application/json");
  await save(service, [profile("minimax", { modelId: "image-01" })], 1);
  assert.equal((await probe(service, 2)).status, "connected"); assert.equal(calls.length, 4);
});

test("ComfyUI probes are serial and read-only, validate schema and workflow node availability", async t => {
  const calls = [];
  let nodes = { KSampler: { input: {} } };
  const { service } = await fixture(t, async input => { calls.push(input); return response(input.url.endsWith("system_stats") ? { system: {}, devices: [] } : nodes); });
  await save(service, [profile("comfyui", { workflow: flow(), comfyUser: "local-user" })]);
  let result = await probe(service); assert.equal(result.status, "connected"); assert.deepEqual(result.nodeTypes, ["KSampler"]);
  assert.deepEqual(calls.map(item => new URL(item.url).pathname), ["/system_stats", "/object_info"]);
  assert.ok(calls.every(item => item.method === "GET" && item.redirect === "error" && !item.body));
  assert.equal(calls[0].headers["Comfy-User"], "local-user"); assert.equal(calls[0].headers.Authorization, undefined);
  nodes = { OtherNode: { input: {} } };
  result = await probe(service); assert.equal(result.status, "unavailable"); assert.match(result.message, /missing/);
  nodes = { KSampler: "invalid" }; assert.equal((await probe(service)).status, "unavailable");
});

test("ComfyUI connection probe accepts lightweight system status without optional devices", async t => {
  const calls = [];
  const { service } = await fixture(t, async input => { calls.push(input); return response({ system: { os: "linux" } }); });
  await save(service, [profile("comfyui")]);
  const result = await probe(service);
  assert.equal(result.status, "connected");
  assert.deepEqual(result.nodeTypes, []);
  assert.equal(result.connectionStatus, "connected");
  assert.deepEqual(calls.map(item => new URL(item.url).pathname), ["/system_stats"]);
});

test("ComfyUI authentication mode selects bearer or custom header", async t => {
  const calls = [];
  const { service } = await fixture(t, async input => { calls.push(input); return response({ system: { os: "linux" } }); });
  await save(service, [profile("comfyui", { authKind: "header", headerName: "X-API-Key", credentialUpdate: credential("header-secret") })]);
  assert.equal((await probe(service)).status, "connected");
  assert.equal(calls[0].headers["X-API-Key"], "header-secret");
  assert.equal(calls[0].headers.Authorization, undefined);
  await save(service, [profile("comfyui", { authKind: "bearer", headerName: "", credentialUpdate: credential("bearer-secret") })], 1);
  assert.equal((await probe(service, 2)).status, "connected");
  assert.equal(calls[1].headers.Authorization, "Bearer bearer-secret");
  assert.equal(calls[1].headers["X-API-Key"], undefined);
});

test("invalid ComfyUI stats prevent the second request", async t => {
  let calls = 0; const { service } = await fixture(t, async () => { calls++; return response({ system: "wrong", devices: [] }); });
  await save(service, [profile("comfyui")]); assert.equal((await probe(service)).status, "unavailable"); assert.equal(calls, 1);
});

test("CLI, MCP and missing credentials return honest unsupported/unavailable without requests", async t => {
  const { service } = await fixture(t);
  let rev = 0;
  for (const provider of ["dreamina", "libtv", "openai", "xiaomi", "minimax"]) {
    await save(service, [profile(provider)], rev++);
    const result = await probe(service, rev);
    assert.equal(result.status, ["dreamina", "libtv"].includes(provider) ? "unsupported" : "unavailable");
    assert.deepEqual(result.models, []);
  }
});

test("provider errors, redirect responses, oversized bodies and malformed JSON never expose raw details", async t => {
  for (const outcome of [new Error("super-secret"), { status: 302, bodyText: "super-secret", headers: { location: "https://evil.example" } }, { status: 200, bodyText: "super-secret", headers: {} }, response({ data: "super-secret" }), { status: 200, bodyText: "x".repeat(2 * 1024 * 1024 + 1) }]) {
    let calls = 0;
    const { service } = await fixture(t, async () => { calls++; if (outcome instanceof Error) throw outcome; return outcome; });
    await save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
    const value = await probe(service); assert.equal(value.status, "unavailable"); assert.equal(JSON.stringify(value).includes("super-secret"), false); assert.equal(calls, 1);
  }
});

test("host permission code is surfaced from an allowlist without reflecting its message", async t => {
  const { service } = await fixture(t, async () => { throw Object.assign(new Error("super-secret"), { code: "PERMISSION_DENIED" }); });
  await save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  const result = await probe(service); assert.equal(result.code, "PERMISSION_DENIED"); assert.equal(JSON.stringify(result).includes("super-secret"), false);
});

test("duplicate pending probes reject and a late result after save cannot set lastProbe", async t => {
  const started = deferred(); const done = deferred();
  const { service } = await fixture(t, async () => { started.resolve(); return done.promise; });
  await save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  const running = probe(service); await started.promise;
  await assert.rejects(probe(service), bad("PROBE_PENDING"));
  await save(service, [profile("openai", { name: "Changed" })], 1);
  done.resolve(response({ data: [] })); await assert.rejects(running, bad("CONFLICT"));
  assert.equal((await service.read()).profiles[0].lastProbe, undefined);
});

test("dispose invalidates late probes and all subsequent methods", async t => {
  const started = deferred(); const done = deferred();
  const { service } = await fixture(t, async () => { started.resolve(); return done.promise; });
  await save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  const running = probe(service); await started.promise; service.dispose();
  done.resolve(response({ data: [] })); await assert.rejects(running, bad("CONFLICT"));
  await assert.rejects(service.read(), bad("DISPOSED")); await assert.rejects(save(service, []), bad("DISPOSED")); await assert.rejects(probe(service), bad("DISPOSED"));
});

test("dispose during pending storage rejects queued saves before persistence", async t => {
  const f = await fixture(t); const started = deferred(); const done = deferred(); let paths = 0;
  const service = createMediaProviderSettings({ getDataPath: async () => { paths++; if (paths === 2) { started.resolve(); await done.promise; } return f.root; }, request: f.request });
  t.after(() => service.dispose()); await service.read();
  const first = save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  const second = save(service, [], 1); const observed = Promise.allSettled([first, second]);
  await started.promise; service.dispose(); done.resolve();
  const results = await observed; assert.ok(results.every(item => item.status === "rejected" && item.reason.code === "DISPOSED"));
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});

test("disabled, unsaved and stale profiles reject probes without network", async t => {
  const { service } = await fixture(t);
  await assert.rejects(probe(service, 0), bad("NOT_FOUND"));
  await save(service, [profile("openai", { enabled: false })]);
  await assert.rejects(probe(service), bad("DISABLED")); await assert.rejects(probe(service, 0), bad("CONFLICT"));
});

test("known credentials cannot be copied into persisted public fields", async t => {
  const { service, file } = await fixture(t);
  await assert.rejects(save(service, [profile("openai", { name: "super-secret", credentialUpdate: credential("super-secret") })]), bad("INVALID_ARGUMENT"));
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  await save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  await assert.rejects(save(service, [profile("openai", { name: "super-secret" })], 1), bad("INVALID_ARGUMENT"));
  assert.equal((await fs.readFile(file, "utf8")).includes("super-secret"), false);
});

test("JSON escaping cannot hide a credential copied into a public field", async t => {
  const { service } = await fixture(t);
  const secret = 'escaped"credential\\value';
  await assert.rejects(save(service, [profile("openai", { name: secret, credentialUpdate: credential(secret) })]), bad("INVALID_ARGUMENT"));
});

test("discovery output caps model and node summaries", async t => {
  const f = await fixture(t, async () => response({ data: Array.from({ length: 150 }, (_, i) => ({ id: `model${i}` })) }));
  await save(f.service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  assert.equal((await probe(f.service)).models.length, 100);
  const c = await fixture(t, async input => response(input.url.endsWith("system_stats") ? { system: {}, devices: [] } : Object.fromEntries(Array.from({ length: 350 }, (_, i) => [`Node${i}`, { input: {} }]))));
  await save(c.service, [profile("comfyui", { workflow: flow() })]);
  assert.equal((await probe(c.service)).nodeTypes.length, 300);
});

test("saving during ComfyUI stats invalidates the response before object_info is requested", async t => {
  const started = deferred(); const done = deferred(); let calls = 0;
  const { service } = await fixture(t, async () => { calls++; started.resolve(); return done.promise; });
  await save(service, [profile("comfyui")]);
  const running = probe(service); await started.promise;
  await save(service, [profile("comfyui", { name: "Updated" })], 1);
  done.resolve(response({ system: {}, devices: [] }));
  await assert.rejects(running, bad("CONFLICT")); assert.equal(calls, 1);
});

test("remote HTTPS supports IPv6 and internal hosts while wildcard and metadata addresses reject", async t => {
  const { service } = await fixture(t);
  for (const baseUrl of ["https://*.example.com", "https://100.100.100.200", "https://[fd00:ec2::254]", "https://[::ffff:169.254.169.254]"]) {
    await assert.rejects(save(service, [profile("comfyui", { baseUrl })]), bad("INVALID_ARGUMENT"));
  }
  await save(service, [profile("comfyui", { baseUrl: "https://[2001:db8::1]:8188" })]);
  await save(service, [profile("comfyui", { baseUrl: "https://comfy.company.internal" })], 1);
});

test("awaited disposal drains an issued atomic rename before the next instance reads", async t => {
  const { service, root } = await fixture(t);
  const entered = deferred(), release = deferred(), disposing = deferred();
  const originalRename = fs.rename;
  fs.rename = async (...args) => { if (args[1] === path.join(root, "aimedia-settings.json")) { entered.resolve(); await release.promise; } return originalRename(...args); };
  t.after(() => { fs.rename = originalRename; release.resolve(); });
  const saving = save(service, [profile("openai", { credentialUpdate: credential("super-secret") })]);
  const rejected = assert.rejects(saving, bad("DISPOSED"));
  await entered.promise;
  let finished = false;
  const draining = Promise.resolve(service.dispose()).then(() => { finished = true; disposing.resolve(); });
  try {
    await Promise.resolve(); await Promise.resolve();
    assert.equal(finished, false, "Disposal must not finish before the pending rename");
  } finally { release.resolve(); await rejected; await draining; }
  const reloaded = createMediaProviderSettings({ getDataPath: () => root, request: async () => { throw Error("No network"); } });
  const state = await reloaded.read();
  assert.equal(state.revision, 1);
  assert.equal(state.profiles[0].credentialConfigured, true);
  await save(reloaded, [], 1);
  assert.equal((await reloaded.read()).revision, 2);
  await reloaded.dispose();
});

for (const provider of ["dreamina", "libtv"]) {
  test(`${provider} singleton saves reject new duplicates while preserving defaults and other providers`, async t => {
    const { service } = await fixture(t);
    assert.deepEqual((await service.read()).singletonConflicts, []);
    await assert.rejects(save(service, [profile(provider), profile(provider, { id: "p2" })]), bad("INVALID_ARGUMENT"));
    const selected = { ...defaults(), image: "p1" };
    const saved = await save(service, [profile(provider), profile("openai", { id: "o1" }), profile("openai", { id: "o2" })], 0, selected);
    assert.deepEqual(saved.defaults, selected); assert.deepEqual(saved.singletonConflicts, []);
    assert.equal(saved.profiles.length, 3);
    await assert.rejects(save(service, [profile(provider), profile(provider, { id: "p2", enabled: false })], 1), bad("INVALID_ARGUMENT"));
    assert.equal((await service.read()).revision, 1);
  });

  test(`${provider} legacy duplicates read intact, edit and reduce without ID replacement evasion`, async t => {
    const f = await fixture(t);
    const profiles = ["p1", "p2", "p3"].map(id => profile(provider, { id }));
    const selected = { ...defaults(), image: "p2" };
    const raw = JSON.stringify({ revision: 5, profiles, defaults: selected });
    await fs.mkdir(f.root); await fs.writeFile(f.file, raw);
    const read = await f.service.read();
    assert.deepEqual(read.profiles.map(item => item.id), ["p1", "p2", "p3"]);
    assert.deepEqual(read.singletonConflicts, [{ provider, profileIds: ["p1", "p2", "p3"] }]);
    assert.equal(await fs.readFile(f.file, "utf8"), raw);
    read.singletonConflicts[0].profileIds.length = 0;
    assert.equal((await f.service.read()).singletonConflicts[0].profileIds.length, 3);
    const edited = await save(f.service, profiles.map(item => ({ ...item, name: "Edited" })), 5, selected);
    assert.deepEqual(edited.defaults, selected); assert.equal(edited.profiles.length, 3);
    for (const ids of [["p1", "p2", "new"], ["p2", "new"], ["p1", "p2", "p3", "new"]]) {
      await assert.rejects(save(f.service, ids.map(id => profile(provider, { id })), 6, selected), bad("INVALID_ARGUMENT"));
    }
    const reduced = await save(f.service, profiles.slice(0, 2), 6, selected);
    assert.deepEqual(reduced.singletonConflicts, [{ provider, profileIds: ["p1", "p2"] }]);
    // This queued save must see the reduction, not the earlier three-profile state.
    const repair = save(f.service, [profiles[1]], 7, selected);
    const evade = save(f.service, profiles.slice(0, 2), 8, selected);
    await repair; await assert.rejects(evade, bad("INVALID_ARGUMENT"));
    const final = await f.service.read();
    assert.deepEqual(final.singletonConflicts, []); assert.deepEqual(final.defaults, selected);
    assert.equal(final.profiles[0].id, "p2");
    assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).singletonConflicts, undefined);
  });
}

test("existing non-singleton IDs cannot be changed into a new legacy duplicate", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root);
  await fs.writeFile(f.file, JSON.stringify({ revision: 1, profiles: [profile("dreamina"), profile("dreamina", { id: "p2" }), profile("openai", { id: "p3" })], defaults: defaults() }));
  await assert.rejects(save(f.service, [profile("dreamina"), profile("dreamina", { id: "p3" })], 1), bad("INVALID_ARGUMENT"));
  assert.equal((await f.service.read()).profiles.length, 3);
});
