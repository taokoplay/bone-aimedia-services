"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const defaults = { image: null, video: null, audio: null };
const reply = body => ({ status: 200, bodyText: JSON.stringify(body) });
const flow = { "1": { class_type: "KSampler", inputs: {} } };
const secret = "fixture-private-credential";
async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-connection-"));
  const calls = [];
  const request = async input => { calls.push(input); return handler(input); };
  const service = createMediaProviderSettings({ getDataPath: () => root, request });
  const save = (extra = {}, expectedRevision = 0) => service.save({ expectedRevision, profiles: [{ id: "comfy", provider: "comfyui", ...extra }], defaults });
  const probe = (expectedRevision = 1) => service.probe({ profileId: "comfy", expectedRevision });
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { service, root, calls, save, probe, request };
}

test("saved connection test succeeds without loading a 4 MiB node catalog", async t => {
  const f = await fixture(t, async input => input.url.endsWith("/system_stats")
    ? reply({ system: { os: "test" }, devices: [] })
    : reply({ KSampler: { input: {}, description: "x".repeat(4 * 1024 * 1024) } }));
  await f.save({ baseUrl: "http://localhost:8189/proxy/", authKind: "none" });
  assert.equal(f.calls.length, 0);
  const result = await f.probe();
  assert.equal(result.status, "connected");
  assert.equal(result.workflowCompatible, null);
  assert.deepEqual(result.nodeTypes, []);
  assert.deepEqual(f.calls.map(c => c.url), ["http://localhost:8189/proxy/system_stats"]);
  assert.deepEqual((await f.service.read()).profiles[0].lastProbe, result);
});

test("workflow catalog failure preserves verified connection and reports a bounded cause", async t => {
  const f = await fixture(t, async input => input.url.endsWith("/system_stats")
    ? reply({ system: {}, devices: [] })
    : reply({ KSampler: { input: {}, description: "x".repeat(2 * 1024 * 1024) } }));
  await f.save({ workflow: flow });
  const result = await f.probe();
  assert.equal(result.status, "unavailable");
  assert.equal(result.connectionStatus, "connected");
  assert.equal(result.workflowCompatible, null);
  assert.equal(result.code, "RESPONSE_TOO_LARGE");
  assert.equal(result.endpoint, "object_info");
});

test("invalid system and node records cannot pass connection or workflow checks", async t => {
  for (const body of [{}, { error: "not a service" }, { system: "wrong", devices: [] }, []]) {
    const f = await fixture(t, async () => reply(body));
    await f.save();
    const result = await f.probe();
    assert.equal(result.status, "unavailable");
    assert.equal(result.code, "INVALID_RESPONSE");
  }
  const f = await fixture(t, async input => reply(input.url.endsWith("/system_stats") ? { system: {} } : { KSampler: {} }));
  await f.save({ workflow: flow });
  const result = await f.probe();
  assert.equal(result.status, "unavailable");
  assert.notEqual(result.workflowCompatible, true);
});

test("probe diagnostics distinguish HTTP, JSON, timeout, redirect and permission failures without raw data", async t => {
  const cases = [
    [{ status: 401, bodyText: secret }, "AUTHENTICATION_REQUIRED", 401],
    [{ status: 403, bodyText: secret }, "AUTHENTICATION_REQUIRED", 403],
    [{ status: 404, bodyText: secret }, "ENDPOINT_NOT_FOUND", 404],
    [{ status: 503, bodyText: secret }, "HTTP_ERROR", 503],
    [{ status: 302, bodyText: secret }, "REDIRECT_DISALLOWED", 302],
    [{ status: 200, bodyText: "<html>" + secret }, "INVALID_JSON"],
    [Object.assign(Error(secret), { code: "TIMEOUT" }), "TIMEOUT"],
    [Object.assign(Error(secret), { code: "REDIRECT_DISALLOWED" }), "REDIRECT_DISALLOWED"],
    [Object.assign(Error(secret), { code: "PERMISSION_DENIED" }), "PERMISSION_DENIED"],
    [Error(secret), "NETWORK_ERROR"],
  ];
  for (const [outcome, code, httpStatus] of cases) {
    const f = await fixture(t, async () => { if (outcome instanceof Error) throw outcome; return outcome; });
    await f.save();
    const result = await f.probe();
    assert.equal(result.status, "unavailable");
    assert.equal(result.code, code);
    assert.equal(result.httpStatus, httpStatus);
    assert.equal(result.endpoint, "system_stats");
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("legacy Bearer survives a legacy preserve save; explicit none clears it", async t => {
  const f = await fixture(t, async () => reply({ system: {} }));
  await f.save({ credentialUpdate: { action: "replace", value: secret } });
  await f.save({}, 1);
  await f.probe(2);
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${secret}`);
  const cleared = await f.save({ authKind: "none" }, 2);
  assert.equal(cleared.profiles[0].credentialConfigured, false);
  await f.probe(3);
  assert.equal(f.calls[1].headers.Authorization, undefined);
});

test("auth config and encrypted credentials survive restart while identity changes revoke them", async t => {
  const f = await fixture(t, async () => reply({ system: {} }));
  await f.save({ authKind: "header", headerName: "X-API-Key", credentialUpdate: { action: "replace", value: secret } });
  await f.save({ name: "Renamed", authKind: "header", headerName: "X-API-Key" }, 1);
  await f.probe(2);
  assert.equal(f.calls[0].headers["X-API-Key"], secret);
  const disk = await fs.readFile(path.join(f.root, "aimedia-settings.json"), "utf8");
  assert.equal(disk.includes(secret), false);
  const restarted = createMediaProviderSettings({ getDataPath: () => f.root, request: f.request });
  t.after(() => restarted.dispose());
  const stored = (await restarted.read()).profiles[0];
  assert.equal(stored.authKind, "header");
  assert.equal(stored.headerName, "X-API-Key");
  assert.equal(stored.credentialConfigured, true);
  const restored = await restarted.probe({ profileId: "comfy", expectedRevision: 2 });
  assert.equal(restored.status, "connected");
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].headers["X-API-Key"], secret);
  const changed = await f.save({ authKind: "header", headerName: "X-Other-Key" }, 2);
  assert.equal(changed.profiles[0].credentialConfigured, false);
});

test("auth schema rejects transport headers, CRLF and credentials in none mode", async t => {
  const f = await fixture(t, async () => { throw Error("Unexpected network"); });
  for (const headerName of ["Host", "Cookie", "Content-Length", "Comfy-User", "X-Key\r\nInjected", ""]) {
    await assert.rejects(f.save({ authKind: "header", headerName }), { code: "INVALID_ARGUMENT" });
  }
  await assert.rejects(f.save({ authKind: "none", credentialUpdate: { action: "replace", value: secret } }), { code: "INVALID_ARGUMENT" });
  assert.equal((await f.service.read()).revision, 0);
  await f.save({ authKind: "none" });
  await assert.rejects(f.save({ credentialUpdate: { action: "replace", value: secret } }, 1), { code: "INVALID_ARGUMENT" });
  assert.equal((await f.service.read()).revision, 1);
});
