"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const { createComfyWorkflowGeneration } = require("../lib/comfy-generation.js");
const { png } = require("./image-fixture.cjs");
const defaults = { image: null, video: null, audio: null };

test("ComfyUI workflow generation submits once, polls history, downloads validated bytes and reuses the same request", async t => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-generation-"));
  const calls = [];
  const resultBytes = png(4, 4);
  const request = async input => {
    calls.push(input);
    const route = new URL(input.url).pathname;
    if (route === "/prompt") return { status: 200, bodyText: JSON.stringify({ prompt_id: "prompt-1" }) };
    if (route === "/history/prompt-1") return { status: 200, bodyText: JSON.stringify({ "prompt-1": { status: { status_str: "success", completed: true }, outputs: { "1": { images: [{ filename: "result.png", subfolder: "", type: "output" }] } } } }) };
    if (route === "/view") return { status: 200, bodyBase64: resultBytes.toString("base64"), byteLength: resultBytes.length, contentType: "image/png" };
    throw Error(`unexpected ${route}`);
  };
  const settings = createMediaProviderSettings({ getDataPath: () => root, request });
  await settings.save({ expectedRevision: 0,
    profiles: [{ id: "comfy", name: "Fixture Comfy", provider: "comfyui", enabled: true, baseUrl: "http://localhost:8188", authKind: "none", models: [], modelId: "", voice: "", format: "", cliPath: "", comfyUser: "", workflow: null, bindings: [], credentialUpdate: { action: "preserve" } }],
    defaults, workflows: [{ id: "flow", name: "Fixture image", kind: "image", connectionId: "comfy", definition: { "1": { class_type: "SaveImage", inputs: { filename_prefix: "fixture" } } }, bindings: [], enabled: true, origin: "local", remote: null, executable: true, outputs: [{ kind: "image", nodeId: "1", field: "images", index: 0 }] }] });
  const engine = createComfyWorkflowGeneration({ getDataPath: () => root, settings, request, getCapabilities: async () => ({ binaryResponseBody: true, maxResponseBodyBytes: 16 * 1024 * 1024, fetchRedirectModes: ["error"] }) });
  t.after(async () => { await engine.dispose(); await settings.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const input = { workflowId: "flow", kind: "image", requestKey: "fixture-1", inputs: {}, waitMs: 1000 };
  const first = await engine.generate(input, { mode: "agent", sessionId: "s", turnId: "t" });
  assert.equal(first.state, "succeeded"); assert.equal(first.remotePromptId, "prompt-1"); assert.equal(first.result.byteLength, resultBytes.length); assert.equal(first.result.kind, "image");
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/prompt").length, 1);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/view").length, 1);
  const second = await engine.generate(input, { mode: "agent", sessionId: "s", turnId: "t" });
  assert.equal(second.id, first.id); assert.equal(calls.filter(call => new URL(call.url).pathname === "/prompt").length, 1);
  const bytes = await engine.readResult({ jobId: first.id, expectedSha256: first.result.sha256 });
  assert.deepEqual(bytes.bytes, resultBytes);
});

test("ComfyUI workflows reject changed intent under the same request key", async t => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-generation-conflict-"));
  const settings = createMediaProviderSettings({ getDataPath: () => root, request: async () => ({ status: 200, bodyText: JSON.stringify({ prompt_id: "never" }) }) });
  await settings.save({ expectedRevision: 0, profiles: [{ id: "comfy", name: "Fixture", provider: "comfyui", enabled: true, baseUrl: "http://localhost:8188", authKind: "none", models: [], modelId: "", voice: "", format: "", cliPath: "", comfyUser: "", workflow: null, bindings: [], credentialUpdate: { action: "preserve" } }], defaults, workflows: [{ id: "flow", name: "Fixture", kind: "audio", connectionId: "comfy", definition: { "1": { class_type: "SaveAudio", inputs: {} } }, bindings: [], enabled: true, origin: "local", remote: null, executable: true, outputs: [{ kind: "audio", nodeId: "1", field: "audio", index: 0 }] }] });
  const engine = createComfyWorkflowGeneration({ getDataPath: () => root, settings, request: async () => ({ status: 200, bodyText: JSON.stringify({ prompt_id: "p" }) }), getCapabilities: async () => ({ binaryResponseBody: true, maxResponseBodyBytes: 16 * 1024 * 1024, fetchRedirectModes: ["error"] }) });
  t.after(async () => { await engine.dispose(); await settings.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const result = await engine.generate({ workflowId: "flow", kind: "audio", requestKey: "same", inputs: { prompt: "one" }, waitMs: 0 }, { mode: "agent", sessionId: "s", turnId: "t" });
  assert.equal(result.state, "unknown");
});

test("ComfyUI workflow inputs cannot contain the saved connection credential", async t => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-generation-secret-"));
  const secret = "fixture-comfy-secret";
  let requests = 0;
  const settings = createMediaProviderSettings({ getDataPath: () => root, request: async () => { requests += 1; return { status: 200, bodyText: JSON.stringify({ prompt_id: "unexpected" }) }; } });
  await settings.save({ expectedRevision: 0,
    profiles: [{ id: "comfy", name: "Fixture", provider: "comfyui", enabled: true, baseUrl: "http://localhost:8188", authKind: "bearer", models: [], modelId: "", voice: "", format: "", cliPath: "", comfyUser: "", workflow: null, bindings: [], credentialUpdate: { action: "replace", value: secret } }],
    defaults, workflows: [{ id: "flow", name: "Fixture", kind: "image", connectionId: "comfy", definition: { "1": { class_type: "CLIPTextEncode", inputs: { text: "default" } } }, bindings: [{ purpose: "prompt", nodeId: "1", input: "text" }], enabled: true, origin: "local", remote: null, executable: true, outputs: [{ kind: "image", nodeId: "1", field: "images", index: 0 }] }] });
  const engine = createComfyWorkflowGeneration({ getDataPath: () => root, settings, request: async () => { requests += 1; throw Error("network must not run"); }, getCapabilities: async () => ({ binaryResponseBody: true, maxResponseBodyBytes: 16 * 1024 * 1024, fetchRedirectModes: ["error"] }) });
  t.after(async () => { await engine.dispose(); await settings.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(engine.generate({ workflowId: "flow", kind: "image", requestKey: "secret-input", inputs: { prompt: secret }, waitMs: 0 }), { code: "INVALID_ARGUMENT" });
  assert.equal(requests, 0);
});
