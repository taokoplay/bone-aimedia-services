"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createPlugin } = require("../main.js");
const { testSecrets } = require("./settings-service-fixture.cjs");
const { validMp3 } = require("./audio-fixture.cjs");
const { png } = require("./image-fixture.cjs");
const { modelRef } = require("../lib/media-model-catalog.js");
const context = extra => ({ sessionId: "speech-session", turnId: "turn-1", mode: "agent", ...extra });
const request = extra => ({ operation: "speech", text: "你好，欢迎回来。", voiceId: "voice-fixture", requestKey: "welcome-1", waitMs: 0, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const json = body => ({ status: 200, headers: {}, bodyText: JSON.stringify(body) });
const success = () => json({ base_resp: { status_code: 0 }, data: { status: 2, audio: validMp3().toString("hex") } });
async function fixture(t, transport) {
  const parent = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "audio-entry-"));
  const dataRoot = path.join(parent, "data"), workspace = path.join(parent, "workspace ' literal");
  await fs.mkdir(dataRoot); await fs.mkdir(workspace);
  const tools = new Map(), calls = [];
  const file = relative => {
    assert.match(relative, /^bone-media\/exports\/(?:audio|image)-[a-f0-9-]+\.(?:audio\.json|image\.json|decode\.cjs|mp3|png)$/);
    return path.join(workspace, relative);
  };
  const pi = {
    plugin: { getDataPath: async () => dataRoot, getManifest: async () => require("../manifest.json") },
    commands: { register: async () => {}, unregister: async () => {} }, ui: { revealView: async () => {} },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) },
    workspace: { get: async () => ({ path: workspace }) },
    fs: { stat: async relative => { const s = await fs.stat(file(relative)); return { size: s.size }; },
      readText: relative => fs.readFile(file(relative), "utf8"),
      writeText: async (relative, text) => { const target = file(relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); } },
    net: { fetch: async input => {
      calls.push(input);
      if (input.url.endsWith("/get_voice")) return json({ base_resp: { status_code: 0 }, system_voice: [{ voice_id: "voice-fixture", voice_name: "Fixture narrator" }] });
      if (transport) return transport(input);
      if (input.url.endsWith("/t2a_v2")) return success();
      return json({ data: [{ b64_json: png().toString("base64") }] });
    } },
  };
  let plugin;
  async function reload() { await plugin?.onUnload(); plugin = createPlugin(pi, testSecrets); await plugin.onLoad(); }
  await reload();
  const profiles = [
    { id: "speech", provider: "minimax", name: "Speech fixture", models: [{ id: "speech-2.6-hd", name: "MiniMax Speech", kind: "audio" }], credentialUpdate: { action: "replace", value: "synthetic-audio-key" } },
    { id: "image", provider: "openai", name: "Image fixture", models: [{ id: "gpt-image-2", name: "GPT Image", kind: "image" }], credentialUpdate: { action: "replace", value: "synthetic-image-key" } },
  ];
  await plugin.onPanelInvoke("aimedia.save", { expectedRevision: 0, profiles, defaults: { image: "image", video: null, audio: "speech" } });
  t.after(async () => { await plugin.onUnload(); await fs.rm(parent, { recursive: true, force: true }); });
  return { calls, tools, workspace, reload,
    call: (name, args, ctx = context()) => tools.get(name).execute(args, ctx),
    panel: (channel, payload) => plugin.onPanelInvoke(channel, payload) };
}
const data = reply => reply.structuredContent;

