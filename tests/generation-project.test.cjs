"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createPlugin } = require("../main.js");
const { testSecrets } = require("./settings-service-fixture.cjs");
const { createProjectCapture, parseProject } = require("../lib/generation-project.js");
const { png } = require("./image-fixture.cjs");
const { validMp3 } = require("./audio-fixture.cjs");
const ctx = (extra = {}) => ({ sessionId: "session-a", turnId: "turn-a", mode: "agent", ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "project-records-"));
  const tools = new Map(), calls = [];
  const state = { session: { sessionId: "session-a", projectPath: "/projects/original" }, workspace: { path: "/projects/original", name: "项目甲" } };
  const host = { plugin: { getDataPath: async () => root, getManifest: async () => require("../manifest.json") },
    commands: { register: async () => {}, unregister: async () => {} }, ui: { revealView: async () => {} },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) },
    session: { getActive: async () => structuredClone(state.session) }, workspace: { get: async () => structuredClone(state.workspace) },
    net: { fetch: async input => { calls.push(input); return { status: 200, bodyText: JSON.stringify(input.url.endsWith("/t2a_v2")
      ? { base_resp: { status_code: 0 }, data: { status: 2, audio: validMp3().toString("hex") } }
      : { data: [{ b64_json: png().toString("base64") }] }) }; } } };
  const plugin = createPlugin(host, testSecrets); await plugin.onLoad();
  t.after(async () => { await plugin.onUnload(); await fs.rm(root, { recursive: true, force: true }); });
  await plugin.onPanelInvoke("aimedia.save", { expectedRevision: 0, defaults: { image: "gpt", audio: "voice", video: null }, profiles: [
    { id: "gpt", name: "GPT fixture", provider: "openai", models: [{ id: "gpt-image-2", kind: "image" }], credentialUpdate: { action: "replace", value: "synthetic-project-key" } },
    { id: "voice", name: "Speech fixture", provider: "minimax", models: [{ id: "speech-2.6-hd", kind: "audio" }], credentialUpdate: { action: "replace", value: "synthetic-project-key" } },
  ] });
  return { root, state, calls, host, plugin, tools, panel: (channel, args) => plugin.onPanelInvoke(channel, args),
    call: async (name, args, context = ctx()) => (await tools.get(name).execute(args, context)).structuredContent,
    restart: async () => { await plugin.onUnload(); await plugin.onLoad(); } };
}
const imageInput = () => ({ requestId: randomUUID(), profileId: "gpt", expectedRevision: 1, modelId: "gpt-image-2", prompt: "A cup", size: "1024x1024", quality: "low" });
const audioInput = () => ({ requestId: randomUUID(), profileId: "voice", expectedRevision: 1, modelId: "speech-2.6-hd", operation: "speech", text: "你好", voiceId: "fixture-voice" });

test("panel image/audio project snapshots survive generation, project switches and restart", async t => {
  const f = await fixture(t);
  const imageRequest = imageInput();
  const image = await f.panel("aimedia.image.prepare", imageRequest);
  f.state.workspace = { path: "/projects/second", name: "项目乙" }; f.state.session.projectPath = f.state.workspace.path;
  const audio = await f.panel("aimedia.audio.prepare", audioInput());
  assert.equal((await f.panel("aimedia.image.prepare", imageRequest)).id, image.id);
  assert.equal(image.project, undefined, "existing image response shape stays compatible");
  await f.tools.get("submit_image").execute({ jobId: image.id, requestHash: image.requestHash, confirm: true });
  const audioResponse = await f.call("generate_audio", { requestKey: "speech-agent", operation: "speech", text: "Hello", voiceId: "fixture-voice" });
  assert.equal(audioResponse.job.state, "succeeded");
  f.state.workspace = { path: "/projects/third", name: "项目丙" }; f.state.session.projectPath = f.state.workspace.path;
  await f.restart();
  const jobs = (await f.panel("aimedia.records.list", {})).jobs;
  assert.equal(jobs.find(j => j.id === image.id).project.name, "项目甲");
  assert.equal(jobs.find(j => j.id === audio.id).project.name, "项目乙");
  assert.equal(jobs.find(j => j.id === audioResponse.job.id).project.name, "项目乙");
  assert.equal((await f.panel("aimedia.records.get", { kind: "image", jobId: image.id })).project.name, "项目甲");
  assert.equal((await f.panel("aimedia.audio.get", { jobId: audio.id })).project, undefined);
  const sidecar = await fs.readFile(path.join(f.root, "image-jobs", image.id + ".project.json"), "utf8");
  assert.ok(!sidecar.includes("/projects") && !sidecar.includes("session-a"));
  assert.equal((await fs.stat(path.join(f.root, "image-jobs", image.id + ".project.json"))).mode & 0o777, 0o600);
});

