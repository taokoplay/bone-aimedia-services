"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), http = require("node:http"), os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { createPlugin } = require("../main.js");
const { createMediaProviderSettings, testSecrets } = require("./settings-service-fixture.cjs");
const { png } = require("./image-fixture.cjs");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const context = { sessionId: "reference-session", turnId: "reference-turn", mode: "agent" };
const value = reply => reply.structuredContent;
async function fixture(t, { binary = true, configureHost = () => {} } = {}) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "image-references-"));
  const data = path.join(root, "private"), workspace = path.join(root, "workspace");
  await fs.mkdir(data); await fs.mkdir(path.join(workspace, "bone-media/references"), { recursive: true });
  let currentWorkspace = workspace;
  const received = [], reads = [], tools = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: png(3, 3).toString("base64") }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const request = async input => {
    const response = await fetch(input.url, { method: input.method, headers: input.headers,
      body: input.bodyBase64 === undefined ? input.body : Buffer.from(input.bodyBase64, "base64"), redirect: "error" });
    return { status: response.status, bodyText: await response.text(), headers: {} };
  };
  const settings = createMediaProviderSettings({ getDataPath: () => data, secrets: testSecrets(), request });
  await settings.save({ expectedRevision: 0, profiles: [{ id: "gpt", name: "Reference fixture", provider: "openai", baseUrl,
    models: [{ id: "gpt-image-2", name: "GPT Image 2", kind: "image" }], credentialUpdate: { action: "replace", value: "synthetic-reference-auth" } }],
    defaults: { image: "gpt", video: null, audio: null } });
  await settings.dispose();
  const host = {
    plugin: { getDataPath: async () => data, getManifest: async () => ({ version: "reference-fixture" }) },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) },
    net: { fetch: request, getCapabilities: async () => ({ binaryRequestBody: binary, maxBinaryBodyBytes: 16 * 1024 * 1024 }) },
    workspace: { get: async () => ({ path: currentWorkspace }) },
    fs: { readPreview: async (file, options) => {
      assert.equal(options.workspacePath, currentWorkspace);
      assert.ok(file.startsWith("bone-media/references/")); reads.push(file);
      const bytes = await fs.readFile(path.join(currentWorkspace, file));
      return { kind: "image", size: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
    } },
  };
  configureHost(host);
  let plugin = createPlugin(host, () => testSecrets());
  t.after(async () => { await plugin.onUnload(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  await plugin.onLoad();
  const stage = async (name, bytes = png()) => {
    const file = `bone-media/references/${name}.png`; await fs.writeFile(path.join(workspace, file), bytes);
    return { path: file, sha256: digest(bytes) };
  };
  return { root, data, workspace, host, received, reads, stage, tools, panel: (...args) => plugin.onPanelInvoke(...args),
    switchWorkspace: next => { currentWorkspace = next; },
    call: (name, args, ctx = context) => tools.get(name).execute(args, ctx),
    reload: async () => { await plugin.onUnload(); plugin = createPlugin(host, () => testSecrets()); await plugin.onLoad(); },
  };
}
const input = referenceImages => ({ requestKey: "reference-cup", prompt: "Keep the subject from the reference images and put it on a white table.", quality: "low", referenceImages });

test("Agent reference generation sends ordered multipart bytes, returns PNG and survives restart without resubmission", async t => {
  const f = await fixture(t), first = await f.stage("subject", png(2, 2)), second = await f.stage("style", png(4, 4));
  const catalog = value(await f.call("media_catalog", { action: "list", kind: "image" }));
  assert.ok(catalog.models[0].operations.includes("image.edit"));
  assert.equal(catalog.models[0].constraints.referenceImages.supported, true);
  const result = await f.call("generate_image", input([first, second]));
  assert.equal(value(result).job?.state, "succeeded", JSON.stringify(value(result)));
  assert.equal(result.content[1].type, "image"); assert.equal(f.received.length, 1);
  const sent = f.received[0]; assert.equal(sent.url, "/v1/images/edits");
  assert.match(sent.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.equal(sent.headers.authorization, "Bearer synthetic-reference-auth");
  const body = sent.bytes.toString("latin1");
  assert.equal((body.match(/name="image\[\]"/g) || []).length, 2);
  assert.ok(sent.bytes.indexOf(png(2, 2)) < sent.bytes.indexOf(png(4, 4)));
  assert.ok(sent.bytes.includes(png(2, 2)) && sent.bytes.includes(png(4, 4)));
  assert.ok(!body.includes("input_fidelity") && !body.includes("response_format"));
  assert.ok(!body.includes(first.path));
  const saved = JSON.parse(await fs.readFile(path.join(f.data, "image-jobs", value(result).job.id + ".json"), "utf8"));
  assert.equal(saved.version, 3); assert.deepEqual(saved.request.referenceImages, [first, second]);
  assert.ok(!JSON.stringify(saved).includes(png().toString("base64")));
  await fs.unlink(path.join(f.workspace, first.path));
  await f.reload();
  const retried = value(await f.call("generate_image", input([first, second])));
  assert.equal(retried.job.id, value(result).job.id); assert.equal(retried.job.state, "succeeded");
  assert.equal(f.received.length, 1);
  assert.equal(value(await f.call("image_job", { action: "result", jobId: retried.job.id })).job.state, "succeeded");
});

test("reference identity is part of the stable request key", async t => {
  const f = await fixture(t), ref = await f.stage("subject");
  assert.equal(value(await f.call("generate_image", input([ref]))).job?.state, "succeeded");
  const changed = value(await f.call("generate_image", input([{ ...ref, sha256: "0".repeat(64) }])));
  assert.equal(changed.error.code, "GENERATION_REQUEST_CONFLICT"); assert.equal(f.received.length, 1);
});

test("old hosts keep text generation and reject references before reading or paying", async t => {
  const f = await fixture(t, { binary: false }), ref = await f.stage("subject");
  const result = value(await f.call("generate_image", input([ref])));
  assert.equal(result.error.code, "REFERENCE_UNSUPPORTED"); assert.equal(f.received.length, 0); assert.equal(f.reads.length, 0);
  const capability = await f.call("get_capabilities", {});
  assert.equal(capability.operations.find(op => op.id === "image.edit").ready, false);
  const text = value(await f.call("generate_image", { requestKey: "text-only", prompt: "A blue cup" }));
  assert.equal(text.job.state, "succeeded"); assert.equal(f.received[0].url, "/v1/images/generations");
  assert.equal(JSON.parse(f.received[0].bytes).prompt, "A blue cup");
});

test("path escape, URLs, malformed hashes, excess count and changed bytes are rejected before dispatch", async t => {
  const f = await fixture(t), ref = await f.stage("subject");
  for (const refs of [[], [{ ...ref, path: "../outside.png" }], [{ ...ref, path: "bone-media/references/../private.png" }],
    [{ ...ref, path: "https://example.test/image.png" }], [{ ...ref, path: "bone-media/references\\subject.png" }],
    [{ ...ref, sha256: "invalid" }], Array.from({ length: 17 }, () => ref)]) {
    const reply = value(await f.call("generate_image", { ...input(refs), requestKey: "invalid-" + randomUUID() }));
    assert.equal(reply.error.code, "INVALID_ARGUMENT");
  }
  const changed = value(await f.call("generate_image", input([{ ...ref, sha256: "0".repeat(64) }])));
  assert.equal(changed.error.code, "REFERENCE_CHANGED"); assert.equal(f.received.length, 0);
});

test("references modified after legacy preparation never reach the provider", async t => {
  const f = await fixture(t), ref = await f.stage("subject");
  const job = await f.call("prepare_image", { requestId: randomUUID(), profileId: "gpt", expectedRevision: 1,
    modelId: "gpt-image-2", prompt: "Use this reference", size: "1024x1024", quality: "low", referenceImages: [ref] });
  assert.equal(job.state, "prepared");
  await fs.writeFile(path.join(f.workspace, ref.path), png(5, 5));
  const final = await f.call("submit_image", { jobId: job.id, requestHash: job.requestHash, confirm: true });
  assert.equal(final.state, "failed"); assert.equal(final.charging, "not-submitted");
  assert.equal(final.error.code, "REFERENCE_CHANGED"); assert.equal(f.received.length, 0);
});

test("workspace changes after preparation cannot substitute a reference source", async t => {
  const f = await fixture(t), ref = await f.stage("subject");
  const job = await f.call("prepare_image", { requestId: randomUUID(), profileId: "gpt", expectedRevision: 1,
    modelId: "gpt-image-2", prompt: "Use this reference", size: "1024x1024", quality: "low", referenceImages: [ref] });
  f.switchWorkspace(path.join(f.root, "other-workspace"));
  const final = await f.call("submit_image", { jobId: job.id, requestHash: job.requestHash, confirm: true });
  assert.equal(final.state, "failed"); assert.equal(final.charging, "not-submitted");
  assert.equal(final.error.code, "CONFLICT"); assert.equal(f.received.length, 0);
});

test("cancelling a reference read prevents task preparation and network submission", async t => {
  const f = await fixture(t), ref = await f.stage("subject"), controller = new AbortController();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const read = f.host.fs.readPreview;
  f.host.fs.readPreview = async (...args) => { enter(); await gate; return read(...args); };
  const pending = f.call("generate_image", input([ref]), { ...context, signal: controller.signal });
  await entered; controller.abort(); release();
  assert.equal(value(await pending).error.code, "TOOL_ABORTED"); assert.equal(f.received.length, 0);
  assert.deepEqual(value(await f.call("image_job", { action: "list" })).jobs, []);
});

test("legacy reference preparation reuses the original job after staged files are removed", async t => {
  const f = await fixture(t), ref = await f.stage("subject");
  const args = { requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2",
    prompt: "Use this reference", size: "1024x1024", quality: "low", referenceImages: [ref] };
  const job = await f.call("prepare_image", args);
  const final = await f.call("submit_image", { jobId: job.id, requestHash: job.requestHash, confirm: true });
  assert.equal(final.state, "succeeded");
  await fs.unlink(path.join(f.workspace, ref.path)); await f.reload();
  const readCount = f.reads.length;
  const reused = await f.call("prepare_image", args);
  assert.equal(reused.id, job.id); assert.equal(reused.state, "succeeded");
  assert.equal(f.reads.length, readCount); assert.equal(f.received.length, 1);
  for (const changed of [{ ...args, prompt: "Different intent" },
    { ...args, referenceImages: [{ ...ref, sha256: "0".repeat(64) }] }]) {
    await assert.rejects(f.call("prepare_image", changed), { code: "GENERATION_REQUEST_CONFLICT" });
  }
  assert.equal(f.reads.length, readCount); assert.equal(f.received.length, 1);
});

test("a host workspace race during reference reads is a conflict without provider submission", async t => {
  const f = await fixture(t), ref = await f.stage("subject");
  const args = { requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2",
    prompt: "Use this reference", size: "1024x1024", quality: "low", referenceImages: [ref] };
  const job = await f.call("prepare_image", args);
  f.host.fs.readPreview = async () => {
    throw Object.assign(new Error("The host workspace changed while reading."), { code: "WORKSPACE_CHANGED" });
  };
  const final = await f.call("submit_image", { jobId: job.id, requestHash: job.requestHash, confirm: true });
  assert.equal(final.state, "failed"); assert.equal(final.charging, "not-submitted");
  assert.equal(final.error.code, "CONFLICT"); assert.equal(f.received.length, 0);
  const prepared = value(await f.call("generate_image", { ...input([ref]), requestKey: "workspace-race" }));
  assert.equal(prepared.error.code, "CONFLICT"); assert.equal(f.received.length, 0);
});

test("reference diagnostics agree across Agent and panel without blocking text generation", async t => {
  const scenarios = [
    { name: "old host", reason: "host-binary-image-input-required", configureHost: host => { delete host.net.getCapabilities; } },
    { name: "capability query failed", reason: "host-capability-query-failed", configureHost: host => {
      host.net.getCapabilities = async () => { throw Error("synthetic-capability-private-info"); };
    } },
    { name: "insufficient body limit", reason: "host-binary-body-limit-too-small", configureHost: host => {
      host.net.getCapabilities = async () => ({ binaryRequestBody: true, maxBinaryBodyBytes: 8 * 1024 * 1024 });
    } },
    { name: "invalid body limit", reason: "host-binary-body-limit-invalid", configureHost: host => {
      host.net.getCapabilities = async () => ({ binaryRequestBody: true, maxBinaryBodyBytes: "16777216" });
    } },
    { name: "scoped image reader missing", reason: "host-image-preview-api-required", configureHost: host => { delete host.fs.readPreview; } },
    { name: "workspace API missing", reason: "host-workspace-api-required", configureHost: host => { delete host.workspace.get; } },
  ];
  for (const scenario of scenarios) await t.test(scenario.name, async t => {
    const f = await fixture(t, scenario), ref = await f.stage("subject");
    const catalog = value(await f.call("media_catalog", { action: "list", kind: "image" }));
    const model = catalog.models[0], caps = await f.call("get_capabilities", {});
    const edit = caps.operations.find(operation => operation.id === "image.edit");
    const panel = await f.panel("aimedia.capabilities");
    assert.equal(model.ready, true); assert.ok(!model.operations.includes("image.edit"));
    assert.equal(edit.ready, false); assert.ok(edit.blockedBy.includes(scenario.reason));
    assert.equal(model.constraints.referenceImages.supported, false);
    assert.ok(model.constraints.referenceImages.blockedBy.includes(scenario.reason));
    assert.deepEqual(model.constraints.referenceImages, edit.constraints.referenceImages);
    assert.deepEqual(panel.operations.find(operation => operation.id === "image.edit"), edit);
    assert.equal(value(await f.call("generate_image", input([ref]))).error.code, "REFERENCE_UNSUPPORTED");
    assert.equal(f.reads.length, 0); assert.equal(f.received.length, 0);
    const text = value(await f.call("generate_image", { requestKey: "capability-text", prompt: "A blue cup" }));
    assert.equal(text.job.state, "succeeded"); assert.equal(f.received[0].url, "/v1/images/generations");
    assert.ok(!JSON.stringify([caps, catalog, panel]).includes("synthetic-capability-private-info"));
  });
});

test("reload refreshes reference support after an optional capability-query failure", async t => {
  const f = await fixture(t, { configureHost: host => {
    host.net.getCapabilities = async () => { throw Object.assign(Error("temporary failure"), { code: "UNAVAILABLE" }); };
  } }), ref = await f.stage("subject");
  assert.equal(value(await f.call("generate_image", input([ref]))).error.code, "REFERENCE_UNSUPPORTED");
  f.host.net.getCapabilities = async () => ({ binaryRequestBody: true, maxBinaryBodyBytes: 16 * 1024 * 1024 });
  await f.reload();
  const catalog = value(await f.call("media_catalog", { action: "list", kind: "image" }));
  const support = catalog.models[0].constraints.referenceImages;
  assert.equal(support.supported, true); assert.deepEqual(support.blockedBy, []);
  assert.equal(support.hostMaxBinaryBodyBytes, 16 * 1024 * 1024);
  assert.equal(support.requiredBinaryBodyBytes, 16 * 1024 * 1024);
  const result = value(await f.call("generate_image", input([ref])));
  assert.equal(result.job.state, "succeeded"); assert.equal(f.received.length, 1);
});

test("a workspace switch after the first ordered read stops before reading another reference", async t => {
  const f = await fixture(t), first = await f.stage("subject"), second = await f.stage("style", png(4, 4));
  const read = f.host.fs.readPreview;
  f.host.fs.readPreview = async (...args) => {
    const preview = await read(...args);
    if (args[0] === first.path) f.switchWorkspace(path.join(f.root, "other-workspace"));
    return preview;
  };
  const reply = value(await f.call("generate_image", input([first, second])));
  assert.equal(reply.error.code, "CONFLICT"); assert.deepEqual(f.reads, [first.path]);
  assert.equal(f.received.length, 0);
});

test("advertised binary support cannot hide a missing Host HTTP API", async t => {
  const f = await fixture(t, { configureHost: host => { delete host.net.fetch; } });
  const catalog = value(await f.call("media_catalog", { action: "list", kind: "image" }));
  const support = catalog.models[0].constraints.referenceImages;
  assert.equal(support.supported, false); assert.ok(support.blockedBy.includes("host-http-api-required"));
  assert.ok(!catalog.models[0].operations.includes("image.edit"));
  const edit = (await f.call("get_capabilities", {})).operations.find(operation => operation.id === "image.edit");
  assert.equal(edit.ready, false); assert.deepEqual(edit.constraints.referenceImages, support);
  assert.equal(f.received.length, 0); assert.equal(f.reads.length, 0);
});
