"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { parseWorkflowDetail } = require("../lib/comfy-resources.js");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const note = "示例说明 🎬\n第一步：读取图片\n参考 https://docs.example.test/workflows?lang=zh#setup\n\t作者 @example";
const canvas = () => ({ nodes: [{ id: 1, type: "Note", title: "使用说明 🧩", widgets_values: [note] }], links: [], version: 0.4 });
const api = text => ({ "1": { class_type: "CLIPTextEncode", inputs: { text } } });
const info = { path: "demo.json", size: 300, modified: 1, created: 1 };
const reply = value => ({ status: 200, bodyText: JSON.stringify(value) });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "workflow-preview-"));
  const services = [], calls = [];
  let response = reply(canvas());
  const create = () => {
    const service = createMediaProviderSettings({ getDataPath: () => root, request: async input => {
      calls.push(input); assert.equal(input.method, "GET"); assert.equal(input.redirect, "error");
      assert.equal(input.body, undefined);
      return input.url.includes("?dir=") ? reply([info]) : response;
    } }); services.push(service); return service;
  };
  t.after(async () => { await Promise.all(services.map(service => service.dispose())); await fs.rm(root, { recursive: true, force: true }); });
  const service = create();
  await service.save({ expectedRevision: 0, profiles: [{ id: "comfy", provider: "comfyui", authKind: "none" }], defaults: { image: null, video: null, audio: null } });
  const input = { profileId: "comfy", expectedRevision: 1 };
  return { service, create, calls, root, input, setResponse: value => { response = value; },
    browse: (resource, extra) => service.browse({ ...input, resource, ...extra }),
    detail: () => service.readResourceWorkflow({ ...input, path: info.path }),
    sync: () => service.syncResources({ ...input, resource: "workflows" }) };
}

test("workflow text preserves multiline notes, HTTP links and valid emoji in canvas and API formats", () => {
  for (const [definition, format, importable] of [[canvas(), "canvas", false], [api(note), "api", true], [api("https://docs.example.test/?tokenizer=clip&signature_algorithm=ed25519"), "api", true]]) {
    const result = parseWorkflowDetail(definition, []);
    assert.deepEqual(result, { definition, format, importable });
  }
});

test("preview still refuses secrets, credential URLs, malformed Unicode and non-text controls", () => {
  for (const value of [
    "private-fixture-key", "Bearer hidden", "Basic hidden", "token=hidden", "refresh_token=hidden",
    "https://user:hidden@example.test/model", "https://example.test/?api_key=hidden", "https://example.test/?access%5Ftoken=hidden",
    "https://example.test/?q=private%2Dfixture%2Dkey", "https://example.test/#id_token=hidden",
    "https://example.test/?X-Amz-Signature=hidden", "https://example.test/?%73%69%67=hidden", "https://example.test/#access-key=hidden",
    "javascript:alert(1)", "file:///private/file", "data:text/plain,private", "\ud800", "\udfff", "bad\u0000text", "bad\u001btext",
  ]) assert.throws(() => parseWorkflowDetail(api(value), ["private-fixture-key"]), { code: "INVALID_ARGUMENT" });
  for (const definition of [{ nodes: [{ api_key: "hidden" }] }, { nodes: [], extra: { headers: {} } }, JSON.parse('{"nodes":[],"extra":{"__proto__":{}}}')]) {
    assert.throws(() => parseWorkflowDetail(definition, []), { code: "INVALID_ARGUMENT" });
  }
});

test("listed canvas detail and cached body survive restart without writes to provider configuration", async t => {
  const f = await fixture(t);
  const before = await fs.readFile(path.join(f.root, "aimedia-settings.json"), "utf8");
  await f.browse("workflows");
  const remote = await f.browse("workflow", { path: info.path });
  assert.equal(remote.status, "ok"); assert.equal(remote.format, "canvas"); assert.equal(remote.importable, false);
  assert.deepEqual(remote.definition, canvas());
  await f.sync(); const cached = await f.detail(); assert.deepEqual(cached.definition, canvas());
  const count = f.calls.length;
  await f.service.dispose(); f.setResponse({ status: 503, bodyText: "offline" });
  assert.deepEqual((await f.create().readResourceWorkflow({ ...f.input, path: info.path })).definition, canvas());
  assert.equal(f.calls.length, count);
  assert.equal(await fs.readFile(path.join(f.root, "aimedia-settings.json"), "utf8"), before);
});

test("workflow failures report safe causes, retain the directory and allow a later retry", async t => {
  const f = await fixture(t); await f.browse("workflows"); await f.sync();
  const file = path.join(f.root, "aimedia-resource-snapshots.json"), before = await fs.readFile(file, "utf8");
  const failures = [
    [{ status: 404, bodyText: "private-upstream-value" }, "WORKFLOW_NOT_FOUND", 404],
    [{ status: 401, bodyText: "private-upstream-value" }, "AUTHENTICATION_REQUIRED", 401],
    [{ status: 500, bodyText: "private-upstream-value" }, "HTTP_ERROR", 500],
    [{ status: 200, bodyText: "{private-upstream-value" }, "INVALID_JSON", undefined],
    [reply({ nodes: [{ api_key: "private-upstream-value" }] }), "WORKFLOW_INVALID", undefined],
    [reply({ nodes: [], extra: "x".repeat(200 * 1024) }), "WORKFLOW_TOO_LARGE", undefined],
  ];
  for (const [response, code, httpStatus] of failures) {
    f.setResponse(response);
    const result = await f.browse("workflow", { path: info.path });
    assert.equal(result.status, "unavailable"); assert.equal(result.code, code); assert.equal(result.httpStatus, httpStatus);
    assert.equal(result.definition, undefined); assert.ok(!JSON.stringify(result).includes("private-upstream-value"));
    await assert.rejects(f.detail(), error => error.code === code && !error.message.includes("private-upstream-value"));
    assert.equal(await fs.readFile(file, "utf8"), before);
  }
  f.setResponse(reply(canvas())); assert.equal((await f.browse("workflow", { path: info.path })).status, "ok");
  assert.equal((await f.detail()).format, "canvas");
  const count = f.calls.length, stale = await f.browse("workflow", { path: "unlisted.json" });
  assert.equal(stale.code, "RESOURCE_LIST_STALE"); assert.equal(f.calls.length, count);
});
