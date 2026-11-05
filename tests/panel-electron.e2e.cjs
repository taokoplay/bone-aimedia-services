#!/usr/bin/env node
"use strict";
// Exercises the real Electron ipcRenderer/contextBridge boundary in an isolated app.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const pluginRoot = path.resolve(__dirname, "..");

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  const temporary = process.env.AIMEDIA_PANEL_QA_DIR;
  assert.ok(temporary, "Isolated fixture directory required");
  app.setPath("userData", path.join(temporary, "electron-profile"));
  app.setName("AI Media Panel Regression");
  await app.whenReady();
  const crypto = require("./settings-service-fixture.cjs").testSecrets();
  const secrets = {};
  let mode = "unavailable", dropNext = false, saves = 0, legacy = false;
  globalThis.pi = {
    plugin: { getDataPath: async () => path.join(temporary, "plugin-data"), getManifest: async () => ({ version: "0.2.1" }) },
    commands: { register: async () => {}, unregister: async () => {} },
    agent: { registerTool: async () => {}, unregisterTool: async () => {} },
    net: { fetch: async () => { throw Error("No network permitted in panel regression"); } },
  };
  const plugin = require("../main.js").createPlugin(pi, () => secrets); await plugin.onLoad();
  ipcMain.handle("pi-plugin-panel-window-control", async () => null);
  ipcMain.handle("pi-plugin-panel-invoke", async (_event, channel, payload) => {
    if (channel === "fixture.throw") throw Object.assign(Error("Synthetic credential failure"), { code: "CREDENTIAL_UNAVAILABLE" });
    if (channel === "fixture.legacy") { legacy = payload.enabled; return null; }
    if (channel === "fixture.mode") {
      mode = payload.mode;
      secrets.encrypt = mode === "unavailable" ? undefined : mode === "normal" ? crypto.encrypt : async () => { throw Object.assign(Error("Synthetic crypto failure"), { code: mode === "denied" ? "PERMISSION_DENIED" : "FAILED" }); };
      secrets.decrypt = crypto.decrypt;
      return null;
    }
    if (channel === "fixture.dropNext") { dropNext = true; return null; }
    if (channel === "fixture.saves") return saves;
    if (channel === "app.getAppearance") return { theme: "dark", base: "dark", locale: "zh-CN" };
    if (legacy && channel === "aimedia.invoke") throw Error("Legacy entry has no structured protocol");
    if (channel === "aimedia.invoke" && payload.channel === "aimedia.save") saves++;
    const result = await plugin.onPanelInvoke(channel, payload);
    if (legacy && channel === "aimedia.status") delete result.panelProtocol;
    if (dropNext && channel === "aimedia.invoke" && payload.channel === "aimedia.save") { dropNext = false; throw Error("Synthetic response lost after commit"); }
    return result;
  });
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: {
    preload: path.join(temporary, "preload.cjs"), contextIsolation: true, sandbox: true,
    nodeIntegration: false, backgroundThrottling: false,
  } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/i.test(details.url) });
  });
  try {
    await win.loadFile(path.join(pluginRoot, "renderer/index.html"));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const raw = await pluginBridge.invoke('fixture.throw').then(() => null, e => ({ code: e.code ?? null }));
      const invoke = AIMedia.createPanelInvoke(() => pluginBridge);
      const input = revision => ({ expectedRevision: revision, profiles: [{ id: 'fixture', provider: 'openai', credentialUpdate: { action: 'replace', value: 'fixture-electron-private-key' } }], defaults: { image: null, video: null, audio: null } });
      const codes = [];
      for (const mode of ['unavailable', 'denied', 'failed']) {
        await pluginBridge.invoke('fixture.mode', { mode });
        codes.push(await invoke('aimedia.save', input(0)).then(() => 'SAVED', e => e.code ?? null));
      }
      const before = await invoke('aimedia.get');
      await pluginBridge.invoke('fixture.mode', { mode: 'normal' });
      const saved = await invoke('aimedia.save', input(0));
      const conflict = await invoke('aimedia.save', input(0)).then(() => null, e => e.code ?? null);
      await pluginBridge.invoke('fixture.legacy', { enabled: true });
      const oldInvoke = AIMedia.createPanelInvoke(() => pluginBridge);
      const oldRead = await oldInvoke('aimedia.get');
      const old = await oldInvoke('aimedia.save', input(1)).then(() => null, e => e.code ?? null);
      await pluginBridge.invoke('fixture.legacy', { enabled: false });
      await pluginBridge.invoke('fixture.dropNext');
      const uncertain = await invoke('aimedia.save', input(1)).then(() => 'SAVED', e => e.code ?? null);
      const after = await invoke('aimedia.get');
      return { raw, codes, before: before.revision, saved: saved.revision, configured: saved.profiles[0].credentialConfigured, conflict, old, oldRead: oldRead.revision, uncertain, after: after.revision, saves: await pluginBridge.invoke('fixture.saves'), leaks: JSON.stringify([before,saved,after]).includes('fixture-electron-private-key') };
    })()`);
    assert.deepEqual(result, { raw: { code: null }, codes: ["CREDENTIAL_UNAVAILABLE", "PERMISSION_DENIED", "CREDENTIAL_ERROR"], before: 0, saved: 1, configured: true, conflict: "CONFLICT", old: "PLUGIN_RELOAD_REQUIRED", oldRead: 1, uncertain: null, after: 2, saves: 6, leaks: false });
    legacy = true;
    await win.loadFile(path.join(pluginRoot, "renderer/index.html"));
    const visible = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const check = () => document.querySelector('[data-row-id="fixture"]') && document.querySelector('[data-config-readonly]');
      if (check()) return resolve(true);
      const observer = new MutationObserver(() => { if (check()) { clearTimeout(timer); observer.disconnect(); resolve(true); } });
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Legacy configuration did not render')); }, 10000);
      observer.observe(document.body, { childList: true, subtree: true });
    })`);
    assert.equal(visible, true);
    const disk = await fs.readFile(path.join(temporary, "plugin-data/aimedia-settings.json"), "utf8");
    assert.ok(!disk.includes("fixture-electron-private-key"));
    console.log("PASS: real Electron preserves structured errors, legacy configuration rendering, write refusal and uncertain-save protection");
  } finally {
    await plugin.onUnload();
  }
  // This fixture validates IPC, not Electron's OS shutdown lifecycle.
  process.exit(0);
}

