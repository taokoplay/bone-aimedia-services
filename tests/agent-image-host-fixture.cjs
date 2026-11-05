"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { createRequire } = require("node:module");
const { execFile } = require("node:child_process");
const { png } = require("./image-fixture.cjs");
const PROBE_ID = "bone.aimedia.compatprobe";
const imageBytes = png(32, 32);
const imageBase64 = imageBytes.toString("base64");

async function poll(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function writeProbe(root, revision = 1) {
  const tools = [
    { name: "probe_catalog", risk: "low", planSafeActions: ["list"], description: `Probe catalog descriptor revision ${revision}`,
      schema: { type: "object", properties: { action: { type: "string", enum: ["list"] } }, required: ["action"], additionalProperties: false } },
    { name: "probe_image", risk: "low", description: "Return a deterministic PNG image block for compatibility verification",
      schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  ];
  const manifest = { schemaVersion: 1, id: PROBE_ID, name: "Isolated image compatibility probe", version: `0.0.${revision}`,
    description: "Disposable Agent image compatibility fixture", main: "main.js", permissions: ["agent.tool.register", "agent.prompt.inject"],
    contributes: { agentTools: tools, skills: [{ id: "image-probe", path: "skills/image-probe/SKILL.md" }] } };
  await fs.mkdir(path.join(root, "skills/image-probe"), { recursive: true });
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(root, "skills/image-probe/SKILL.md"), "---\nname: image-probe\ndescription: A disposable Agent image compatibility probe.\n---\nUse probe_catalog to list the deterministic fixture, then probe_image to receive its PNG.\n");
  await fs.writeFile(path.join(root, "main.js"), `"use strict";
const descriptors = ${JSON.stringify(tools)};
module.exports = {
  async onLoad() {
    for (const descriptor of descriptors) await pi.agent.registerTool({ ...descriptor, execute: async (_input, ctx) => {
      const metadata = { revision: ${revision}, sessionId: ctx?.sessionId ?? null, turnId: ctx?.turnId ?? null, mode: ctx?.mode ?? null };
      if (descriptor.name === "probe_catalog") return metadata;
      return { content: [{ type: "text", text: JSON.stringify(metadata) }, { type: "image", data: ${JSON.stringify(imageBase64)}, mimeType: "image/png" }], structuredContent: metadata };
    } });
  },
  async onUnload() { for (const tool of descriptors) await pi.agent.unregisterTool(tool.name); }
};\n`);
  return manifest;
}

function createModel({ imageDelayMs = 0 } = {}) {
  let active, serial = 0;
  const requests = [], failures = [], imageRequests = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "image-fixture", object: "model" }] })); return;
      }
      if (req.method === "POST" && req.url === "/v1/images/generations") {
        assert.equal(req.headers.authorization, "Bearer fixture-media-only");
        let raw = ""; for await (const part of req) raw += part;
        const body = JSON.parse(raw);
        assert.equal(body.model, "gpt-image-2"); assert.equal(body.n, 1); assert.equal(body.output_format, "png");
        imageRequests.push(body);
        if (imageDelayMs > 0) await new Promise(resolve => setTimeout(resolve, imageDelayMs));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: imageBase64 }] })); return;
      }
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.method, "POST");
      assert.ok(active, "Model request must belong to an explicit fixture turn");
      let raw = ""; for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      active.requests.push(body); requests.push({ scenario: active.name, body });
      if (active.pending) {
        const result = body.messages.find(message => message.role === "tool" && message.tool_call_id === active.pending.id);
        assert.ok(result, `Result missing for ${active.pending.name}`);
        active.results.push({ name: active.pending.name, content: result.content });
        active.pending = null;
      }
      const next = active.steps.shift();
      let delta, finish;
      if (next) {
        const names = body.tools?.map(tool => tool.function?.name).filter(Boolean) || [];
        const name = names.find(name => name === next.tool) || names.find(name => name === `plugin_bone_aimedia_services_${next.tool}`) || names.find(name => name === `plugin_bone_aimedia_compatprobe_${next.tool}`);
        if (!name) {
          active.missingTool = next.tool;
          active.steps = [];
          delta = { role: "assistant", content: `FIXTURE_MISSING_TOOL ${next.tool}` }; finish = "stop";
        } else {
          const id = `fixture_${++serial}`;
          active.pending = { id, name };
          const args = typeof next.args === "function" ? next.args(active) : next.args;
          delta = { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args || {}) } }] };
          finish = "tool_calls";
        }
      } else {
        const images = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image_url") : []);
        active.imageReceived = images.some(block => block.image_url?.url === `data:image/png;base64,${imageBase64}`);
        const texts = body.messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content || []).filter(block => block.type === "text").map(block => block.text));
        active.flattenedBase64 = texts.some(text => text.includes(imageBase64));
        delta = { role: "assistant", content: `FIXTURE_DONE ${active.name} image=${active.imageReceived}${active.finalText ? `\n\n${active.finalText}` : ""}` }; finish = "stop";
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const emit = (value, finish_reason) => res.write(`data: ${JSON.stringify({ id: `response_${serial}`, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
      emit(delta, null); emit({}, finish); res.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(String(error.stack));
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Isolated fixture assertion failed" } }));
    }
  });
  return { server, requests, failures, imageRequests, begin(name, steps, finalText) { active = { name, steps: [...steps], finalText, requests: [], results: [] }; return active; } };
}

async function createHost(root) {
  assert.ok(process.env.PI_DESKTOP_SOURCE && process.env.PI_DESKTOP_APP, "PI_DESKTOP_SOURCE and PI_DESKTOP_APP are required");
  const requireHost = createRequire(path.join(process.env.PI_DESKTOP_SOURCE, "package.json"));
  const { _electron } = requireHost("playwright-core");
  const data = path.join(root, "data");
  const output = [], lifecycle = [], windowUrls = [];
  let app, page;
  await fs.mkdir(path.join(data, "plugins/market"), { recursive: true });
  await fs.writeFile(path.join(data, "plugins/market/catalog.json"), '{"plugins":[]}');
  async function invoke(key, ...args) {
    assert.notEqual(key, "pluginOpenPanel", "This acceptance test never opens a plugin panel");
    const result = await page.evaluate(([key, args]) => {
      const channel = window.piDesktop.channels.invoke[key];
      if (!channel) throw Error(`Unsupported public IPC ${key}`);
      return window.piDesktop.invoke(channel, ...args);
    }, [key, args]);
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result)}`);
    return result.data;
  }
  async function stop() {
    if (!app) return;
    const current = app; app = null;
    const child = current.process();
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve(true) : new Promise(resolve => child.once("exit", () => resolve(true)));
    void current.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
    let timer;
    const exited = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); })]);
    clearTimeout(timer);
    if (!exited) { child.kill("SIGKILL"); await closed; }
    lifecycle.push({ pid: child.pid, graceful: exited });
  }
  async function launch() {
    const pluginLog = path.join(data, "logs/app/plugin.log");
    const previous = await fs.stat(pluginLog).then(stat => stat.size, () => 0);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD|PROXY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|PI_DESKTOP_HOST_BIN|PI_DESKTOP_AGENT/i.test(key)));
    // Keep macOS Keychain resolution consistent with credential-packaged.e2e.cjs.
    // Only the unique fixture account is ever requested by the real plugin.
    Object.assign(env, { PI_DESKTOP_DATA_DIR: data,
      PI_DESKTOP_CAPTURE: "0", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0", NO_PROXY: "localhost,127.0.0.1" });
    app = await _electron.launch({ executablePath: path.join(process.env.PI_DESKTOP_APP, "Contents/MacOS/PI-Desktop"),
      args: [`--user-data-dir=${path.join(root, "chromium")}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"], cwd: root, env, timeout: 30000 });
    app.process().stdout.on("data", chunk => output.push(String(chunk)));
    app.process().stderr.on("data", chunk => output.push(String(chunk)));
    const handleDialogs = window => {
      window.on("dialog", dialog => { void dialog.accept().catch(() => {}); });
      windowUrls.push(window.url());
      window.on("framenavigated", frame => { if (frame === window.mainFrame()) windowUrls.push(frame.url()); });
    };
    app.on("window", handleDialogs);
    for (const window of app.windows()) handleDialogs(window);
    await app.firstWindow({ timeout: 30000 });
    page = await poll(() => app.windows().find(window => /index\.html(?:$|\?)/.test(window.url()) && !new URL(window.url()).searchParams.has("surface")), "Packaged main window");
    page.setDefaultTimeout(15000);
    await page.waitForFunction(async () => {
      const api = window.piDesktop;
      return api && (await api.invoke(api.channels.invoke.pluginList))?.ok;
    }, null, { timeout: 30000 });
    const expected = (await invoke("pluginList")).plugins.filter(plugin => plugin.enabled && plugin.path).map(plugin => plugin.id);
    await poll(async () => {
      const log = await fs.readFile(pluginLog, "utf8").catch(() => "");
      const restored = new Set(log.slice(previous).split("\n").flatMap(line => {
        try { const event = JSON.parse(line); return event.event === "plugin.restored" ? [event.pluginId] : []; } catch { return []; }
      }));
      return expected.every(id => restored.has(id));
    }, "Isolated plugin restoration");
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    return { version: await app.evaluate(({ app }) => app.getVersion()), pid: app.process().pid };
  }
  async function turn(model, session, name, steps, finalText) {
    const scenario = model.begin(name, steps, finalText);
    await page.waitForFunction(() => window.__PI_DESKTOP__?.selectSession);
    await page.evaluate(async id => {
      await window.__PI_DESKTOP__.refreshProviders();
      await window.__PI_DESKTOP__.selectSession(id);
    }, session.id);
    await page.evaluate(() => {
      window.__agentImageOff?.(); window.__agentImageEvents = [];
      window.__agentImageOff = window.piDesktop.on(window.piDesktop.channels.event.agentMessage, event => window.__agentImageEvents.push(event));
    });
    await invoke("agentPrompt", { sessionId: session.id, viewingSessionId: session.id, content: `Isolated compatibility fixture ${name}. Follow the deterministic fixture tool sequence.` });
    await poll(async () => {
      const events = await page.evaluate(() => window.__agentImageEvents);
      return events.some(envelope => envelope.sessionId === session.id && envelope.event?.type === "agent_end");
    }, `${name} Agent lifecycle`, 60000);
    scenario.events = await page.evaluate(() => window.__agentImageEvents);
    scenario.session = await poll(async () => {
      const value = (await invoke("sessionGet", { id: session.id })).session;
      return value.messages?.some(message => message.role === "assistant" && (message.content?.includes(name) || message.content?.includes("FIXTURE_MISSING_TOOL"))) && value;
    }, `${name} durable transcript`);
    await page.waitForFunction(name => document.body.innerText.includes(`FIXTURE_DONE ${name}`) || document.body.innerText.includes("FIXTURE_MISSING_TOOL"), name);
    if (finalText) {
      try { await page.waitForFunction(() => [...document.images].some(image => image.naturalWidth === 32 && image.naturalHeight === 32), null, { timeout: 10000 }); }
      catch (error) { scenario.imageRenderError = error.message; }
    }
    scenario.errors = scenario.events.filter(envelope => envelope.event?.type === "error" || (envelope.event?.type === "tool_end" && envelope.event.isError));
    scenario.transcript = await page.evaluate(() => ({ text: document.body.innerText, images: [...document.images].filter(image => image.src.startsWith("data:image/png")).map(image => ({ src: image.src, width: image.naturalWidth, height: image.naturalHeight, visible: image.getBoundingClientRect().width > 0 })) }));
    await fs.writeFile(path.join(root, `${name}.transcript.html`), await page.content());
    return scenario;
  }
  return { data, invoke, launch, stop, turn, output, lifecycle, windowUrls, get page() { return page; },
    async inspectWindows() { return app.windows().map(window => window.url()); } };
}
async function prepareRealPlugin(root, data, baseUrl, { privateData = false, sourceRoot = path.resolve(__dirname, "..") } = {}) {
  const source = path.resolve(sourceRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
  assert.ok(manifest.contributes.agentTools.some(tool => tool.name === "generate_image"), "Parent's real Agent tools are not ready");
  const pluginRoot = path.join(root, "real-plugin");
  await fs.mkdir(pluginRoot);
  for (const entry of ["main.js", "manifest.json", "lib", "tools", "renderer", "skills"]) await fs.cp(path.join(source, entry), path.join(pluginRoot, entry), { recursive: true });
  const dataPath = path.join(data, "plugins/data", manifest.id);
  // The default preserves first-install mode; opt-in models an already private
  // store so lifecycle checks can run independently of a first-read regression.
  await fs.mkdir(dataPath, { recursive: true, mode: privateData ? 0o700 : 0o755 });
  const { createMediaProviderSettings } = require(path.join(source, "lib/media-provider-settings.js"));
  const { createKeychainSecrets, KEYCHAIN_SERVICE, keychainAccount } = require(path.join(source, "lib/keychain-secrets.js"));
  const cleanup = async () => {
    const code = await new Promise(resolve => execFile("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(dataPath)], error => resolve(error?.code || 0)));
    assert.ok(code === 0 || code === 44, "Owned test Keychain item cleanup failed");
  };
  const settings = createMediaProviderSettings({ getDataPath: () => dataPath, secrets: createKeychainSecrets({ getDataPath: () => dataPath }), request: async () => { throw Error("Fixture setup cannot make network requests"); } });
  try {
    // Seed only this throwaway data directory through the real settings service.
    // No plugin panel or user settings/credentials participate in setup.
    await settings.save({ expectedRevision: 0, profiles: [{ id: "fixture", provider: "openai", name: "Local image fixture", baseUrl, modelId: "gpt-image-2",
      models: [{ id: "gpt-image-2", kind: "image", name: "GPT Image 2" }], credentialUpdate: { action: "replace", value: "fixture-media-only" } }], defaults: { image: "fixture", video: null, audio: null } });
  } catch (error) { await cleanup(); throw error; }
  finally { await settings.dispose(); }
  return { pluginRoot, manifest, cleanup, initialDataMode: (await fs.stat(dataPath)).mode & 0o777 };
}
module.exports = { PROBE_ID, imageBytes, imageBase64, poll, writeProbe, createModel, createHost, prepareRealPlugin };
