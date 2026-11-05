"use strict";
// Start a real plugin with isolated storage and synthetic provider responses.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const root = path.resolve(__dirname, "..");
(async () => {
  const temporary = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "aimedia-ui-"));
  const tools = new Map();
  let network = 0, mode = "normal", backend = "normal";
  let releaseImage = null, releaseAudio = null;
  const perKind = { image: 0, audio: 0, voices: 0, other: 0 };
  const calls = {};
  const crypto = require("./settings-service-fixture.cjs").testSecrets();
  const secrets = { ...crypto };
  globalThis.pi = {
    plugin: { getDataPath: async () => temporary, getManifest: async () => JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8")) },
    commands: { register: async () => {}, unregister: async () => {} }, ui: { revealView: async () => {} },
    agent: { registerTool: async t => tools.set(t.name, t), unregisterTool: async name => tools.delete(name) },
    net: { fetch: async input => {
      network++;
      const route = new URL(input.url).pathname;
      perKind[route.endsWith('/images/generations') ? 'image' : route.endsWith('/t2a_v2') ? 'audio' : route.endsWith('/get_voice') ? 'voices' : 'other']++;
      if (input.redirect !== "error") throw Error("Expected redirect refusal");
      if (mode === "denied") throw Object.assign(new Error("fixture-private-key"), { code: "PERMISSION_DENIED" });
      if (mode === "invalid") return { status: 200, headers: {}, bodyText: "invalid" };
      if (mode === "unsupported") return { status: 404, headers: {}, bodyText: "Not supported" };
      if (mode === "timeout") throw Object.assign(new Error("fixture-private-key"), { code: "TIMEOUT" });
      if (mode === "unauthorized" || mode === "require-header" && input.headers["X-API-Key"] !== "fixture-key-for-browser" || mode === "require-bearer" && input.headers.Authorization !== "Bearer fixture-key-for-browser") return { status: 401, headers: {}, bodyText: "fixture-private-key" };
      const reply = value => ({ status: 200, headers: {}, bodyText: JSON.stringify(value) });
      if (route.endsWith('/images/generations')) {
        if (mode === 'image-held') return new Promise(resolve => {
          if (releaseImage) throw Error('Only one held image fixture is supported');
          releaseImage = outcome => { releaseImage = null; resolve(outcome === 'failed' ? { status: 401, headers: {}, bodyText: '{}' } : reply({ data: [{ b64_json: require('./image-fixture.cjs').png(32, 32).toString('base64') }] })); };
        });
        if (mode === 'image-timeout') throw Object.assign(Error('Synthetic generation timeout'), { code: 'TIMEOUT' });
        if (mode === 'image-invalid') return reply({ data: [{ b64_json: Buffer.from('invalid-image').toString('base64') }] });
        if (mode === 'image-url') return reply({ data: [{ url: 'https://fixture.invalid/result.png?token=private' }] });
        if (mode === 'image-success') return reply({ data: [{ b64_json: require('./image-fixture.cjs').png(32, 32).toString('base64') }] });
        throw Error('Image generation fixture requires an explicit mode');
      }
      if (route.endsWith('/t2a_v2')) {
        const body = JSON.parse(input.body);
        if (input.method !== 'POST' || body.stream !== false || body.output_format !== 'hex' || body.audio_setting?.format !== 'mp3' || !body.voice_setting?.voice_id) throw Error('Invalid speech fixture request');
        const success = () => reply({ base_resp: { status_code: 0 }, data: { status: 2, audio: require('./audio-fixture.cjs').validMp3().toString('hex') } });
        if (mode === 'audio-held') return new Promise(resolve => {
          if (releaseAudio) throw Error('Only one held audio fixture is supported');
          releaseAudio = outcome => { releaseAudio = null; resolve(outcome === 'failed' ? reply({ base_resp: { status_code: 1004 } }) : success()); };
        });
        if (mode === 'audio-success') return success();
        if (mode === 'audio-timeout') throw Object.assign(Error('Synthetic speech timeout'), { code: 'TIMEOUT' });
        if (mode === 'audio-invalid') return reply({ base_resp: { status_code: 0 }, data: { status: 2, audio: Buffer.from('invalid-audio').toString('hex') } });
        if (mode === 'audio-failed') return reply({ base_resp: { status_code: 1004 } });
        if (mode === 'audio-rate') return reply({ base_resp: { status_code: 1002 } });
        if (mode === 'audio-unknown') return reply({ base_resp: { status_code: 1000 } });
        throw Error('Speech fixture requires an explicit mode');
      }
      if (new URL(input.url).hostname === 'api.minimax.cn' && route.endsWith('/models')) {
        if (mode === 'minimax-models-failed') return { status: 404, headers: {}, bodyText: 'fixture-private-key' };
        return reply({ data: mode === 'minimax-chat-only' ? [{ id: 'MiniMax-M2.7' }] : [{ id: 'image-cloud-fixture', name: '云端图片' }, { id: 'MiniMax-Hailuo-cloud-fixture' }, { id: 'speech-cloud-fixture' }, { id: 'image-01' }, { id: 'image-01' }, { id: 'MiniMax-M2.7' }] });
      }
      if (mode === 'minimax-voices-failed' && route.endsWith('/get_voice')) return { status: 500, headers: {}, bodyText: 'fixture-private-key' };
      if (route.endsWith("/system_stats")) return reply({ system: { os: "fixture" }, devices: [{ name: "Test device" }] });
      if (route.endsWith("/object_info") && mode === "large-nodes") return reply({ KSampler: { input: {}, description: "x".repeat(4 * 1024 * 1024) } });
      if (route.endsWith("/object_info")) return reply({ KSampler: { input: {} }, CLIPTextEncode: { input: {} }, EmptyLatentImage: { input: {} } });
      if (route.endsWith("/get_voice")) return reply({ base_resp: { status_code: 0 }, system_voice: [{ voice_id: "fixture-voice", voice_name: "测试音色" }] });
      if (mode === "many-models" && route === "/models") return reply(Array.from({ length: 30 }, (_, i) => `folder-${i + 1}`));
      if (mode === "many-models" && route.startsWith("/models/")) return reply(Array.from({ length: 40 }, (_, i) => `${route.split("/").pop()}-model-${i + 1}.safetensors`));
      if (new URL(input.url).hostname === "127.0.0.1" && route === "/models") return reply(["checkpoints", "loras", "vae"]);
      if (route.startsWith("/models/")) return reply(["fixture-model.safetensors", "nested/模型.safetensors"]);
      if (route === "/userdata") return reply([{ path: "demo.json", size: 128, modified: 1700000000, created: 1690000000 }, { path: "canvas.json", size: 180, modified: 1700000010, created: 1690000000 }]);
      if (route.startsWith("/userdata/")) {
        if (mode === "workflow-sensitive") return reply({ nodes: [{ api_key: "fixture-private-key" }] });
        if (mode === "workflow-large") return reply({ nodes: [], extra: "x".repeat(200 * 1024) });
        return reply(decodeURIComponent(route).endsWith("canvas.json") ? { nodes: [{ id: 1, type: "Note", widgets_values: ["使用说明 🎬\n参考 https://docs.example.test/workflows\n<img src=x onerror=window.__workflowExecuted=1>"] }], links: [] } : { "1": { class_type: "CLIPTextEncode", inputs: { text: "Demo prompt" } } });
      }
      if (route === "/queue") return reply({ queue_running: [[1, "remote-running", { sensitivePrompt: "fixture-private-prompt" }, { headers: { Authorization: "fixture-private-key" } }]], queue_pending: [[2, "remote-pending", { sensitivePrompt: "fixture-private-prompt" }]] });
      if (route === "/history") return reply({ "remote-complete": { status: { status_str: "success", completed: true }, outputs: { "9": { images: [{ filename: "fixture.png", subfolder: "", type: "output" }] } }, prompt: [0, "remote-complete", { secret: "fixture-private-prompt" }] } });
      if (route.endsWith("/models")) return reply({ data: [{ id: "gpt-image-1" }, { id: "mimo-v2.5-tts" }, { id: "fixture-model" }] });
      throw Error("Unexpected fixture route");
    } },
  };
  const plugin = require(path.join(root, "main.js")).createPlugin(pi, () => secrets); await plugin.onLoad();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/bridge") {
        let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 1024 * 1024) throw Error("Payload limit"); }
        const { channel, payload } = JSON.parse(raw);
        let result;
        if (channel === 'fixture.metrics') result = { network, requestCount: network, perKind, calls, tools: [...tools.keys()], unchanged: true };
        else if (channel === "fixture.imageRelease") { if (!["success", "failed"].includes(payload?.outcome)) throw Error("Invalid image fixture outcome"); if (!releaseImage) throw Error("No image fixture is pending"); releaseImage(payload.outcome); result = { ok: true }; }
        else if (channel === 'fixture.audioRelease') { if (!['success', 'failed'].includes(payload?.outcome)) throw Error('Invalid audio fixture outcome'); if (!releaseAudio) throw Error('No audio fixture is pending'); releaseAudio(payload.outcome); result = { ok: true }; }
        else if (channel === "fixture.restart") { await plugin.onUnload(); await plugin.onLoad(); result = { ok: true }; }
        else if (channel === "fixture.backend") {
          if (!["normal", "legacy", "offline"].includes(payload?.mode)) throw Error("Invalid backend mode");
          backend = payload.mode; result = { ok: true };
        }
        else if (channel === "fixture.secrets") {
          if (!["normal", "unavailable", "failed", "denied"].includes(payload?.mode)) throw Error("Invalid crypto mode");
          secrets.encrypt = payload.mode === "unavailable" ? undefined : payload.mode === "normal" ? crypto.encrypt : async () => { throw Object.assign(Error("fixture-private-key"), { code: payload.mode === "denied" ? "PERMISSION_DENIED" : "FAILED" }); };
          secrets.decrypt = payload.mode === "unavailable" ? undefined : payload.mode === "normal" ? crypto.decrypt : async () => { throw Object.assign(Error("fixture-private-key"), { code: payload.mode === "denied" ? "PERMISSION_DENIED" : "FAILED" }); };
          result = { ok: true };
        }
        else if (channel === "fixture.network") { if (!["normal", "invalid", "denied", "unsupported", "timeout", "unauthorized", "require-header", "require-bearer", "large-nodes", "many-models", "minimax-models-failed", "minimax-voices-failed", "minimax-chat-only", "workflow-sensitive", "workflow-large", "image-success", "image-timeout", "image-invalid", "image-url", "image-held", "audio-success", "audio-held", "audio-failed", "audio-rate", "audio-timeout", "audio-invalid", "audio-unknown"].includes(payload?.mode)) throw Error("Invalid mode"); mode = payload.mode; result = { ok: true }; }
        else if (channel === "fixture.tool") { const tool = tools.get(payload?.name); if (!tool) throw Error("Unknown tool"); result = await tool.execute(payload.args, { sessionId: 'synthetic-browser-session', turnId: 'synthetic-browser-turn', mode: 'agent' }); }
        else if (channel === "app.getAppearance") result = { base: "dark", theme: "dark", locale: "zh-CN" };
        else if (channel === "clipboard.writeText") result = { ok: true };
        else {
          if (backend === "offline") throw Error("Fixture backend unavailable");
          if (backend === "legacy" && channel === "aimedia.invoke") throw Error("Legacy entry has no structured protocol");
          const operation = channel === 'aimedia.invoke' ? payload?.channel : channel;
          calls[operation] = (calls[operation] || 0) + 1;
          result = await plugin.onPanelInvoke(channel, payload);
          if (backend === "legacy" && channel === "aimedia.status") delete result.panelProtocol;
        }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ result })); return;
      }
      const url = new URL(req.url || "/", "http://fixture.invalid");
      const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
      if (!/^[a-zA-Z0-9_./-]+\.(html|css|js)$/.test(relative) || relative.split("/").includes("..")) throw Error("Invalid asset path");
      const filename = path.resolve(root, "renderer", relative);
      if (!filename.startsWith(path.join(root, "renderer") + path.sep)) throw Error("Invalid asset path");
      let content = await fs.readFile(filename, "utf8");
      if (relative === "index.html") content = content.replace(/<head>/i, `<head><script>
        window.__lastCopy='';window.pluginBridge={on:()=>()=>{},invoke:async(channel,payload)=>{if(channel==='clipboard.writeText')window.__lastCopy=payload.text;const r=await fetch('/bridge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel,payload})});const v=await r.json();if(v.error)throw new Error('Error invoking remote method: '+v.error.message);return v.result;}};
      </script>`);
      res.writeHead(200, { "Content-Type": relative.endsWith(".html") ? "text/html; charset=utf-8" : relative.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }); res.end(content);
    } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: e.code || "FAILED", message: "Fixture request rejected" } })); }
  });
  server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}`));
  let closing = false;
  async function stop() { if (closing) return; closing = true; releaseImage?.('success'); releaseAudio?.('failed'); server.closeAllConnections(); server.close(); await plugin.onUnload(); await fs.rm(temporary, { recursive: true, force: true }); process.exit(0); }
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
