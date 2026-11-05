#!/usr/bin/env node
// Full-process acceptance. Requires a newly built PI-Desktop Host from the same source.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

if (process.argv.includes("--help")) {
  console.log("PI_DESKTOP_SOURCE=/path/to/worktree PI_DESKTOP_HOST_BIN=/path/to/new/host node --experimental-strip-types tests/credential-host.e2e.mjs");
  process.exit(0);
}
assert.ok(process.env.PI_DESKTOP_SOURCE && process.env.PI_DESKTOP_HOST_BIN, "Set PI_DESKTOP_SOURCE and PI_DESKTOP_HOST_BIN to the tested candidate");
const source = resolve(process.env.PI_DESKTOP_SOURCE), binary = resolve(process.env.PI_DESKTOP_HOST_BIN);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const data = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "aimedia-host-e2e-"));
const previousData = process.env.PI_DESKTOP_DATA_DIR;
process.env.PI_DESKTOP_DATA_DIR = data;
mkdirSync(join(data, "plugins/market"), { recursive: true });
writeFileSync(join(data, "plugins/market/catalog.json"), '{"plugins":[]}');
let host, runtime;
const audits = [], logs = [];
const initial = "fixture-host-persistent-key", replacement = "fixture-host-replacement-key";
let expectedKey = initial, requests = 0;
const loadModule = relative => import(pathToFileURL(join(source, relative)).href);
try {
  register(pathToFileURL(join(source, "apps/desktop/test/helpers/ts-import-hooks.mjs")));
  const { Host } = await loadModule("scripts/e2e/host.mjs");
  const { PluginRuntime } = await loadModule("apps/desktop/electron/main/plugin-runtime.ts");
  const { createPluginSecretsService } = await loadModule("apps/desktop/electron/main/plugin-secrets.ts");
  host = new Host(binary, data, { quiet: true, env: { RUST_LOG: "warn" } });
  await host.start();
  await host.call("plugins.loadDev", { path: pluginRoot });
  await assert.rejects(host.call("plugins.secrets.encrypt", { pluginId: manifest.id, value: initial }), { errorCode: "PERMISSION_DENIED" });
  await host.call("plugins.grantPermissions", { id: manifest.id, permissions: manifest.permissions });
  const createRuntime = () => new PluginRuntime({
    hostEntry: join(source, "apps/desktop/electron/main/plugin-host-process.mjs"),
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      child.stdout.on("data", chunk => logs.push(String(chunk)));
      child.stderr.on("data", chunk => logs.push(String(chunk)));
      return { postMessage: message => child.connected && child.send(message),
        onMessage: handler => child.on("message", handler), onExit: handler => child.on("exit", code => handler(code ?? 0)), kill: () => child.kill() };
    },
    secrets: createPluginSecretsService(() => host),
    fetch: async (url, options) => {
      assert.equal(String(url), "https://api.openai.com/v1/models");
      assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${expectedKey}`);
      requests++;
      return new Response('{"data":[{"id":"gpt-image-1"}]}', { status: 200, headers: { "Content-Type": "application/json" } });
    },
    audit: entry => audits.push(entry),
  });
  const window = { AIMedia: {} };
  runInNewContext(readFileSync(join(pluginRoot, "renderer/settings-bridge.js"), "utf8"), { window });
  const call = window.AIMedia.createPanelInvoke(() => ({ invoke: (channel, payload) => runtime.invokePanelBridge(manifest.id, channel, payload) }));
  const load = async () => { runtime = createRuntime(); await runtime.loadFromPath(pluginRoot, manifest.permissions); };
  const restart = async () => { await runtime.unload(manifest.id); logs.push(host.stderr); await host.restart(); await load(); };
  await load();
  const defaults = { image: null, video: null, audio: null };
  const save = (expectedRevision, update) => call("aimedia.save", { expectedRevision, profiles: [{ id: "fixture", provider: "openai", credentialUpdate: update }], defaults });
  await save(0, { action: "replace", value: initial });
  const file = join(data, "plugins/data", manifest.id, "aimedia-settings.json");
  const stored = readFileSync(file, "utf8"), ciphertext = JSON.parse(stored).encryptedCredentials.ciphertext;
  assert.ok(!stored.includes(initial)); assert.ok(ciphertext.startsWith("v1:"));
  await restart();
  let state = await call("aimedia.get");
  assert.equal(state.profiles[0].credentialConfigured, true);
  assert.ok(!JSON.stringify(state).includes(initial) && !JSON.stringify(state).includes(ciphertext));
  assert.equal((await call("aimedia.probe", { profileId: "fixture", expectedRevision: 1 })).status, "connected");
  await save(1, { action: "replace", value: replacement }); expectedKey = replacement;
  await restart();
  assert.equal((await call("aimedia.probe", { profileId: "fixture", expectedRevision: 2 })).status, "connected");
  const beforeDenial = readFileSync(file, "utf8");
  await host.call("plugins.revokePermissions", { id: manifest.id, permissions: ["secrets.encrypt"] });
  await assert.rejects(save(2, { action: "replace", value: initial }), { code: "PERMISSION_DENIED" });
  assert.equal(readFileSync(file, "utf8"), beforeDenial);
  await host.call("plugins.revokePermissions", { id: manifest.id, permissions: ["secrets.decrypt"] });
  await restart();
  await assert.rejects(call("aimedia.get"), { code: "PERMISSION_DENIED" });
  assert.equal(readFileSync(file, "utf8"), beforeDenial);
  await host.call("plugins.grantPermissions", { id: manifest.id, permissions: ["secrets.encrypt", "secrets.decrypt"] });
  assert.equal((await call("aimedia.get")).profiles[0].credentialConfigured, true);
  await save(2, { action: "clear" }); await restart();
  state = await call("aimedia.get"); assert.equal(state.profiles[0].credentialConfigured, false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).encryptedCredentials, undefined);
  const count = requests;
  assert.equal((await call("aimedia.probe", { profileId: "fixture", expectedRevision: 3 })).status, "unavailable");
  assert.equal(requests, count);
  const recorded = JSON.stringify([audits, logs, host.stderr]);
  for (const secret of [initial, replacement, ciphertext]) assert.ok(!recorded.includes(secret));
  console.log("PASS: actual media plugin -> child broker -> Rust encryption, restart, replacement, clear, revocation, recovery and log redaction");
} finally {
  try { await runtime?.unload(manifest.id); } finally {
    try { await host?.stop(); } finally {
      if (previousData === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
      else process.env.PI_DESKTOP_DATA_DIR = previousData;
      rmSync(data, { recursive: true, force: true });
    }
  }
}