test("Agent image/audio retain the original project on repeated request keys", async t => {
  const f = await fixture(t);
  for (const [name, input, kind] of [["generate_image", { requestKey: "image-a", prompt: "A cup" }, "image"], ["generate_audio", { requestKey: "speech-a", operation: "speech", text: "Hello", voiceId: "fixture" }, "audio"]]) {
    f.state.session = { sessionId: "session-a", projectPath: "/projects/original" }; f.state.workspace = { path: "/projects/original", name: "原项目" };
    const first = await f.call(name, input); assert.equal(first.job.state, "succeeded");
    const before = f.calls.length;
    f.state.session = { sessionId: "session-b", projectPath: "/projects/other" }; f.state.workspace = { path: "/projects/other", name: "其他项目" };
    const again = await f.call(name, input, ctx({ turnId: "turn-b" }));
    assert.equal(again.job.id, first.job.id); assert.equal(f.calls.length, before);
    assert.equal((await f.panel("aimedia.records.get", { kind, jobId: first.job.id })).project.name, "原项目");
    const background = await f.call(name, { ...input, requestKey: input.requestKey + "-background" });
    assert.equal(background.job.state, "succeeded");
    assert.equal((await f.panel("aimedia.records.get", { kind, jobId: background.job.id })).project.status, "unknown");
  }
});

test("legacy records remain byte-identical and cannot inherit the currently selected project", async t => {
  const f = await fixture(t), input = imageInput();
  const job = await f.panel("aimedia.image.prepare", input);
  const folder = path.join(f.root, "image-jobs"), filename = path.join(folder, job.id + ".json");
  await fs.unlink(path.join(folder, job.id + ".project.json")); // Model a pre-upgrade task.
  const before = await fs.readFile(filename);
  assert.equal((await f.panel("aimedia.records.list", {})).jobs[0].project.status, "unknown");
  await f.panel("aimedia.image.prepare", input);
  assert.equal((await f.panel("aimedia.records.list", {})).jobs[0].project.status, "unknown");
  assert.deepEqual(await fs.readFile(filename), before);
  await assert.rejects(fs.stat(path.join(folder, job.id + ".project.json")), { code: "ENOENT" });
  assert.equal(f.calls.length, 0);
});

test("project metadata rejects forged input, wrong bindings and symlink files", async t => {
  const f = await fixture(t);
  await assert.rejects(f.panel("aimedia.image.prepare", { ...imageInput(), project: { status: "project", name: "forged" } }), { code: "INVALID_ARGUMENT" });
  const job = await f.panel("aimedia.image.prepare", imageInput());
  const file = path.join(f.root, "image-jobs", job.id + ".project.json");
  const value = JSON.parse(await fs.readFile(file, "utf8")); value.binding = "0".repeat(64); await fs.writeFile(file, JSON.stringify(value));
  await assert.rejects(f.panel("aimedia.records.get", { kind: "image", jobId: job.id }), { code: "STORAGE_ERROR" });
  await fs.unlink(file); await fs.symlink(path.join(f.root, "image-jobs", job.id + ".json"), file);
  await assert.rejects(f.panel("aimedia.records.list", {}), { code: "STORAGE_ERROR" });
  assert.equal((await f.panel("aimedia.image.get", { jobId: job.id })).state, "prepared");
  assert.equal(f.calls.length, 0);
});

test("capture separates temporary sessions, unknown context and folder display fallback", async () => {
  const state = { sessionId: "session-a", projectPath: "/projects/folder-name" };
  const capture = createProjectCapture({ session: { getActive: async () => ({ ...state }) }, workspace: { get: async () => ({ path: "/unrelated", name: "Wrong" }) } });
  assert.deepEqual(await capture(ctx()), { status: "project", name: "folder-name" });
  state.projectPath = null;
  assert.deepEqual(await capture(ctx()), { status: "none" });
  assert.deepEqual(await capture(ctx({ sessionId: "different" })), { status: "unknown" });
  assert.deepEqual(await createProjectCapture({})(), { status: "unknown" });
  assert.deepEqual(await createProjectCapture({ workspace: { get: async () => null } })(), { status: "none" });
  const long = "名".repeat(200);
  const named = await createProjectCapture({ workspace: { get: async () => ({ path: "C:\\Projects\\Sample", name: long }) } })();
  assert.equal([...named.name].length, 128); assert.ok(named.name.endsWith("…")); parseProject(named);
  assert.throws(() => parseProject({ status: "project", name: "/private/path" }));
});

test("project switch or cancellation during capture cannot assign another session", async () => {
  let reads = 0;
  const capture = createProjectCapture({ session: { getActive: async () => ({ sessionId: ++reads === 1 ? "session-a" : "session-b", projectPath: "/projects/a" }) }, workspace: { get: async () => ({ path: "/projects/a", name: "Wrong after switch" }) } });
  assert.deepEqual(await capture(ctx()), { status: "unknown" });
  const controller = new AbortController();
  const cancelled = createProjectCapture({ session: { getActive: async () => ({ sessionId: "session-a", projectPath: "/projects/a" }) }, workspace: { get: async () => { controller.abort(); return { path: "/projects/a", name: "A" }; } } });
  await assert.rejects(cancelled(ctx({ signal: controller.signal })), { code: "TOOL_ABORTED" });
});