test("Agent voice discovery -> speech -> mixed records -> verified export and restart", async t => {
  const f = await fixture(t);
  const catalog = data(await f.call("media_catalog", { action: "list", kind: "audio" }));
  assert.equal(catalog.models.length, 1); assert.deepEqual(catalog.models[0].operations, ["audio.speech"]);
  assert.equal(catalog.models[0].constraints.voiceIdRequired, true);
  assert.equal(f.calls.length, 0);
  const voices = data(await f.call("audio_voices", { modelRef: catalog.models[0].modelRef }));
  assert.equal(voices.ok, true); assert.equal(voices.voices[0].id, "voice-fixture");
  const speech = data(await f.call("generate_audio", request({ text: "你好。\n欢迎回来。" })));
  assert.equal(speech.job.state, "succeeded"); assert.equal(speech.job.kind, "audio");
  assert.equal(speech.delivery.nextAction, "export_audio_result");
  assert.equal(speech.job.result.durationMs, 288);
  assert.ok(!JSON.stringify(speech).includes("synthetic-audio-key"));
  const sent = JSON.parse(f.calls.find(call => call.url.endsWith("/t2a_v2")).body);
  assert.equal(sent.text, "你好。\n欢迎回来。"); assert.equal(sent.voice_setting.voice_id, "voice-fixture"); assert.equal(sent.output_format, "hex");
  const image = data(await f.call("generate_image", { requestKey: "cup", prompt: "A blue cup", waitMs: 0 }));
  assert.equal(image.job.state, "succeeded");
  const list = await f.panel("aimedia.records.list", {});
  assert.equal(list.jobs.length, 2); assert.equal(list.limit, 400);
  assert.deepEqual(list.jobs.map(job => job.kind).sort(), ["audio", "image"]);
  assert.equal(list.jobs.find(job => job.kind === "audio").request.text, undefined);
  const full = await f.panel("aimedia.records.get", { kind: "audio", jobId: speech.job.id });
  assert.equal(full.request.text, sent.text);
  const chunk = await f.panel("aimedia.records.read", { kind: "audio", jobId: speech.job.id, expectedSha256: speech.job.result.sha256, offset: 0 });
  assert.deepEqual(Buffer.from(chunk.base64, "base64"), validMp3());
  await assert.rejects(f.panel("aimedia.records.get", { kind: "image", jobId: speech.job.id }), { code: "INVALID_ARGUMENT" });
  const exportReply = data(await f.call("export_audio_result", { jobId: speech.job.id }));
  assert.equal(exportReply.status, "handoff-ready"); assert.equal(exportReply.mimeType, "audio/mpeg");
  const decode = spawnSync(process.execPath, [path.join(f.workspace, exportReply.decoderPath)], { cwd: f.workspace, encoding: "utf8", timeout: 10000 });
  assert.equal(decode.status, 0, decode.stderr);
  const output = JSON.parse(decode.stdout); assert.equal(output.ok, true);
  assert.deepEqual(await fs.readFile(path.join(f.workspace, output.path)), validMp3());
  assert.equal(createHash("sha256").update(validMp3()).digest("hex"), output.sha256);
  await assert.rejects(fs.stat(path.join(f.workspace, exportReply.handoffPath)), { code: "ENOENT" });
  const before = f.calls.length;
  await f.reload();
  const repeat = data(await f.call("generate_audio", request({ text: sent.text }), context({ turnId: "turn-2" })));
  assert.equal(repeat.job.id, speech.job.id); assert.equal(f.calls.length, before);
  assert.equal((await f.panel("aimedia.records.list", {})).jobs.length, 2);
  assert.equal(data(await f.call("audio_job", { action: "list" })).jobs[0].request.text, undefined);
});

test("audio tools enforce operation, explicit model, session, intent and trusted modes", async t => {
  const f = await fixture(t);
  assert.equal(data(await f.call("generate_audio", request({ operation: "effects" }))).error.code, "GENERATION_UNSUPPORTED");
  const wrong = data(await f.call("generate_audio", request({ modelRef: modelRef("image", "gpt-image-2") })));
  assert.equal(wrong.selection.status, "unavailable");
  for (const mode of ["plan", "goal"]) {
    assert.equal(data(await f.call("generate_audio", request(), context({ mode }))).error.code, "PERMISSION_DENIED");
    assert.equal(data(await f.call("audio_voices", { modelRef: modelRef("speech", "speech-2.6-hd") }, context({ mode }))).error.code, "PERMISSION_DENIED");
  }
  assert.equal(f.calls.length, 0);
  const first = data(await f.call("generate_audio", request()));
  assert.equal(first.job.state, "succeeded");
  assert.equal(data(await f.call("generate_audio", request({ voiceId: "different" }))).error.code, "GENERATION_REQUEST_CONFLICT");
  const other = context({ sessionId: "other" });
  assert.equal(data(await f.call("audio_job", { action: "get", jobId: first.job.id }, other)).error.code, "NOT_FOUND");
  assert.equal(data(await f.call("export_audio_result", { jobId: first.job.id }, other)).error.code, "NOT_FOUND");
  assert.equal(data(await f.call("audio_job", { action: "list" }, other)).jobs.length, 0);
  const local = data(await f.call("audio_job", { action: "result", jobId: first.job.id }, context({ mode: "plan" })));
  assert.equal(local.delivery.status, "export-required");
  assert.equal(f.calls.length, 1);
});

