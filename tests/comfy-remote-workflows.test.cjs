"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMediaProviderSettings } = require("../lib/media-provider-settings.js");
const { createComfyWorkflowGeneration } = require("../lib/comfy-generation.js");
const { png } = require("./image-fixture.cjs");

const defaults = { image: null, video: null, audio: null };
const profile = { id: "comfy", name: "Remote fixture", provider: "comfyui", enabled: true, baseUrl: "http://localhost:8188", authKind: "none", models: [], modelId: "", voice: "", format: "", cliPath: "", comfyUser: "", workflow: null, bindings: [], credentialUpdate: { action: "preserve" } };
const imageDefinition = text => ({
  "1": { class_type: "CLIPTextEncode", inputs: { text } },
  "2": { class_type: "SaveImage", inputs: { filename_prefix: "fixture" } },
});
const videoDefinition = text => ({
  "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text } },
  "3": { class_type: "SaveVideo", inputs: { filename_prefix: "fixture" } },
});
const canvasDefinition = { nodes: [{ id: 1, type: "CLIPTextEncode", widgets_values: ["preview only"] }], links: [] };
const response = body => ({ status: 200, bodyText: JSON.stringify(body), headers: {} });
const videoBytes = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]);
function workflowPath(pathname) { return decodeURIComponent(pathname.slice("/userdata/".length)).replace(/^workflows\//, ""); }

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "comfy-remote-"));
  const calls = [];
  const request = async input => { calls.push(input); return handler(input); };
  const service = createMediaProviderSettings({
    getDataPath: () => root,
    request,
  });
  await service.save({ expectedRevision: 0, profiles: [structuredClone(profile)], defaults, workflows: [] });
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, calls, request, service };
}

