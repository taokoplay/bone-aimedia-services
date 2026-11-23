"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMediaProviderSettings } = require("./settings-service-fixture.cjs");
const { createComfyWorkflowGeneration } = require("../lib/comfy-generation.js");
const { png } = require("./image-fixture.cjs");

const defaults = { image: null, video: null, audio: null };
const videoBytes = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);

test("image-to-video uploads the staged reference, binds the returned input path, and submits once", async t => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-input-upload-"));
  const frame = png(2, 2);
  const frameSha256 = createHash("sha256").update(frame).digest("hex");
  const calls = [];
  const request = async input => {
    calls.push(input);
    const route = new URL(input.url).pathname;
    if (route === "/upload/image") {
      assert.equal(input.method, "POST"); assert.equal(input.responseType, undefined); assert.equal(typeof input.bodyBase64, "string");
      return { status: 200, bodyText: JSON.stringify({ name: "bone-aimedia-frame.png", subfolder: "bone-aimedia", type: "input" }) };
    }
    if (route === "/prompt") {
      const body = JSON.parse(input.body);
      assert.equal(body.prompt["1"].inputs.image, "bone-aimedia/bone-aimedia-frame.png");
      assert.equal(body.prompt["2"].inputs.text, "a person walks forward");
      return { status: 200, bodyText: JSON.stringify({ prompt_id: "video-prompt-1" }) };
    }
    if (route === "/history/video-prompt-1") {
      return { status: 200, bodyText: JSON.stringify({ "video-prompt-1": { status: { status_str: "success", completed: true }, outputs: { "3": { videos: [{ filename: "result.mp4", subfolder: "", type: "output" }] } } } }) };
    }
    if (route === "/view") return { status: 200, bodyBase64: videoBytes.toString("base64"), byteLength: videoBytes.length, contentType: "video/mp4" };
    throw Error(`unexpected ${route}`);
  };
  const settings = createMediaProviderSettings({ getDataPath: () => root, request });
  await settings.save({ expectedRevision: 0,
    profiles: [{ id: "comfy", name: "Fixture Comfy", provider: "comfyui", enabled: true, baseUrl: "http://localhost:8188", authKind: "none", models: [], modelId: "", voice: "", format: "", cliPath: "", comfyUser: "", workflow: null, bindings: [], credentialUpdate: { action: "preserve" } }],
    defaults, workflows: [{ id: "flow", name: "Fixture image to video", kind: "video", connectionId: "comfy", definition: {
      "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "default" } },
      "3": { class_type: "SaveVideo", inputs: { filename_prefix: "fixture" } },
    }, bindings: [{ purpose: "firstFrame", nodeId: "1", input: "image" }, { purpose: "prompt", nodeId: "2", input: "text" }], enabled: true, origin: "local", remote: null, executable: true, outputs: [{ kind: "video", nodeId: "3", field: "videos", index: 0 }] }] });
  const references = { load: async specs => { assert.deepEqual(specs, [{ path: "bone-media/references/frame.png", sha256: frameSha256 }]); return { images: [{ mimeType: "image/png", bytes: frame, sha256: frameSha256 }] }; } };
  const engine = createComfyWorkflowGeneration({ getDataPath: () => root, settings, request, references, getCapabilities: async () => ({ binaryRequestBody: true, maxBinaryBodyBytes: 16 * 1024 * 1024, binaryResponseBody: true, maxResponseBodyBytes: 16 * 1024 * 1024, fetchRedirectModes: ["error"] }) });
  t.after(async () => { await engine.dispose(); await settings.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const input = { workflowId: "flow", kind: "video", requestKey: "frame-to-video-1", inputs: { prompt: "a person walks forward" }, referenceImages: [{ path: "bone-media/references/frame.png", sha256: frameSha256 }], waitMs: 1000 };
  const first = await engine.generate(input, { mode: "agent", sessionId: "s", turnId: "t" });
  assert.equal(first.state, "succeeded"); assert.equal(first.result.kind, "video");
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/upload/image").length, 1);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/prompt").length, 1);
  const second = await engine.generate(input, { mode: "agent", sessionId: "s", turnId: "t" });
  assert.equal(second.id, first.id);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/upload/image").length, 1);
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/prompt").length, 1);
});

test("image-to-video refuses reference upload before network when binary request support is absent", async t => {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-input-upload-unsupported-"));
  const frame = png(1, 1); const sha256 = createHash("sha256").update(frame).digest("hex"); let requests = 0;
  const settings = createMediaProviderSettings({ getDataPath: () => root, request: async () => { requests++; return { status: 500, bodyText: "" }; } });
  await settings.save({ expectedRevision: 0, profiles: [{ id: "comfy", name: "Fixture", provider: "comfyui", enabled: true, baseUrl: "http://localhost:8188", authKind: "none", models: [], modelId: "", voice: "", format: "", cliPath: "", comfyUser: "", workflow: null, bindings: [], credentialUpdate: { action: "preserve" } }], defaults, workflows: [{ id: "flow", name: "Fixture", kind: "video", connectionId: "comfy", definition: { "1": { class_type: "LoadImage", inputs: { image: "x.png" } } }, bindings: [{ purpose: "firstFrame", nodeId: "1", input: "image" }], enabled: true, origin: "local", remote: null, executable: true, outputs: [{ kind: "video", nodeId: "1", field: "videos", index: 0 }] }] });
  const engine = createComfyWorkflowGeneration({ getDataPath: () => root, settings, request: async () => { requests++; return { status: 200, bodyText: "{}" }; }, references: { load: async () => ({ images: [{ mimeType: "image/png", bytes: frame, sha256 }] }) }, getCapabilities: async () => ({ binaryResponseBody: true, maxResponseBodyBytes: 16 * 1024 * 1024, fetchRedirectModes: ["error"] }) });
  t.after(async () => { await engine.dispose(); await settings.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(engine.generate({ workflowId: "flow", kind: "video", requestKey: "unsupported-1", inputs: {}, referenceImages: [{ path: "bone-media/references/frame.png", sha256 }], waitMs: 0 }), { code: "BINARY_REQUEST_UNSUPPORTED" });
  assert.equal(requests, 0);
});
