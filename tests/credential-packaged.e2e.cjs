#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { KEYCHAIN_SERVICE, keychainAccount } = require("../lib/keychain-secrets.js");
const { png } = require("./image-fixture.cjs");

async function main() {
  if (process.argv.includes("--help")) {
    console.log("PI_DESKTOP_SOURCE=/path/to/source PI_DESKTOP_APP=/path/to/PI-Desktop.app node tests/credential-packaged.e2e.cjs");
    return;
  }
  assert.ok(process.env.PI_DESKTOP_SOURCE && process.env.PI_DESKTOP_APP);
  const requireHost = createRequire(path.join(process.env.PI_DESKTOP_SOURCE, "package.json"));
  const { _electron } = requireHost("playwright-core");
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "media-packaged-"));
  const data = path.join(root, "data"), pluginRoot = path.join(root, "plugin");
  const source = path.resolve(__dirname, "..");
  const secret = "isolated-packaged-credential-fixture";
  const replacement = "isolated-packaged-replacement-fixture";
  let expectedSecret = secret;
  let app, server, requests = 0, graceful = 0;
  let imageRequests = 0, imageJob;
  const output = [];
  async function stop() {
    if (!app) return;
    const current = app; app = null;
    const child = current.process();
    const closed = child.exitCode !== null || child.signalCode !== null ? Promise.resolve(true) : new Promise(resolve => child.once("exit", () => resolve(true)));
    void current.evaluate(({ app }) => { setTimeout(() => app.quit(), 0); }).catch(() => {});
    let timer;
    const exited = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 8000); })]);
    clearTimeout(timer);
    if (exited) graceful++;
    else {
      child.kill("SIGKILL");
      await bounded(closed, "Owned process termination");
    }
    console.log("QA: isolated app stopped");
  }
  async function launch() {
    const pluginLog = path.join(data, "logs/app/plugin.log");
    const previousLogSize = await fs.stat(pluginLog).then(stat => stat.size, () => 0);
    const env = { ...process.env, PI_DESKTOP_DATA_DIR: data, PI_DESKTOP_CAPTURE: "0", ELECTRON_RENDERER_URL: "", PI_DESKTOP_START_MAXIMIZED: "0" };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: path.join(process.env.PI_DESKTOP_APP, "Contents/MacOS/PI-Desktop"),
      args: ["--user-data-dir=" + path.join(root, "chromium")], env, timeout: 20000 });
    app.process().stdout.on("data", chunk => output.push(String(chunk)));
    app.process().stderr.on("data", chunk => output.push(String(chunk)));
    const handleDialogs = page => page.on("dialog", dialog => { void dialog.accept().catch(() => {}); });
    app.on("window", handleDialogs);
    for (const page of app.windows()) handleDialogs(page);
    const mainPage = await app.firstWindow({ timeout: 20000 });
    mainPage.setDefaultTimeout(10000);
    await mainPage.waitForFunction(async () => {
      const api = window.piDesktop;
      if (!api) return false;
      const result = await api.invoke(api.channels.invoke.pluginList);
      return result?.ok === true;
    }, null, { timeout: 20000 });
    const listed = await hostInvoke(mainPage, "pluginList");
    const expected = listed.plugins.filter(plugin => plugin.enabled && plugin.path).map(plugin => plugin.id);
    assert.ok(expected.length, "Isolated baseline must include bundled plugins");
    const deadline = Date.now() + 20000;
    for (;;) {
      const raw = await fs.readFile(pluginLog, "utf8").catch(() => "");
      const restored = new Set(raw.slice(previousLogSize).split("\n").flatMap(line => {
        try { const event = JSON.parse(line); return event.event === "plugin.restored" ? [event.pluginId] : []; } catch { return []; }
      }));
      if (expected.every(id => restored.has(id))) break;
      assert.ok(Date.now() < deadline, "Isolated plugin restoration timed out");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    console.log("QA: bundled plugin restoration completed");
    console.log("QA: packaged startup completed");
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    return mainPage;
  }
  async function bounded(operation, label) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000); })]); }
    finally { clearTimeout(timer); }
  }
  async function hostInvoke(page, key, payload) {
    const result = await bounded(page.evaluate(([key, payload]) => window.piDesktop.invoke(window.piDesktop.channels.invoke[key], payload), [key, payload]), key);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  }
  async function panel(mainPage, id) {
    await hostInvoke(mainPage, "pluginOpenPanel", id);
    const targetUrl = require("node:url").pathToFileURL(path.join(pluginRoot, "renderer/index.html")).href;
    const deadline = Date.now() + 15000;
    let page;
    while (!(page = app.windows().find(candidate => candidate.url() === targetUrl))) {
      assert.ok(Date.now() < deadline, "Media panel URL did not appear");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => window.AIMedia?.createPanelInvoke && window.pluginBridge, null, { polling: 100 });
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    return page;
  }
  const invoke = (page, channel, payload) => bounded(page.evaluate(([channel, payload]) => window.AIMedia.createPanelInvoke(() => window.pluginBridge)(channel, payload), [channel, payload]), channel);
  try {
    await fs.mkdir(path.join(data, "plugins/market"), { recursive: true });
    await fs.writeFile(path.join(data, "plugins/market/catalog.json"), '{"plugins":[]}');
    await fs.mkdir(pluginRoot);
    for (const entry of ["main.js", "lib", "tools", "renderer", "skills"]) await fs.cp(path.join(source, entry), path.join(pluginRoot, entry), { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
    manifest.ui = { panel: "renderer/index.html", title: "Isolated media acceptance", width: 1100, height: 900 };
    manifest.permissions.push("ui.panel");
    await fs.writeFile(path.join(pluginRoot, "manifest.json"), JSON.stringify(manifest));
    server = http.createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${expectedSecret}`);
      if (req.url === "/v1/images/generations") {
        assert.equal(req.method, "POST");
        let raw = ""; for await (const part of req) raw += part;
        const body = JSON.parse(raw); assert.equal(body.n, 1); assert.equal(body.output_format, "png"); assert.ok(body.model.startsWith("gpt-image-"));
        imageRequests++; res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: png(32, 32).toString("base64") }] })); return;
      }
      assert.equal(req.url, "/v1/models"); assert.equal(req.method, "GET"); requests++;
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"data":[{"id":"gpt-image-1"}]}');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    let mainPage = await launch();
    const loaded = await hostInvoke(mainPage, "pluginLoadDevConfirm", { path: pluginRoot, grantedPermissions: manifest.permissions });
    assert.ok(!manifest.permissions.some(permission => permission.startsWith("secrets.")));
    assert.ok(loaded.id || loaded.plugin || loaded.grantedPermissions);
    let page = await panel(mainPage, manifest.id);
    await page.getByRole("button", { name: "添加服务", exact: true }).dispatchEvent("click");
    await page.getByRole("dialog").getByRole("button", { name: "ChatGPT / OpenAI 图片", exact: true }).dispatchEvent("click");
    await page.getByRole("textbox", { name: "配置名称", exact: true }).fill("Packaged persistence fixture", { force: true });
    await page.getByRole("textbox", { name: "服务地址", exact: true }).fill(baseUrl, { force: true });
    await page.getByLabel("API Key", { exact: true }).fill(secret, { force: true });
    await page.getByRole("button", { name: "添加模型 GPT Image 2", exact: true }).dispatchEvent("click");
    await page.locator("form").evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent.includes('配置已保存'), null, { polling: 100 });
    const saved = await invoke(page, "aimedia.get");
    assert.equal(saved.revision, 1); assert.equal(saved.profiles[0].credentialConfigured, true);
    console.log("QA: credential saved through packaged UI");
    const file = path.join(data, "plugins/data", manifest.id, "aimedia-settings.json");
    const disk = await fs.readFile(file, "utf8"); assert.ok(!disk.includes(secret));
    assert.equal(JSON.parse(disk).encryptedCredentials.version, 2);
    assert.equal(JSON.parse(disk).encryptedCredentials.backend, "macos-keychain");
    await page.close({ runBeforeUnload: false });
    await hostInvoke(mainPage, "pluginReload", manifest.id);
    page = await panel(mainPage, manifest.id);
    assert.equal((await invoke(page, "aimedia.get")).profiles[0].credentialConfigured, true);
    console.log("QA: credential restored after plugin reload");
    await stop();
    mainPage = await launch();
    page = await panel(mainPage, manifest.id);
    const restored = await invoke(page, "aimedia.get");
    console.log("QA: credential restored after app restart");
    assert.equal(restored.profiles[0].credentialConfigured, true);
    assert.equal(await fs.readFile(file, "utf8"), disk);
    const probe = await invoke(page, "aimedia.probe", { profileId: restored.profiles[0].id, expectedRevision: 1 });
    assert.equal(probe.status, "connected"); assert.equal(requests, 1);
    await page.getByRole("tab", { name: "生图", exact: true }).dispatchEvent("click");
    await page.getByRole("button", { name: "OpenAI 服务", exact: true }).dispatchEvent("click");
    await page.getByRole("option", { name: "Packaged persistence fixture", exact: true, includeHidden: true }).dispatchEvent("click");
    await page.getByRole("button", { name: "图片模型", exact: true }).dispatchEvent("click");
    const model = restored.profiles[0].models.find(model => model.kind === "image" && model.id.startsWith("gpt-image-"));
    assert.ok(model);
    await page.getByRole("option", { name: `${model.name} · ${model.id}`, exact: true, includeHidden: true }).dispatchEvent("click");
    await page.getByRole("textbox", { name: "提示词", exact: true }).fill("A blue cup, isolated fixture image.", { force: true });
    await page.locator('form[aria-label="图片生成请求"]').evaluate(form => form.requestSubmit());
    await page.waitForSelector('[data-generation-state="prepared"]', { state: "attached" });
    const id = await page.locator('[data-generation-job]').getAttribute('data-generation-job');
    assert.equal(imageRequests, 0);
    await page.getByRole("button", { name: "确认生成…", exact: true }).dispatchEvent("click");
    await page.getByRole("dialog").getByRole("button", { name: "生成 1 张", exact: true }).dispatchEvent("click");
    await page.waitForFunction(() => document.querySelector('[data-generation-state="succeeded"]'), null, { polling: 100 });
    imageJob = await invoke(page, "aimedia.image.get", { jobId: id }); assert.equal(imageJob.state, "succeeded");
    assert.equal(imageRequests, 1);
    await page.waitForFunction(() => document.querySelector('img[alt="生成图片预览"]')?.naturalWidth === 32, null, { polling: 100 });
    const downloadedPath = path.join(root, "generated.png");
    await app.evaluate(({ webContents }, { url, outputPath }) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL() === url);
      if (!contents) throw Error("Test panel webContents missing");
      globalThis.__aimediaDownload = "waiting";
      contents.session.once("will-download", (_event, item) => {
        item.setSavePath(outputPath);
        item.once("done", (_event, state) => { globalThis.__aimediaDownload = state; });
      });
    }, { url: page.url(), outputPath: downloadedPath });
    await page.getByRole("link", { name: "下载 PNG", exact: true }).evaluate(link => link.click());
    await bounded((async () => {
      for (;;) {
        const state = await app.evaluate(() => globalThis.__aimediaDownload);
        if (state === "completed") break;
        assert.equal(state, "waiting", "Image download was interrupted");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })(), "Plugin partition PNG download");
    assert.deepEqual(await fs.readFile(downloadedPath), png(32, 32));
    console.log("QA: GPT UI prepare/confirm/PNG decode/download passed");
    await page.getByRole("tab", { name: "配置", exact: true }).dispatchEvent("click");
    await page.locator("[data-service-row]").filter({ hasText: "Packaged persistence fixture" }).dispatchEvent("click");
    assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "");
    assert.ok((await page.locator("#credential-hint").innerText()).includes("已加密保存"));
    await page.getByLabel("API Key", { exact: true }).fill(replacement, { force: true });
    await page.locator("form").evaluate(form => form.requestSubmit());
    await page.waitForFunction(async () => (await window.AIMedia.createPanelInvoke(() => window.pluginBridge)("aimedia.get")).revision === 2, null, { polling: 100 });
    expectedSecret = replacement;
    await stop();
    mainPage = await launch(); page = await panel(mainPage, manifest.id);
    const replaced = await invoke(page, "aimedia.get");
    const persistedJob = await invoke(page, "aimedia.image.get", { jobId: imageJob.id });
    assert.deepEqual(persistedJob.result, imageJob.result);
    await invoke(page, "aimedia.image.submit", { jobId: imageJob.id, requestHash: imageJob.requestHash, confirm: true });
    assert.equal(imageRequests, 1);
    console.log("QA: image result restored after app restart; duplicate submit did not dispatch");
    assert.equal(replaced.profiles[0].credentialConfigured, true);
    assert.equal((await invoke(page, "aimedia.probe", { profileId: replaced.profiles[0].id, expectedRevision: 2 })).status, "connected");
    await page.locator("[data-service-row]").filter({ hasText: "Packaged persistence fixture" }).dispatchEvent("click");
    await page.getByRole("button", { name: "清除凭据", exact: true }).dispatchEvent("click");
    await page.locator("form").evaluate(form => form.requestSubmit());
    await page.waitForFunction(async () => (await window.AIMedia.createPanelInvoke(() => window.pluginBridge)("aimedia.get")).revision === 3, null, { polling: 100 });
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).encryptedCredentials, undefined);
    await stop();
    mainPage = await launch(); page = await panel(mainPage, manifest.id);
    assert.equal((await invoke(page, "aimedia.get")).profiles[0].credentialConfigured, false);
    await stop();
    assert.ok(!output.join("").includes(secret) && !output.join("").includes(replacement));
    console.log(JSON.stringify({ passed: true, packagedApp: process.env.PI_DESKTOP_APP, hostSecretsRequired: false,
      savedThroughUi: true, restoredAfterPluginReload: true, restoredAfterAppRestart: true, replacedAfterRestart: true, clearedAfterRestart: true,
      authenticatedRequests: requests, imageRequests, imageDecodedAndDownloaded: true, imageRestoredAfterRestart: true, plaintextAbsent: true, gracefulExits: graceful }));
  } finally {
    await stop(); if (server) await new Promise(resolve => server.close(resolve));
    // Never persist captured process output containing even synthetic credentials.
    const safeOutput = output.join("").replaceAll(secret, "[REDACTED]").replaceAll(replacement, "[REDACTED]");
    await fs.writeFile(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "gpt-packaged-runtime.log"), safeOutput);
    const cleanupCode = await new Promise(resolve => execFile("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(path.join(data, "plugins/data/bone.aimedia.services"))], error => resolve(error?.code || 0)));
    assert.ok(cleanupCode === 0 || cleanupCode === 44, "Owned test Keychain item cleanup failed");
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