test("audio submission remains live until response persistence; records expose progress without another POST", async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await release.promise; return success(); });
  t.after(() => release.resolve());
  let finished = false;
  const work = f.call("generate_audio", request()).then(value => { finished = true; return value; });
  await entered.promise;
  assert.equal(finished, false);
  const pending = await f.panel("aimedia.records.list", {});
  assert.equal(pending.jobs[0].state, "submitting"); assert.equal(pending.jobs[0].kind, "audio");
  release.resolve();
  const completed = data(await work); assert.equal(completed.job.state, "succeeded");
  assert.equal((await f.panel("aimedia.records.list", {})).jobs[0].state, "succeeded");
  assert.equal(f.calls.length, 1);
});

test("uncertain and malformed audio outcomes remain recorded and never resubmit", async t => {
  for (const scenario of [
    { reply: () => { throw Object.assign(new Error("private provider error"), { code: "TIMEOUT" }); }, state: "unknown", code: "TIMEOUT" },
    { reply: () => json({ base_resp: { status_code: 0 }, data: { status: 2, audio: "https://private.example/result.mp3" } }), state: "result-pending", code: "RESULT_INVALID" },
  ]) {
    const f = await fixture(t, scenario.reply);
    const first = data(await f.call("generate_audio", request()));
    assert.equal(first.job.state, scenario.state); assert.equal(first.job.error.code, scenario.code);
    assert.ok(!JSON.stringify(first).includes("private provider"));
    assert.equal(data(await f.call("generate_audio", request())).job.id, first.job.id);
    await f.reload();
    assert.equal(data(await f.call("generate_audio", request())).job.id, first.job.id);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.panel("aimedia.records.list", {})).jobs[0].state, scenario.state);
  }
});

test("audio decoder rejects occupied outputs and tampered handoffs without generating again", async t => {
  const f = await fixture(t);
  const speech = data(await f.call("generate_audio", request()));
  const occupied = data(await f.call("export_audio_result", { jobId: speech.job.id }));
  const existing = Buffer.from("keep-existing-output");
  await fs.writeFile(path.join(f.workspace, occupied.outputPath), existing);
  const first = spawnSync(process.execPath, [path.join(f.workspace, occupied.decoderPath)], { cwd: f.workspace, encoding: "utf8", timeout: 10000 });
  assert.equal(first.status, 1); assert.equal(JSON.parse(first.stderr).code, "OUTPUT_EXISTS");
  assert.deepEqual(await fs.readFile(path.join(f.workspace, occupied.outputPath)), existing);
  const tampered = data(await f.call("export_audio_result", { jobId: speech.job.id }));
  const handoffPath = path.join(f.workspace, tampered.handoffPath);
  const handoff = JSON.parse(await fs.readFile(handoffPath, "utf8"));
  handoff.mimeType = "image/png";
  await fs.writeFile(handoffPath, JSON.stringify(handoff));
  const second = spawnSync(process.execPath, [path.join(f.workspace, tampered.decoderPath)], { cwd: f.workspace, encoding: "utf8", timeout: 10000 });
  assert.equal(second.status, 1); assert.equal(JSON.parse(second.stderr).code, "INVALID_HANDOFF");
  await assert.rejects(fs.stat(path.join(f.workspace, tampered.outputPath)), { code: "ENOENT" });
  assert.equal(f.calls.length, 1);
});

test("plugin entry shares the generation budget across image and speech", async t => {
  const entered = deferred(), release = deferred(); let count = 0;
  const f = await fixture(t, async input => {
    if (++count === 2) entered.resolve();
    await release.promise;
    return input.url.endsWith("/t2a_v2") ? success() : json({ data: [{ b64_json: png().toString("base64") }] });
  });
  const imageWork = f.call("generate_image", { requestKey: "shared-image", prompt: "A cup", waitMs: 0 });
  const audioWork = f.call("generate_audio", request({ requestKey: "shared-audio" }));
  try {
    await entered.promise;
    const busy = data(await f.call("generate_audio", request({ requestKey: "third-audio" })));
    assert.equal(busy.error.code, "GENERATION_BUSY");
    assert.equal(f.calls.length, 2);
  } finally { release.resolve(); await Promise.all([imageWork, audioWork]); }
  const third = data(await f.call("generate_audio", request({ requestKey: "third-audio" })));
  assert.equal(third.job.state, "succeeded"); assert.equal(f.calls.length, 3);
});
