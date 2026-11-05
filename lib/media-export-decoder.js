"use strict";

// This function is serialized, never invoked by the plugin. It has no closure
// dependencies: only the Agent's separately authorized Node process uses fs.
// The generated decoder is executable code in the workspace, not a signature or
// sandbox: replacing that executable before Node loads it is outside these data
// checks. The Agent must authorize execution of this fixed, verified handoff.
function decodeMediaExport(expected) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { createHash } = require("node:crypto");
  const c = fs.constants;
  const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
  const MAX_JSON_BYTES = 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 2048;
  const audio = expected.kind === "audio";
  const kind = audio ? "audio" : "image", extension = audio ? "mp3" : "png";
  const mimeType = audio ? "audio/mpeg" : "image/png", minimum = audio ? 8 : 57;
  const relativeOutput = `bone-media/exports/${expected.stem}.${extension}`;
  let outputVerified = false;
  const dirs = [];
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  function demand(ok, code) { if (!ok) throw Object.assign(new Error(code), { exportCode: code }); }
  function same(a, b) { return a.dev === b.dev && a.ino === b.ino; }
  function regular(stat, limit) {
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
      Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= limit, "UNSAFE_FILE");
  }
  function guard() {
    for (const dir of dirs) {
      const stat = fs.lstatSync(dir.path);
      demand(stat.isDirectory() && !stat.isSymbolicLink() && same(stat, dir.stat) &&
        fs.realpathSync(dir.path) === dir.real, "UNSAFE_LOCATION");
    }
  }
  function checkFile(file, identity, limit) {
    guard();
    const now = fs.lstatSync(file);
    regular(now, limit);
    demand(same(identity, now), "UNSAFE_FILE");
    return now;
  }
  function readBounded(file, limit) {
    guard();
    const before = fs.lstatSync(file);
    regular(before, limit);
    const fd = fs.openSync(file, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
    try {
      const start = fs.fstatSync(fd);
      regular(start, limit);
      demand(same(before, start), "UNSAFE_FILE");
      const bytes = Buffer.alloc(start.size + 1);
      let used = 0;
      while (used < bytes.length) {
        const count = fs.readSync(fd, bytes, used, bytes.length - used, used);
        if (!count) break;
        used += count;
      }
      const end = fs.fstatSync(fd);
      regular(end, limit);
      demand(same(start, end) && used === start.size && end.size === start.size &&
        end.mtimeMs === start.mtimeMs && end.ctimeMs === start.ctimeMs, "UNSAFE_FILE");
      checkFile(file, start, limit);
      return { bytes: bytes.subarray(0, used), stat: start };
    } finally { fs.closeSync(fd); }
  }
  function syncDirectory() {
    guard();
    const dir = dirs[dirs.length - 1];
    const fd = fs.openSync(dir.path, c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
    try {
      demand(same(dir.stat, fs.fstatSync(fd)), "UNSAFE_LOCATION");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    guard();
  }
  // lstat/realpath/inode checks narrow races; Node has no portable unlinkat or
  // directory-relative O_NOFOLLOW traversal. They cannot make a hostile ancestor
  // rename between checks and a path-based syscall atomic. Do not claim otherwise.
  function verifyOwned(file, original, limit) {
    const now = readBounded(file, limit);
    demand(same(now.stat, original.stat) && hash(now.bytes) === hash(original.bytes), "UNSAFE_FILE");
  }
  function removeOwned(file, original, limit) {
    verifyOwned(file, original, limit);
    checkFile(file, original.stat, limit);
    fs.unlinkSync(file);
  }
  try {
    demand(typeof c.O_NOFOLLOW === "number" && typeof c.O_DIRECTORY === "number", "UNSUPPORTED_PLATFORM");
    demand(process.argv.length === 2, "INVALID_ARGUMENT");
    demand(typeof expected.workspacePath === "string" && path.isAbsolute(expected.workspacePath), "UNSAFE_LOCATION");
    demand(["image", "audio"].includes(expected.kind), "INVALID_HANDOFF");
    demand(new RegExp(`^${kind}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(expected.stem), "INVALID_HANDOFF");
    const root = path.resolve(expected.workspacePath);
    const directory = path.join(root, "bone-media", "exports");
    const handoffFile = path.join(directory, `${expected.stem}.${kind}.json`);
    const decoderFile = path.join(directory, `${expected.stem}.decode.cjs`);
    const outputFile = path.join(directory, `${expected.stem}.${extension}`);
    demand(__dirname === directory && __filename === decoderFile &&
      path.resolve(process.argv[1]) === decoderFile, "UNSAFE_LOCATION");
    const realRoot = fs.realpathSync(root);
    demand(fs.realpathSync(process.cwd()) === realRoot, "UNSAFE_LOCATION");
    for (const parts of [[], ["bone-media"], ["bone-media", "exports"]]) {
      const file = path.join(root, ...parts);
      const stat = fs.lstatSync(file);
      const real = fs.realpathSync(file);
      demand(stat.isDirectory() && !stat.isSymbolicLink() && real === path.join(realRoot, ...parts), "UNSAFE_LOCATION");
      dirs.push({ path: file, stat, real });
    }
    guard();
    const decoder = readBounded(decoderFile, 64 * 1024);
    const handoff = readBounded(handoffFile, MAX_JSON_BYTES);
    demand(hash(handoff.bytes) === expected.handoffSha256, "INVALID_HANDOFF");
    let data;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(handoff.bytes)); }
    catch { demand(false, "INVALID_HANDOFF"); }
    const keys = ["version", "jobId", "mimeType", "byteLength", "sha256", "base64", "outputBasename"];
    demand(data && typeof data === "object" && !Array.isArray(data) &&
      Object.keys(data).every(key => keys.includes(key)) &&
      data.version === 1 && data.jobId === expected.jobId && data.mimeType === mimeType &&
      Number.isSafeInteger(data.byteLength) && data.byteLength >= minimum && data.byteLength <= MAX_IMAGE_BYTES &&
      data.byteLength === expected.byteLength && data.sha256 === expected.sha256 &&
      /^[0-9a-f]{64}$/.test(data.sha256) &&
      (data.outputBasename === undefined || data.outputBasename === `${expected.stem}.${extension}`), "INVALID_HANDOFF");
    demand(typeof data.base64 === "string" && data.base64.length === 4 * Math.ceil(data.byteLength / 3) &&
      !/[^A-Za-z0-9+/=]/.test(data.base64), "INVALID_HANDOFF");
    const bytes = Buffer.from(data.base64, "base64");
    demand(bytes.toString("base64") === data.base64 && bytes.length === data.byteLength &&
      hash(bytes) === expected.sha256, "INVALID_HANDOFF");
    demand(audio ? bytes.subarray(0, 3).toString("ascii") === "ID3" || bytes[0] === 255 && (bytes[1] & 224) === 224
      : bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", "INVALID_HANDOFF");
    // The producer validates media structure. This decoder pins those exact bytes
    // by hash and length; JSON is never evaluated or used as a pathname.
    guard();
    verifyOwned(handoffFile, handoff, MAX_JSON_BYTES);
    verifyOwned(decoderFile, decoder, 64 * 1024);
    guard();
    const fd = fs.openSync(outputFile, c.O_RDWR | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
    let outputIdentity;
    try {
      outputIdentity = fs.fstatSync(fd);
      regular(outputIdentity, MAX_IMAGE_BYTES);
      checkFile(outputFile, outputIdentity, MAX_IMAGE_BYTES);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const after = fs.fstatSync(fd);
      regular(after, MAX_IMAGE_BYTES);
      demand(same(after, outputIdentity) && after.size === bytes.length, "OUTPUT_INVALID");
      checkFile(outputFile, outputIdentity, MAX_IMAGE_BYTES);
    } finally { fs.closeSync(fd); }
    const written = readBounded(outputFile, MAX_IMAGE_BYTES);
    demand(same(written.stat, outputIdentity) && written.bytes.length === expected.byteLength &&
      hash(written.bytes) === expected.sha256, "OUTPUT_INVALID");
    syncDirectory();
    // Check BOTH inputs before removing either; a failed output keeps the inputs.
    verifyOwned(handoffFile, handoff, MAX_JSON_BYTES);
    verifyOwned(decoderFile, decoder, 64 * 1024);
    checkFile(outputFile, outputIdentity, MAX_IMAGE_BYTES);
    outputVerified = true;
    removeOwned(handoffFile, handoff, MAX_JSON_BYTES);
    removeOwned(decoderFile, decoder, 64 * 1024);
    outputVerified = false;
    syncDirectory();
    const final = readBounded(outputFile, MAX_IMAGE_BYTES);
    demand(same(final.stat, outputIdentity) && final.bytes.length === expected.byteLength &&
      hash(final.bytes) === expected.sha256, "OUTPUT_INVALID");
    outputVerified = true;
    process.stdout.write(JSON.stringify({ ok: true, path: relativeOutput,
      sha256: expected.sha256, byteLength: expected.byteLength }) + "\n");
  } catch (error) {
    const known = ["INVALID_ARGUMENT", "UNSAFE_LOCATION", "UNSAFE_FILE", "INVALID_HANDOFF", "OUTPUT_INVALID", "UNSUPPORTED_PLATFORM"];
    const code = known.includes(error?.exportCode) ? error.exportCode
      : error?.code === "EEXIST" ? "OUTPUT_EXISTS"
        : ["EACCES", "EPERM"].includes(error?.code) ? "PERMISSION_DENIED"
          : error?.code === "ELOOP" ? "UNSAFE_FILE" : "EXPORT_IO_ERROR";
    process.stderr.write(JSON.stringify({ ok: false, code, path: relativeOutput, outputVerified,
      artifactsMayRemain: true, diagnostic: "Export incomplete. Retain remaining artifacts and request a fresh export." }) + "\n");
    process.exitCode = 1;
  }
}

function buildMediaExportDecoder(expected) {
  return `"use strict";\n// Generated media export decoder; run only with Agent authorization.\n(${decodeMediaExport.toString()})(${JSON.stringify(expected)});\n`;
}

module.exports = { buildMediaExportDecoder };
