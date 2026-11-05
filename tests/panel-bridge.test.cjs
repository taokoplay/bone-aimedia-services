"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { testSecrets } = require("./settings-service-fixture.cjs");
const defaults = { image: null, video: null, audio: null };
const secret = "fixture-panel-bridge-private-key";

async function fixture(t, secrets = testSecrets()) {
  const directory = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "media-panel-bridge-"));
  globalThis.pi = {
    plugin: { getDataPath: async () => directory, getManifest: async () => ({ version: "0.2.1" }) },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async () => {}, unregisterTool: async () => {} },
    net: { fetch: async () => { throw Error("No network expected"); } },
  };
  const plugin = require("../main.js").createPlugin(pi, () => secrets); await plugin.onLoad();
  t.after(async () => { await plugin.onUnload(); delete globalThis.pi; await fs.rm(directory, { recursive: true, force: true }); });
  const window = { AIMedia: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, "../renderer/settings-bridge.js"), "utf8"), { window });
  const requests = [];
  const transport = { invoke: async (channel, payload) => {
    requests.push(channel);
    const detached = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
    try { return JSON.parse(JSON.stringify(await plugin.onPanelInvoke(channel, detached))); }
    catch { throw new Error("Error invoking remote method: plugin operation failed"); }
  } };
  return { directory, plugin, requests, createInvoke: window.AIMedia.createPanelInvoke, invoke: window.AIMedia.createPanelInvoke(() => transport) };
}
const saveInput = revision => ({ expectedRevision: revision, profiles: [{ id: "p1", provider: "openai", credentialUpdate: { action: "replace", value: secret } }], defaults });

test("JSON responses preserve definite errors even when transport strips Error.code", async t => {
  const f = await fixture(t, {});
  await assert.rejects(f.invoke("aimedia.save", saveInput(0)), { code: "CREDENTIAL_UNAVAILABLE" });
  assert.equal((await f.invoke("aimedia.get")).revision, 0);
  assert.equal(f.requests.filter(channel => channel === "aimedia.invoke").length, 2);
  assert.deepEqual(await fs.readdir(f.directory), []);
  const raw = await f.plugin.onPanelInvoke("aimedia.invoke", { channel: "aimedia.save", payload: saveInput(0) });
  assert.equal(raw.protocol, "aimedia.panel.v1"); assert.equal(raw.ok, false);
  assert.deepEqual(raw.error, { code: "CREDENTIAL_UNAVAILABLE" });
  assert.ok(!JSON.stringify(raw).includes(secret));
});

test("saved config, conflicts and legacy callers retain their contract", async t => {
  const f = await fixture(t);
  const saved = await f.invoke("aimedia.save", saveInput(0));
  assert.equal(saved.revision, 1); assert.equal(saved.profiles[0].credentialConfigured, true);
  await assert.rejects(f.invoke("aimedia.save", saveInput(0)), { code: "CONFLICT" });
  await assert.rejects(f.plugin.onPanelInvoke("aimedia.save", saveInput(0)), { code: "CONFLICT" });
  assert.equal((await f.plugin.onPanelInvoke("aimedia.get")).revision, 1);
  const result = await f.invoke("aimedia.get");
  assert.ok(!JSON.stringify(result).includes(secret)); assert.equal(result.encryptedCredentials, undefined);
});

test("old backend is detected with read-only status and no write fallback", async t => {
  const f = await fixture(t), calls = [];
  const invoke = f.createInvoke(() => ({ invoke: async channel => { calls.push(channel); return { version: "0.2.1" }; } }));
  await assert.rejects(invoke("aimedia.save", saveInput(0)), { code: "PLUGIN_RELOAD_REQUIRED" });
  assert.deepEqual(calls, ["aimedia.status"]);
});

test("lost save response is never retried and stays an uncertain transport failure", async t => {
  const f = await fixture(t); let writes = 0;
  const invoke = f.createInvoke(() => ({ invoke: async (channel, input) => {
    if (channel === "aimedia.status") return { panelProtocol: 1 };
    writes++;
    await f.plugin.onPanelInvoke(channel, JSON.parse(JSON.stringify(input)));
    throw new Error("Response lost");
  } }));
  await assert.rejects(invoke("aimedia.save", saveInput(0)), error => error.code === undefined);
  assert.equal(writes, 1); assert.equal((await f.plugin.onPanelInvoke("aimedia.get")).revision, 1);
});

test("malformed replies and non-media or recursive dispatch refuse safely", async t => {
  const f = await fixture(t);
  for (const payload of [null, [], { channel: "aimedia.invoke" }, { channel: "secrets.decrypt", payload: secret }, { channel: "aimedia.get", unknown: true }]) {
    const result = await f.plugin.onPanelInvoke("aimedia.invoke", payload);
    assert.equal(result.ok, false); assert.equal(result.error.code, "INVALID_ARGUMENT");
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  for (const response of [undefined, {}, { protocol: "aimedia.panel.v1", ok: false, error: { code: secret } }, { protocol: "aimedia.panel.v1", ok: true }]) {
    const invoke = f.createInvoke(() => ({ invoke: async channel => channel === "aimedia.status" ? { panelProtocol: 1 } : response }));
    await assert.rejects(invoke("aimedia.save", saveInput(0)), { code: "BRIDGE_RESPONSE_INVALID" });
  }
});

test("legacy reads return saved config without enabling mutations; retry discovers upgraded entry", async t => {
  const f = await fixture(t), calls = [];
  await f.plugin.onPanelInvoke("aimedia.save", saveInput(0));
  const expected = await f.plugin.onPanelInvoke("aimedia.get");
  let legacy = true;
  const invoke = f.createInvoke(() => ({ invoke: async (channel, payload) => {
    calls.push(channel);
    if (legacy && channel === "aimedia.status") return { version: "0.2.1" };
    assert.ok(!legacy || channel === "aimedia.get" || channel === "aimedia.capabilities" || channel === "aimedia.resourceSnapshot", "No mutation or network fallback to a legacy entry");
    return f.plugin.onPanelInvoke(channel, payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)));
  } }));
  assert.deepEqual(await invoke("aimedia.get"), expected);
  assert.equal(invoke.isReadOnly(), true);
  for (const channel of ["aimedia.save", "aimedia.probe", "aimedia.syncResources", "aimedia.readResourceWorkflow", "aimedia.dreamina.loginStart"]) {
    await assert.rejects(invoke(channel, saveInput(1)), { code: "PLUGIN_RELOAD_REQUIRED" });
  }
  assert.deepEqual(await f.plugin.onPanelInvoke("aimedia.get"), expected);
  assert.ok(!calls.includes("aimedia.invoke"));
  legacy = false; invoke.reset();
  assert.deepEqual(await invoke("aimedia.get"), expected);
  assert.equal(invoke.isReadOnly(), false);
  assert.equal((await invoke("aimedia.save", saveInput(1))).revision, 2);
});
