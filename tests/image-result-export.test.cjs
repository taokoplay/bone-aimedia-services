"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { createImageResultExporter } = require("../lib/image-result-export.js");
const { buildImageExportDecoder } = require("../lib/image-export-decoder.js");
const { validatePng } = require("../lib/image-png.js");
const { png } = require("./image-fixture.cjs");

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const secret = "private Bearer test-token raw error";
const fault = code => Object.assign(new Error(secret), { code });
const safeError = code => error => error.code === code && !error.message.includes(secret) && !JSON.stringify(error).includes("base64");
const context = () => ({ sessionId: "trusted-session", turnId: "trusted-turn", mode: "agent" });
const absent = file => assert.rejects(fs.lstat(file), { code: "ENOENT" });

async function fixture(t, bytes = png()) {
  const parent = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "image-export-"));
  // A quote and shell metacharacters in the workspace must never enter the command.
  const root = path.join(await fs.realpath(parent), "workspace ' $(literal)");
  await fs.mkdir(root);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const job = { id: `img-${randomUUID()}`, state: "succeeded", result: validatePng(bytes) };
  const f = { parent, root, current: { path: root, name: "test" }, job, bytes,
    calls: [], reads: 0, workspaceCalls: 0, ctx: context(), beforeFs: null, afterFs: null, onReadResult: null, onWorkspace: null };
  function resolve(file) {
    assert.match(file, /^bone-media\/exports\/image-[0-9a-f-]+\.(?:image\.json|decode\.cjs|png)$/);
    assert.ok(f.current?.path && !f.current.remote);
    return path.join(f.current.path, file);
  }
  async function operation(op, file, content) {
    f.calls.push({ op, file });
    if (f.beforeFs) await f.beforeFs(op, file);
    const full = resolve(file);
    let result;
    try {
      if (op === "stat") { const stat = await fs.stat(full); result = { size: stat.size, mtimeMs: stat.mtimeMs }; }
      if (op === "readText") result = await fs.readFile(full, "utf8");
      if (op === "writeText") { await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, content); }
    } catch (error) {
      if (error.code === "ENOENT" && f.notFoundCode) throw fault(f.notFoundCode);
      throw error;
    }
    if (f.afterFs) await f.afterFs(op, file);
    return result;
  }
  f.host = { workspace: { async get() {
    f.workspaceCalls++;
    if (f.onWorkspace) await f.onWorkspace();
    return f.current ? { ...f.current } : null;
  } }, fs: {
    stat: file => operation("stat", file), readText: file => operation("readText", file),
    writeText: (file, content) => operation("writeText", file, content),
  } };
  f.readResult = async id => {
    assert.equal(id, job.id); f.reads++;
    if (f.onReadResult) await f.onReadResult();
    return { job: f.job, bytes: f.bytes };
  };
  f.exporter = createImageResultExporter({ host: f.host, readResult: f.readResult });
  f.export = () => f.exporter.exportResult({ jobId: job.id }, f.ctx);
  return f;
}
function decode(f, result, options = {}) {
  const { preload, args = [], cwd = f.root } = options;
  const child = spawnSync(process.execPath, [...(preload ? ["--require", preload] : []),
    path.join(f.root, result.decoderPath), ...args], { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  return child;
}
function failed(child, code) {
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, "");
  const result = JSON.parse(child.stderr);
  assert.equal(result.ok, false);
  if (code) assert.equal(result.code, code);
  assert.equal(result.artifactsMayRemain, true);
  assert.ok(!child.stderr.includes(secret) && !child.stderr.includes("base64"));
  return result;
}
async function retained(f, result) {
  for (const file of [result.handoffPath, result.decoderPath]) assert.ok((await fs.stat(path.join(f.root, file))).size > 0);
}
async function rewriteHandoff(f, result, change, rebind = false) {
  const file = path.join(f.root, result.handoffPath);
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  const value = change(data);
  const text = typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value ?? data);
  await fs.writeFile(file, text);
  if (rebind) {
    const stem = path.basename(result.outputPath, ".png");
    await fs.writeFile(path.join(f.root, result.decoderPath), buildImageExportDecoder({
      workspacePath: f.root, stem, jobId: result.jobId, byteLength: result.byteLength,
      sha256: result.sha256, handoffSha256: hash(text),
    }));
  }
}
async function preload(f, result, body) {
  const file = path.join(f.parent, `fault-${randomUUID()}.cjs`);
  await fs.writeFile(file, `const fs = require("node:fs");\nconst output = ${JSON.stringify(path.join(f.root, result.outputPath))};\nconst handoff = ${JSON.stringify(path.join(f.root, result.handoffPath))};\nconst decoder = ${JSON.stringify(path.join(f.root, result.decoderPath))};\n${body}\n`);
  return file;
}
function largePng() {
  function chunk(type, bytes) {
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length); result.write(type, 4, "ascii"); bytes.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  }
  const rows = Buffer.alloc(257 * 256 * 4 + 256);
  let state = 123456789;
  for (let i = 0; i < rows.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5; rows[i] = state & 255;
  }
  for (let i = 0; i < 256; i++) rows[i * (257 * 4 + 1)] = 0;
  const header = Buffer.alloc(13); header.writeUInt32BE(257); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("host export -> authorized decoder writes the entire verified image and removes only its own handoff", async t => {
  const f = await fixture(t, largePng());
  assert.ok(f.bytes.length > 64 * 1024);
  const [result, second] = await Promise.all([f.export(), f.export()]);
  assert.notEqual(result.outputPath, second.outputPath);
  assert.equal(result.status, "handoff-ready");
  assert.match(result.command, /^node 'bone-media\/exports\/image-[0-9a-f-]+\.decode\.cjs'$/);
  assert.ok(JSON.stringify(result).length < 1600);
  assert.ok(!JSON.stringify(result).includes("base64") && !JSON.stringify(result).includes(f.bytes.toString("base64")));
  await absent(path.join(f.root, result.outputPath));
  const data = JSON.parse(await fs.readFile(path.join(f.root, result.handoffPath), "utf8"));
  assert.equal(data.version, 1); assert.equal(data.jobId, f.job.id); assert.deepEqual(Buffer.from(data.base64, "base64"), f.bytes);
  assert.deepEqual(f.calls.filter(call => call.op === "writeText").map(call => path.extname(call.file)).sort(), [".cjs", ".cjs", ".json", ".json"]);
  const child = spawnSync("/bin/sh", ["-c", result.command], { cwd: f.root, encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
  assert.equal(child.error, undefined); assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, "");
  assert.deepEqual(JSON.parse(child.stdout), { ok: true, path: result.outputPath, sha256: hash(f.bytes), byteLength: f.bytes.length });
  const output = await fs.readFile(path.join(f.root, result.outputPath));
  assert.deepEqual(output, f.bytes); assert.equal(hash(output), result.sha256);
  assert.equal((await fs.stat(path.join(f.root, result.outputPath))).mode & 0o777, 0o600);
  await absent(path.join(f.root, result.handoffPath)); await absent(path.join(f.root, result.decoderPath));
  await retained(f, second);
  assert.equal(decode(f, second).status, 0);
});

test("strict arguments reject caller paths and untrusted execution context before any I/O", async t => {
  const f = await fixture(t);
  for (const args of [null, [], {}, { jobId: "../escape" }, { jobId: f.job.id, targetPath: "out.png" },
    { jobId: f.job.id, sessionId: "forged" }, { jobId: f.job.id, [Symbol("extra")]: true }]) {
    await assert.rejects(f.exporter.exportResult(args, f.ctx), safeError("INVALID_ARGUMENT"));
  }
  for (const ctx of [undefined, {}, { ...f.ctx, sessionId: "" }, { ...f.ctx, turnId: null },
    { ...f.ctx, mode: "plan" }, { ...f.ctx, mode: "goal" }]) {
    await assert.rejects(f.exporter.exportResult({ jobId: f.job.id }, ctx), safeError("CONTEXT_REQUIRED"));
  }
  const abort = new AbortController(); abort.abort(secret); f.ctx.signal = abort.signal;
  await assert.rejects(f.export(), safeError("ABORTED"));
  assert.equal(f.workspaceCalls, 0); assert.equal(f.reads, 0); assert.deepEqual(f.calls, []);
});

test("missing, relative, remote and network workspace paths fail closed", async t => {
  const f = await fixture(t);
  for (const current of [null, { path: "relative" }, { path: "ssh://host/root" }, { path: "//host/share" },
    { path: f.root, remote: { path: "/remote", readOnly: true } }, { path: "/bad\0path" }]) {
    f.current = current; await assert.rejects(f.export(), safeError("NO_WORKSPACE"));
  }
  assert.deepEqual(f.calls, []); assert.equal(f.reads, 0);
  f.host.fs.stat = undefined; await assert.rejects(f.export(), safeError("EXPORT_UNAVAILABLE"));
});

for (const code of ["EACCES", "EPERM", "PERMISSION_DENIED", "EIO", "UNKNOWN"]) {
  test(`stat ${code} is fatal and cannot authorize a write`, async t => {
    const f = await fixture(t); f.beforeFs = () => { throw fault(code); };
    await assert.rejects(f.export(), safeError(["EACCES", "EPERM", "PERMISSION_DENIED"].includes(code) ? "PERMISSION_DENIED" : "EXPORT_FAILED"));
    assert.ok(f.calls.every(call => call.op === "stat"));
    await absent(path.join(f.root, "bone-media"));
  });
}

test("known host NOT_FOUND allows creation, but an existing artifact never gets overwritten", async t => {
  const f = await fixture(t); f.notFoundCode = "NOT_FOUND";
  const first = await f.export(); await retained(f, first);
  let collision;
  f.beforeFs = async (op, file) => {
    if (op === "stat" && !collision) {
      collision = path.join(f.root, file); await fs.writeFile(collision, "existing artifact");
    }
  };
  await assert.rejects(f.export(), safeError("EXPORT_CONFLICT"));
  assert.equal(await fs.readFile(collision, "utf8"), "existing artifact");
});

for (const stage of ["readResult", "beforeWrite", "afterWrite", "afterRead", "finalCheck"]) {
  test(`workspace switch at ${stage} refuses success and stops further writes`, async t => {
    const f = await fixture(t);
    const other = path.join(f.parent, "other"); await fs.mkdir(other);
    const switchRoot = () => { f.current = { path: other }; };
    if (stage === "readResult") f.onReadResult = switchRoot;
    if (stage === "beforeWrite") f.host.fs.stat = async () => { switchRoot(); throw fault("ENOENT"); };
    if (stage === "afterWrite") f.afterFs = op => { if (op === "writeText") switchRoot(); };
    if (stage === "afterRead") f.afterFs = op => { if (op === "readText") switchRoot(); };
    if (stage === "finalCheck") f.beforeFs = (op, file) => {
      if (op === "stat" && file.endsWith(".png") && f.calls.filter(call => call.op === "writeText").length === 2) switchRoot();
    };
    await assert.rejects(f.export(), error => {
      assert.equal(error.code, "WORKSPACE_CHANGED");
      if (["afterWrite", "afterRead", "finalCheck"].includes(stage)) assert.equal(error.recovery.status, "incomplete");
      return true;
    });
    const expectedWrites = stage === "finalCheck" ? 2 : ["afterWrite", "afterRead"].includes(stage) ? 1 : 0;
    assert.equal(f.calls.filter(call => call.op === "writeText").length, expectedWrites);
    assert.deepEqual(await fs.readdir(other), []);
  });
}

test("a workspace switch inside a host write is reported after that non-atomic write", async t => {
  const f = await fixture(t); const other = path.join(f.parent, "other"); await fs.mkdir(other);
  f.beforeFs = op => { if (op === "writeText") f.current = { path: other }; };
  let recovery;
  await assert.rejects(f.export(), error => {
    assert.equal(error.code, "WORKSPACE_CHANGED"); recovery = error.recovery;
    assert.match(recovery.diagnostic, /either workspace/); return true;
  });
  assert.equal(f.calls.filter(call => call.op === "writeText").length, 1);
  // The old SDK cannot undo or prevent this write atomically. Never claim success.
  await absent(path.join(f.root, recovery.handoffPath));
  assert.equal(JSON.parse(await fs.readFile(path.join(other, recovery.handoffPath), "utf8")).sha256, hash(f.bytes));
  await absent(path.join(other, recovery.decoderPath)); await absent(path.join(other, recovery.outputPath));
});

test("abort and changed turn during an await invalidate the export", async t => {
  for (const mode of ["abort", "turn", "session", "mode"]) {
    const f = await fixture(t); const abort = new AbortController(); f.ctx.signal = abort.signal;
    f.onReadResult = () => {
      if (mode === "abort") abort.abort(secret);
      if (mode === "turn") f.ctx.turnId = "new-turn";
      if (mode === "session") f.ctx.sessionId = "new-session";
      if (mode === "mode") f.ctx.mode = "plan";
    };
    await assert.rejects(f.export(), safeError(mode === "abort" ? "ABORTED" : "CONTEXT_REQUIRED"));
    assert.deepEqual(f.calls, []);
  }
});

test("readResult failures and mismatched image descriptors are sanitized without artifacts", async t => {
  const f = await fixture(t); f.onReadResult = () => { throw fault("NOT_FOUND"); };
  await assert.rejects(f.export(), safeError("NOT_FOUND"));
  f.onReadResult = null;
  const original = structuredClone(f.job);
  for (const mutate of [job => { job.id = "wrong"; }, job => { job.state = "unknown"; },
    job => { job.result.sha256 = "0".repeat(64); }, job => { job.result.byteLength++; }, job => { job.result.mimeType = "image/jpeg"; }]) {
    f.job = structuredClone(original); mutate(f.job);
    await assert.rejects(f.export(), error => ["RESULT_INVALID", "RESULT_UNAVAILABLE"].includes(error.code));
  }
  assert.deepEqual(f.calls, []);
});

test("partial host writes and failed readback preserve artifacts with a safe recovery diagnostic", async t => {
  for (const failure of ["second-write", "partial-write", "readback"]) {
    const f = await fixture(t);
    if (failure === "readback") f.host.fs.readText = async () => secret;
    else f.beforeFs = async (op, file) => {
      if (op === "writeText" && (failure === "partial-write" || file.endsWith(".cjs"))) {
        if (failure === "partial-write") {
          const full = path.join(f.root, file); await fs.mkdir(path.dirname(full), { recursive: true }); await fs.writeFile(full, "partial");
        }
        throw fault("EIO");
      }
    };
    let error;
    try { await f.export(); assert.fail("must not succeed"); } catch (caught) { error = caught; }
    assert.ok(safeError("EXPORT_FAILED")(error)); assert.equal(error.recovery.status, "incomplete");
    assert.match(error.recovery.diagnostic, /retained/);
    assert.ok((await fs.stat(path.join(f.root, error.recovery.handoffPath))).size > 0);
    await absent(path.join(f.root, error.recovery.outputPath));
    assert.deepEqual(f.bytes, png());
  }
});

const invalidHandoffs = {
  "malformed JSON": () => "{private",
  "invalid UTF-8": () => Buffer.from([0xff]),
  "traversal": data => ({ ...data, outputBasename: "../../escape.png" }),
  "absolute target": data => ({ ...data, outputBasename: "/tmp/escape.png" }),
  "extra executable field": data => ({ ...data, execute: "process.exit(0)" }),
  "version": data => ({ ...data, version: 2 }),
  "wrong job": data => ({ ...data, jobId: `img-${randomUUID()}` }),
  "length": data => ({ ...data, byteLength: data.byteLength + 1 }),
  "digest": data => ({ ...data, sha256: "0".repeat(64) }),
  "noncanonical base64": data => ({ ...data, base64: data.base64.replace(/.$/, " ") }),
  "noncanonical pad bits": data => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const end = data.base64.indexOf("="); assert.ok(end > 0);
    const index = alphabet.indexOf(data.base64[end - 1]);
    return { ...data, base64: data.base64.slice(0, end - 1) + alphabet[index | 1] + data.base64.slice(end) };
  },
  "altered bytes": data => ({ ...data, base64: Buffer.alloc(data.byteLength).toString("base64") }),
};
for (const [name, change] of Object.entries(invalidHandoffs)) {
  test(`decoder rejects ${name} even with a matching envelope digest`, async t => {
    const f = await fixture(t); const result = await f.export();
    // Rebind ONLY the envelope digest to exercise the independent schema/byte checks.
    await rewriteHandoff(f, result, change, true);
    failed(decode(f, result), "INVALID_HANDOFF"); await retained(f, result);
    await absent(path.join(f.root, result.outputPath));
  });
}

