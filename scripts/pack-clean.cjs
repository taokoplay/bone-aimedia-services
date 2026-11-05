"use strict";
// Package runtime/user documentation only; never ship tests or private settings.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
(async () => {
  const host = process.argv[2];
  if (!host || process.argv.length !== 3 || !path.isAbsolute(host)) throw Error("Usage: node scripts/pack-clean.cjs /absolute/path/to/PI-Desktop");
  const root = path.resolve(__dirname, "..");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.id !== "bone.aimedia.services") throw Error("Unexpected plugin identity");
  await fs.access(path.join(host, "package.json"));
  const stage = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "aimedia-package-"));
  try {
    for (const name of ["manifest.json", "main.js", "README.md", "LICENSE", "NOTICE.md", "CHANGELOG.md"]) await fs.copyFile(path.join(root, name), path.join(stage, name));
    for (const name of ["lib", "tools", "renderer", "skills", "docs"]) await fs.cp(path.join(root, name), path.join(stage, name), { recursive: true, errorOnExist: true, force: false });
    const result = spawnSync("pnpm", ["--dir", host, "pi-plugin", "pack", stage, "--out", path.join(root, "dist")], { stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`Package command failed (${result.status})`);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