function workflowHandler(definitions, listing = Object.keys(definitions).map(path => ({ path, size: 100, modified: 1, created: 1 }))) {
  return async input => {
    const pathname = new URL(input.url).pathname;
    if (pathname === "/userdata") return response(listing);
    if (pathname.startsWith("/userdata/")) {
      const encoded = pathname.slice("/userdata/".length);
      const relative = decodeURIComponent(encoded).replace(/^workflows\//, "");
      const definition = definitions[relative];
      if (!definition) return { status: 404, bodyText: "missing" };
      return response(definition);
    }
    throw Error(`Unexpected route ${pathname}`);
  };
}

async function syncWorkflows(service, expectedRevision = 1) {
  return service.syncResources({ profileId: "comfy", expectedRevision, resource: "workflows" });
}

function binaryCapabilities(includeRequest = false) {
  return { ...(includeRequest ? { binaryRequestBody: true, maxBinaryBodyBytes: 16 * 1024 * 1024 } : {}), binaryResponseBody: true, maxResponseBodyBytes: 16 * 1024 * 1024, fetchRedirectModes: ["error"] };
}

test("remote workflow listing exposes stable names, paths, hashes and matches from local snapshots only", async t => {
  const definitions = {
    "demo.json": imageDefinition("default prompt"),
    "folder/demo.json": imageDefinition("other default"),
    "canvas.json": canvasDefinition,
  };
  const f = await fixture(t, workflowHandler(definitions));
  await syncWorkflows(f.service);
  assert.equal(f.calls.length, 1);

  const beforeDetails = await f.service.listRemoteWorkflows({ profileId: "comfy", expectedRevision: 1 });
  assert.equal(f.calls.length, 1, "listing must not fetch unsynced workflow bodies");
  assert.deepEqual(beforeDetails.workflows.map(item => item.name), ["demo", "demo", "canvas"]);
  assert.ok(beforeDetails.workflows.every(item => item.format === "unknown" && item.contentSha256 === null));

  await f.service.readResourceWorkflow({ profileId: "comfy", expectedRevision: 1, path: "demo.json" });
  await f.service.readResourceWorkflow({ profileId: "comfy", expectedRevision: 1, path: "folder/demo.json" });
  await f.service.readResourceWorkflow({ profileId: "comfy", expectedRevision: 1, path: "canvas.json" });
  const listed = await f.service.listRemoteWorkflows({ profileId: "comfy", expectedRevision: 1 });
  assert.equal(f.calls.length, 4);
  const demo = listed.workflows.filter(item => item.name === "demo");
  assert.equal(demo.length, 2);
  assert.ok(demo.every(item => item.ambiguous && item.displayName.includes(item.path) && /^remote-[a-f0-9]{32}$/.test(item.id)));
  assert.ok(demo.every(item => item.format === "api" && item.importable && item.executable && item.executableKinds.includes("image")));
  assert.ok(demo.every(item => /^[a-f0-9]{64}$/.test(item.contentSha256)));
  assert.ok(demo.every(item => item.matches.some(match => match.kind === "image" && match.suggestedOutput)));
  assert.equal(JSON.stringify(listed).includes("default prompt"), false, "default input values must not be exposed");
  const canvas = listed.workflows.find(item => item.path === "canvas.json");
  assert.equal(canvas.format, "canvas"); assert.equal(canvas.importable, false); assert.equal(canvas.executable, false); assert.deepEqual(canvas.matches, []);

  const images = await f.service.listRemoteWorkflows({ profileId: "comfy", expectedRevision: 1, kind: "image" });
  assert.deepEqual(images.workflows.map(item => item.path), ["demo.json", "folder/demo.json"]);
  assert.equal(f.calls.length, 4, "kind filtering must remain local");
  const engine = createComfyWorkflowGeneration({ getDataPath: () => f.root, settings: f.service, request: f.request, getCapabilities: async () => binaryCapabilities() });
  t.after(() => engine.dispose());
  await assert.rejects(engine.generate({ profileId: "comfy", remoteName: "demo", kind: "image", requestKey: "ambiguous-name", inputs: {}, waitMs: 0 }), { code: "WORKFLOW_NAME_AMBIGUOUS" });
  assert.equal(f.calls.length, 4, "ambiguous names must stop before reading a body or submitting");
});

test("remote API workflow executes without a local workflow and locks the synchronized content hash", async t => {
  let version = 1;
  let promptCalls = 0;
  const resultBytes = png(4, 4);
  const definitions = () => ({ "unique.json": imageDefinition(version === 1 ? "v1" : "v2") });
  const f = await fixture(t, async input => {
    const pathname = new URL(input.url).pathname;
    if (pathname === "/userdata") return response([{ path: "unique.json", size: 100, modified: version, created: 1 }]);
    if (pathname.startsWith("/userdata/") && workflowPath(pathname) === "unique.json") return response(definitions()["unique.json"]);
    if (pathname === "/prompt") { promptCalls += 1; return response({ prompt_id: "remote-prompt-1" }); }
    if (pathname === "/history/remote-prompt-1") return response({ "remote-prompt-1": { status: { status_str: "success", completed: true }, outputs: { "2": { images: [{ filename: "result.png", subfolder: "", type: "output" }] } } } });
    if (pathname === "/view") return { status: 200, bodyBase64: resultBytes.toString("base64"), byteLength: resultBytes.length, contentType: "image/png" };
    throw Error(`Unexpected route ${pathname}`);
  });
  await syncWorkflows(f.service);
  const engine = createComfyWorkflowGeneration({ getDataPath: () => f.root, settings: f.service, request: f.request, getCapabilities: async () => binaryCapabilities() });
  t.after(() => engine.dispose());
  const input = { profileId: "comfy", remoteName: "unique", kind: "image", requestKey: "remote-image-1", inputs: { prompt: "a remote prompt" }, waitMs: 1000 };
  const first = await engine.generate(input, { mode: "agent", sessionId: "s", turnId: "t" });
  assert.equal(first.state, "succeeded"); assert.equal(first.request.source, "remote"); assert.equal(first.request.remotePath, "unique.json");
  assert.match(first.request.remoteContentSha256, /^[a-f0-9]{64}$/); assert.equal(promptCalls, 1);
  const reconciled = await engine.reconcile({ jobId: first.id });
  assert.equal(reconciled.state, "succeeded"); assert.equal(promptCalls, 1, "remote reconcile must not submit a new prompt");
  assert.deepEqual((await f.service.read()).workflows, []);

  const second = await engine.generate(input, { mode: "agent", sessionId: "s", turnId: "t" });
  assert.equal(second.id, first.id); assert.equal(promptCalls, 1);

  version = 2;
  await syncWorkflows(f.service);
  await assert.rejects(engine.generate({ ...input, remotePath: "unique.json", remoteName: undefined }, { mode: "agent", sessionId: "s", turnId: "t" }), { code: "GENERATION_REQUEST_CONFLICT" });
  assert.equal(promptCalls, 1, "changed content must conflict before a second prompt");
});

test("remote canvas workflows remain preview-only and never submit", async t => {
  let prompts = 0;
  const f = await fixture(t, async input => {
    const pathname = new URL(input.url).pathname;
    if (pathname === "/userdata") return response([{ path: "canvas.json", size: 100, modified: 1, created: 1 }]);
    if (pathname.startsWith("/userdata/") && workflowPath(pathname) === "canvas.json") return response(canvasDefinition);
    if (pathname === "/prompt") { prompts += 1; return response({ prompt_id: "unexpected" }); }
    throw Error(`Unexpected route ${pathname}`);
  });
  await syncWorkflows(f.service);
  const engine = createComfyWorkflowGeneration({ getDataPath: () => f.root, settings: f.service, request: f.request, getCapabilities: async () => binaryCapabilities() });
  t.after(() => engine.dispose());
  await assert.rejects(engine.generate({ profileId: "comfy", remotePath: "canvas.json", kind: "image", requestKey: "canvas-1", inputs: {}, waitMs: 0 }), error => error.code === "WORKFLOW_INVALID" && error.message === "Remote workflow must be exported in API format before execution.");
  assert.equal(prompts, 0);
});

test("remote image-to-video uploads the staged reference before one prompt submission", async t => {
  const frame = png(2, 2);
  const frameSha256 = createHash("sha256").update(frame).digest("hex");
  const calls = [];
  const f = await fixture(t, async input => {
    calls.push(input);
    const pathname = new URL(input.url).pathname;
    if (pathname === "/userdata") return response([{ path: "video.json", size: 100, modified: 1, created: 1 }]);
    if (pathname.startsWith("/userdata/") && workflowPath(pathname) === "video.json") return response(videoDefinition("default video prompt"));
    if (pathname === "/upload/image") {
      assert.equal(typeof input.bodyBase64, "string");
      return response({ name: "frame.png", subfolder: "bone-aimedia", type: "input" });
    }
    if (pathname === "/prompt") {
      const body = JSON.parse(input.body);
      assert.equal(body.prompt["1"].inputs.image, "bone-aimedia/frame.png");
      assert.equal(body.prompt["2"].inputs.text, "walk forward");
      return response({ prompt_id: "remote-video-1" });
    }
    if (pathname === "/history/remote-video-1") return response({ "remote-video-1": { status: { status_str: "success", completed: true }, outputs: { "3": { videos: [{ filename: "result.mp4", subfolder: "", type: "output" }] } } } });
    if (pathname === "/view") return { status: 200, bodyBase64: videoBytes.toString("base64"), byteLength: videoBytes.length, contentType: "video/mp4" };
    throw Error(`Unexpected route ${pathname}`);
  });
  await syncWorkflows(f.service);
  const references = { load: async specs => { assert.deepEqual(specs, [{ path: "bone-media/references/frame.png", sha256: frameSha256 }]); return { images: [{ mimeType: "image/png", bytes: frame, sha256: frameSha256 }] }; } };
  const engine = createComfyWorkflowGeneration({ getDataPath: () => f.root, settings: f.service, request: f.request, references, getCapabilities: async () => binaryCapabilities(true) });
  t.after(() => engine.dispose());
  const job = await engine.generate({ profileId: "comfy", remotePath: "video.json", kind: "video", requestKey: "remote-video-1", inputs: { prompt: "walk forward" }, referenceImages: [{ path: "bone-media/references/frame.png", sha256: frameSha256 }], waitMs: 1000 });
  assert.equal(job.state, "succeeded");
  assert.deepEqual(calls.map(input => new URL(input.url).pathname), ["/userdata", "/userdata/workflows%2Fvideo.json", "/upload/image", "/prompt", "/history/remote-video-1", "/view"]);
});