test("decoder rejects handoff tampering, oversized JSON, wrong cwd, copied location and extra arguments", async t => {
  const f = await fixture(t);
  for (const kind of ["tamper", "oversized", "cwd", "copy", "args"]) {
    const result = await f.export(); let child;
    if (kind === "tamper") { await rewriteHandoff(f, result, data => ({ ...data, outputBasename: "other.png" })); child = decode(f, result); }
    if (kind === "oversized") { await fs.truncate(path.join(f.root, result.handoffPath), 24 * 1024 * 1024); child = decode(f, result); }
    if (kind === "cwd") child = decode(f, result, { cwd: f.parent });
    if (kind === "args") child = decode(f, result, { args: ["../../escape.png"] });
    if (kind === "copy") {
      const other = path.join(f.parent, "copied"); await fs.mkdir(path.join(other, "bone-media/exports"), { recursive: true });
      for (const file of [result.decoderPath, result.handoffPath]) await fs.copyFile(path.join(f.root, file), path.join(other, file));
      child = decode({ ...f, root: other }, result);
      await absent(path.join(other, result.outputPath));
    }
    failed(child); await retained(f, result); await absent(path.join(f.root, result.outputPath));
  }
});

for (const kind of ["existing", "symlink", "dangling-symlink", "hardlink", "directory"]) {
  test(`decoder never overwrites an output ${kind}`, async t => {
    const f = await fixture(t); const result = await f.export();
    const output = path.join(f.root, result.outputPath); const victim = path.join(f.parent, "victim");
    await fs.writeFile(victim, "preserve me");
    if (kind === "existing") await fs.writeFile(output, "existing output");
    if (kind === "symlink") await fs.symlink(victim, output);
    if (kind === "dangling-symlink") await fs.symlink(path.join(f.parent, "missing"), output);
    if (kind === "hardlink") await fs.link(victim, output);
    if (kind === "directory") await fs.mkdir(output);
    failed(decode(f, result), "OUTPUT_EXISTS"); await retained(f, result);
    assert.equal(await fs.readFile(victim, "utf8"), "preserve me");
    if (kind === "existing") assert.equal(await fs.readFile(output, "utf8"), "existing output");
  });
}

