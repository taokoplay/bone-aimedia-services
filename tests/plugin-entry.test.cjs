"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const tools = new Map(), commands = new Map();
let directory, plugin, calls = [], opened = null;
const defaults = { image: null, video: null, audio: null };
const call = (name, args = {}) => tools.get(name).execute(args);
const get = () => plugin.onPanelInvoke("aimedia.get");
const clean = p => Object.fromEntries(Object.entries(p).filter(([k]) => !["credentialConfigured", "lastProbe"].includes(k)));
before(async () => {
  directory = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "aimedia-entry-"));
  globalThis.pi = {
    plugin: { getDataPath: async () => directory, getManifest: async () => JSON.parse(await fs.readFile(path.join(__dirname, "../manifest.json"), "utf8")) },
    commands: { register: async c => commands.set(c.id, c), unregister: async id => commands.delete(id) },
    ui: { revealView: async input => { opened = input; } },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) },
    net: { fetch: async input => { calls.push(input); return { status: 200, headers: {}, bodyText: JSON.stringify({ data: [{ id: "mimo-v2.5-tts" }] }) }; } },
  };
  plugin = require("../main.js").createPlugin(pi, () => require("./settings-service-fixture.cjs").testSecrets()); await plugin.onLoad();
});
after(async () => { await plugin.onUnload(); delete globalThis.pi; await fs.rm(directory, { recursive: true, force: true }); });

test("plugin exposes discovery and image task contracts with honest per-operation readiness", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, "../manifest.json"), "utf8"));
  assert.equal(manifest.id, "bone.aimedia.services");
  assert.deepEqual([...tools.keys()], ["get_capabilities", "list_profiles", "list_workflows", "prepare_image", "submit_image", "get_image_job", "list_image_jobs", "read_image_result", "media_catalog", "generate_image", "image_job", "export_image_result"]);
  assert.equal(manifest.contributes.agentTools.length, 12);
  for (const descriptor of manifest.contributes.agentTools) {
    const tool = tools.get(descriptor.name); assert.deepEqual(tool.schema, descriptor.schema);
    assert.equal(tool.description, descriptor.description); assert.equal(tool.risk, ["submit_image", "generate_image"].includes(descriptor.name) ? "high" : ["prepare_image", "export_image_result"].includes(descriptor.name) ? "medium" : "low");
    assert.deepEqual(tool.planSafeActions, descriptor.planSafeActions);
  }
  const caps = await call("get_capabilities");
  assert.equal(caps.pluginId, manifest.id); assert.equal(caps.pluginVersion, manifest.version);
  assert.equal(caps.toolReachable, true); assert.equal(caps.generationImplemented, true);
  assert.equal(caps.credentialStorage, "macos-keychain-encrypted-plugin-private");
  assert.equal(caps.credentialStorageStatus.access, "unchecked");
  assert.ok(!manifest.permissions.some(p => p.startsWith("secrets.")));
  assert.ok(caps.operations.every(op => op.ready === false));
  assert.equal(caps.operations.find(op => op.id === "image.generate").execution, "native");
  assert.ok(caps.operations.filter(op => op.id !== "image.generate").every(op => op.execution === "configuration-only"));
  assert.deepEqual((await call("list_profiles")).profiles, []);
  assert.deepEqual((await call("list_workflows")).workflows, []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await fs.readdir(directory), []);
  await commands.get("bone.aimedia.services.open").run();
  assert.deepEqual(opened, { viewId: "settings" });
  assert.ok(!tools.has("submit_generation"));
  assert.ok(!manifest.permissions.includes("desktop.control"));
  assert.deepEqual(manifest.fs, { read: { root: "workspace", scope: ["bone-media/exports/**"] }, write: { root: "workspace", scope: ["bone-media/exports/**"] } });
});