async function runNode() {
  if (process.argv.includes("--help")) {
    console.log("PI_DESKTOP_SOURCE=/path/to/PI-Desktop node tests/panel-electron.e2e.cjs");
    return;
  }
  assert.ok(process.env.PI_DESKTOP_SOURCE, "PI_DESKTOP_SOURCE must point to the Host source/toolchain");
  const source = path.resolve(process.env.PI_DESKTOP_SOURCE);
  const requireHost = createRequire(path.join(source, "package.json"));
  const temporary = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "aimedia-electron-"));
  try {
    await requireHost("esbuild").build({ absWorkingDir: source,
      entryPoints: [path.join(source, "apps/desktop/electron/preload/plugin-panel.ts")],
      outfile: path.join(temporary, "preload.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
      alias: { "@pi-desktop/shared": path.join(source, "packages/shared/src") },
      nodePaths: [path.join(source, "node_modules")], logLevel: "silent",
    });
    const env = { ...process.env, AIMEDIA_PANEL_QA_DIR: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(requireHost("electron"), [__filename], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    const pass = output.split(/\r?\n/).find(line => line.startsWith("PASS:"));
    assert.ok(pass, "Electron fixture did not report completion"); console.log(pass);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
if (process.versions.electron) runElectron().catch(error => { console.error(error.stack); require("electron").app.exit(1); });
else runNode().catch(error => { console.error(error.message); process.exitCode = 1; });