for (const source of ["handoffPath", "decoderPath"]) {
  for (const kind of ["symlink", "hardlink"]) {
    test(`decoder refuses ${source} ${kind} without cleanup`, async t => {
      const f = await fixture(t); const result = await f.export();
      const sourceFile = path.join(f.root, result[source]); const other = path.join(f.parent, `source-${source}.cjs`);
      if (kind === "hardlink") await fs.link(sourceFile, other);
      else { await fs.rename(sourceFile, other); await fs.symlink(other, sourceFile); }
      const before = await fs.readFile(other);
      failed(decode(f, result)); await absent(path.join(f.root, result.outputPath));
      assert.deepEqual(await fs.readFile(other), before); await retained(f, result);
    });
  }
}

for (const relative of ["bone-media", "bone-media/exports"]) {
  test(`decoder refuses symlink ancestry at ${relative}`, async t => {
    const f = await fixture(t); const result = await f.export();
    const directory = path.join(f.root, relative); const moved = path.join(f.parent, "moved");
    await fs.rename(directory, moved); await fs.symlink(moved, directory);
    failed(decode(f, result)); await retained(f, result); await absent(path.join(f.root, result.outputPath));
  });
}

test("decoder partial writes, fsync failure and cleanup denial never print success", async t => {
  for (const kind of ["write", "sync", "cleanup", "second-cleanup"]) {
    const f = await fixture(t); const result = await f.export();
    const body = kind === "write" ? `const original = fs.writeFileSync; fs.writeFileSync = (fd, bytes, ...rest) => {
      if (typeof fd === "number") { fs.writeSync(fd, bytes.subarray(0, 8)); throw Object.assign(new Error(${JSON.stringify(secret)}), { code: "EIO" }); }
      return original(fd, bytes, ...rest);
    };` : kind === "sync" ? `fs.fsyncSync = () => { throw Object.assign(new Error(${JSON.stringify(secret)}), { code: "EIO" }); };`
      : `const original = fs.unlinkSync; fs.unlinkSync = file => {
        if (file === ${kind === "cleanup" ? "handoff" : "decoder"}) throw Object.assign(new Error(${JSON.stringify(secret)}), { code: "EACCES" });
        return original(file);
      };`;
    const diagnostic = failed(decode(f, result, { preload: await preload(f, result, body) }));
    assert.equal(diagnostic.outputVerified, kind.includes("cleanup"));
    const output = await fs.readFile(path.join(f.root, result.outputPath));
    if (kind === "write") assert.equal(output.length, 8); else assert.deepEqual(output, f.bytes);
    if (kind !== "second-cleanup") await retained(f, result);
    else { await absent(path.join(f.root, result.handoffPath)); assert.ok((await fs.stat(path.join(f.root, result.decoderPath))).isFile()); }
  }
});

test("inode replacement and newly added hardlinks are detected before cleanup", async t => {
  for (const kind of ["handoff", "decoder", "output", "output-hardlink"]) {
    const f = await fixture(t); const result = await f.export();
    const target = kind === "output-hardlink" ? "output" : kind;
    const body = `const original = fs.fsyncSync; let changed = false;
      fs.fsyncSync = fd => { original(fd); if (changed || !fs.fstatSync(fd).isFile()) return; changed = true;
        ${kind === "output-hardlink" ? "fs.linkSync(output, output + '.saved');" : `fs.renameSync(${target}, ${target} + '.saved'); fs.copyFileSync(${target} + '.saved', ${target});`}
      };`;
    failed(decode(f, result, { preload: await preload(f, result, body) }));
    await retained(f, result);
    assert.ok((await fs.stat(path.join(f.root, kind === "handoff" ? result.handoffPath : kind === "decoder" ? result.decoderPath : result.outputPath))).isFile());
  }
});