test("panel save → public Agent read → explicit discovery → reload preserves configuration without secrets", async () => {
  const secret = "fixture-entry-private-key";
  const saved = await plugin.onPanelInvoke("aimedia.save", { expectedRevision: 0,
    profiles: [{ id: "voice", provider: "xiaomi", name: "Voice service", modelId: "mimo-v2.5-tts", credentialUpdate: { action: "replace", value: secret } }], defaults: { ...defaults, audio: "voice" }, workflows: [] });
  assert.equal(saved.revision, 1); assert.equal(calls.length, 0);
  const publicProfiles = await call("list_profiles", { kind: "audio" });
  assert.equal(publicProfiles.profiles.length, 1); assert.equal(publicProfiles.profiles[0].credentialConfigured, true);
  assert.equal((await call("list_profiles", { kind: "image" })).profiles.length, 0);
  assert.ok(!JSON.stringify(publicProfiles).includes(secret));
  assert.equal((await call("get_capabilities")).generationImplemented, true);
  const result = await plugin.onPanelInvoke("aimedia.probe", { profileId: "voice", expectedRevision: 1 });
  assert.equal(result.status, "connected"); assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bearer ${secret}`); assert.equal(calls[0].redirect, "error");
  assert.equal((await call("list_profiles")).profiles[0].connection.status, "connected");
  const disk = await fs.readFile(path.join(directory, "aimedia-settings.json"), "utf8");
  assert.ok(!disk.includes(secret)); assert.ok(!disk.includes("lastProbe"));
  await plugin.onUnload(); await plugin.onLoad();
  const reloaded = await call("list_profiles");
  assert.equal(reloaded.defaults.audio, "voice"); assert.equal(reloaded.profiles[0].credentialConfigured, true);
  assert.equal(reloaded.profiles[0].connection.status, "not-checked");
  assert.equal(calls.length, 1);
  assert.equal(await fs.readFile(path.join(directory, "aimedia-settings.json"), "utf8"), disk);
});

test("workflows are independent records with protected connection references and summary-only Agent reads", async () => {
  const state = await get();
  const connection = { id: "comfy", name: "Local workflow server", provider: "comfyui" };
  const workflow = { id: "wf1", name: "Image workflow", kind: "image", enabled: true, connectionId: "comfy",
    definition: { "6": { class_type: "CLIPTextEncode", inputs: { text: "fixture-private-prompt" } } },
    bindings: [{ purpose: "prompt", nodeId: "6", input: "text" }] };
  await plugin.onPanelInvoke("aimedia.save", { expectedRevision: state.revision, profiles: [...state.profiles.map(clean), connection], defaults: state.defaults, workflows: [workflow] });
  const list = await call("list_workflows", { kind: "image" });
  assert.equal(list.workflows[0].connectionId, "comfy"); assert.equal(list.workflows[0].nodeCount, 1); assert.equal(list.workflows[0].bindingCount, 1);
  assert.ok(!JSON.stringify(list).includes("fixture-private-prompt"));
  assert.deepEqual((await call("list_workflows", { kind: "audio" })).workflows, []);
  const current = await get();
  await assert.rejects(plugin.onPanelInvoke("aimedia.save", { expectedRevision: current.revision, profiles: current.profiles.filter(p => p.id !== "comfy").map(clean), defaults: current.defaults, workflows: current.workflows }), { code: "INVALID_ARGUMENT" });
  assert.deepEqual(await get(), current);
  assert.equal(calls.length, 1);
});

test("stale saves and invalid direct-tool inputs reject without writes or credential reflection", async () => {
  const state = await get();
  await assert.rejects(plugin.onPanelInvoke("aimedia.save", { expectedRevision: 0, profiles: [], defaults, workflows: [] }), { code: "CONFLICT" });
  for (const name of tools.keys()) for (const args of [null, [], { unknown: "fixture-secret" }, { kind: "video-and-audio" }]) {
    if (["media_catalog", "generate_image", "image_job", "export_image_result"].includes(name)) {
      const result = await tools.get(name).execute(args, { sessionId: "test", turnId: "test", mode: "agent" });
      assert.equal(result.structuredContent.ok, false); assert.equal(result.structuredContent.error.code, "INVALID_ARGUMENT");
      assert.ok(!JSON.stringify(result).includes("fixture-secret"));
    } else await assert.rejects(call(name, args), { code: "INVALID_ARGUMENT" });
  }
  await assert.rejects(call("get_capabilities", { kind: "image" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(plugin.onPanelInvoke("aimedia.generate", {}), { code: "NOT_FOUND" });
  assert.deepEqual(await get(), state);
  const disk = await fs.readFile(path.join(directory, "aimedia-settings.json"), "utf8");
  assert.ok(!disk.includes("fixture-secret"));
  const status = await plugin.onPanelInvoke("aimedia.status");
  assert.equal(status.generationImplemented, true); assert.deepEqual(status.errors, []);
});

test("host denial remains safe and no direct network fallback is attempted", async () => {
  const state = await get();
  const secret = "fixture-denial-key";
  await plugin.onPanelInvoke("aimedia.save", { expectedRevision: state.revision, profiles: state.profiles.map(p => ({ ...clean(p), ...(p.id === "voice" ? { credentialUpdate: { action: "replace", value: secret } } : {}) })), defaults: state.defaults, workflows: state.workflows });
  const previous = pi.net;
  pi.net = { fetch: async () => { throw Object.assign(new Error(secret), { code: "PERMISSION_DENIED" }); } };
  try {
    const result = await plugin.onPanelInvoke("aimedia.probe", { profileId: "voice", expectedRevision: (await get()).revision });
    assert.equal(result.status, "unavailable"); assert.equal(result.code, "PERMISSION_DENIED");
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal((await call("get_capabilities")).operations.every(op => !op.ready), true);
  } finally { pi.net = previous; }
});

test("a missing workflow node keeps reachable ComfyUI connection distinct from workflow compatibility", async () => {
  const state = await get();
  const workflow = { ...state.workflows[0], id: "wf-missing", name: "Missing node", definition: { "6": { class_type: "UnavailableNode", inputs: { text: "test" } } } };
  await plugin.onPanelInvoke("aimedia.save", { expectedRevision: state.revision, profiles: state.profiles.map(clean), defaults: state.defaults, workflows: [...state.workflows, workflow] });
  const prior = pi.net;
  pi.net = { fetch: async request => ({ status: 200, headers: {}, bodyText: JSON.stringify(request.url.endsWith('/system_stats') ? { system: {}, devices: [] } : { CLIPTextEncode: { input: {} } }) }) };
  try {
    const result = await plugin.onPanelInvoke("aimedia.probe", { profileId: "comfy", expectedRevision: (await get()).revision, workflowId: workflow.id });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.scope, { kind: "workflow", profileId: "comfy", workflowId: "wf-missing" });
    const profile = (await call("list_profiles")).profiles.find(p => p.id === "comfy");
    assert.equal(profile.connection.status, "connected");
    assert.deepEqual(profile.workflowCheck, { workflowId: "wf-missing", compatible: false, status: "unavailable" });
    assert.equal((await call("get_capabilities")).generationImplemented, true);
  } finally { pi.net = prior; }
});

test("panel capabilities never claim an Agent tool is reachable when registration is unavailable or denied", async () => {
  const original = pi.agent;
  for (const agent of [undefined, { registerTool: async () => { throw Error("fixture-private-registration-error"); }, unregisterTool: async () => {} }]) {
    await plugin.onUnload(); pi.agent = agent;
    try {
      await plugin.onLoad();
      const status = await plugin.onPanelInvoke("aimedia.status");
      const caps = await plugin.onPanelInvoke("aimedia.capabilities");
      assert.deepEqual(status.tools, []);
      assert.equal(caps.toolReachable, false);
      assert.ok(!JSON.stringify(status).includes("fixture-private-registration-error"));
    } finally { await plugin.onUnload(); pi.agent = original; await plugin.onLoad(); }
  }
  assert.equal((await call("get_capabilities")).toolReachable, true);
});

test("ComfyUI resource browsing through the real bridge is explicit, bounded and read-only", async () => {
  const state = await get();
  const disk = await fs.readFile(path.join(directory, "aimedia-settings.json"), "utf8");
  const previous = pi.net, requests = [];
  pi.net = { fetch: async request => {
    requests.push(request);
    assert.equal(request.method, "GET"); assert.equal(request.redirect, "error");
    const url = new URL(request.url);
    let value;
    if (url.pathname === "/models") value = ["checkpoints"];
    else if (url.pathname === "/models/checkpoints") value = ["model.safetensors"];
    else if (url.pathname === "/userdata") value = [{ path: "folder/demo.json", size: 100, modified: 1000, created: 1000 }];
    else if (decodeURIComponent(url.pathname) === "/userdata/workflows/folder/demo.json") value = { "6": { class_type: "CLIPTextEncode", inputs: { text: "test" } } };
    else if (url.pathname === "/queue") value = { queue_running: [[1, "remote-run", { prompt: "hidden-private-text" }]], queue_pending: [] };
    else if (url.pathname === "/history") value = { "remote-done": { status: { status_str: "success", completed: true }, prompt: [0, "remote-done", { token: "hidden-private-text" }], outputs: {} } };
    else throw Error("Unexpected route");
    return { status: 200, headers: {}, bodyText: JSON.stringify(value) };
  } };
  try {
    const browse = (resource, extra = {}) => plugin.onPanelInvoke("aimedia.browse", { profileId: "comfy", expectedRevision: state.revision, resource, ...extra });
    assert.equal((await browse("model-folders")).items[0].name, "checkpoints");
    assert.equal((await browse("models", { folder: "checkpoints" })).items[0].name, "model.safetensors");
    assert.equal((await browse("workflows")).items[0].path, "folder/demo.json");
    const workflow = await browse("workflow", { path: "folder/demo.json" });
    assert.equal(workflow.format, "api"); assert.equal(workflow.importable, true);
    const queue = await browse("queue"), history = await browse("history");
    assert.equal(queue.items[0].promptId, "remote-run");
    assert.equal(history.items[0].promptId, "remote-done");
    assert.ok(!JSON.stringify([queue, history]).includes("hidden-private-text"));
    const count = requests.length;
    const caps = await call("get_capabilities");
    assert.equal(caps.generationImplemented, true); assert.equal(caps.remoteInspection.taskOwnership, "server-wide-unknown");
    assert.deepEqual(caps.singletonProviders, ["dreamina", "libtv"]);
    await call("list_profiles"); await call("list_workflows");
    assert.equal(requests.length, count);
    assert.equal(await fs.readFile(path.join(directory, "aimedia-settings.json"), "utf8"), disk);
    await assert.rejects(browse("queue", { expectedRevision: state.revision - 1 }), { code: "CONFLICT" });
    assert.equal(requests.length, count);
  } finally { pi.net = previous; }
});
