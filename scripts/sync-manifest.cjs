"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
(async () => {
  const mode = process.argv[2] || "--check";
  if (!["--check", "--write"].includes(mode)) throw Error("Usage: node scripts/sync-manifest.cjs [--check|--write]");
  const root = path.resolve(__dirname, ".."), filename = path.join(root, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(filename, "utf8"));
  const temporary = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "aimedia-manifest-"));
  const tools = new Map();
  globalThis.pi = {
    plugin: { getDataPath: async () => temporary, getManifest: async () => manifest },
    commands: { register: async () => {}, unregister: async () => {} }, ui: { revealView: async () => {} },
    agent: { registerTool: async tool => tools.set(tool.name, tool), unregisterTool: async name => tools.delete(name) },
  };
  const plugin = require(path.join(root, "main.js"));
  try {
    await plugin.onLoad();
    if (tools.size !== 16) throw Error("Expected twelve compatible tools and four audio workflow tools");
    const descriptors = [...tools.values()].map(({ name, risk, description, schema, planSafeActions }) => ({ name, risk, description, schema, ...(planSafeActions ? { planSafeActions } : {}) }));
    const match = JSON.stringify(descriptors) === JSON.stringify(manifest.contributes.agentTools);
    if (mode === "--check" && !match) throw Error("Manifest tool declarations drifted");
    if (mode === "--write" && !match) { manifest.contributes.agentTools = descriptors; await fs.writeFile(filename, JSON.stringify(manifest, null, 2) + "\n"); }
    console.log(`${mode === "--write" ? "Synchronized" : "Verified"} ${tools.size} tools for ${manifest.id}@${manifest.version}`);
  } finally { await plugin.onUnload(); delete globalThis.pi; await fs.rm(temporary, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
