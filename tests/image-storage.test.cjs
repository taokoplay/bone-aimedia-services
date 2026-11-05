"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { spawn } = require("node:child_process");
const { createImageJobStorage } = require("../lib/image-job-storage.js");
const { MAX_IMAGE_BYTES, validatePng } = require("../lib/image-png.js");

const current = () => {};
const newJob = () => ({ id: `img-${randomUUID()}`, requestHash: "fixture-hash", status: "prepared" });
function parseJob(value) {
  assert.equal(typeof value.id, "string");
  assert.equal(typeof value.requestHash, "string");
  assert.ok(["prepared", "submitted", "succeeded"].includes(value.status));
  return value;
}
const bad = code => error => error.code === code && !/private|sensitive|Bearer|ENOENT|EACCES|EIO|\.json|\.png/.test(error.message);
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "image-storage-"));
  const root = path.join(parent, "private");
  const jobs = path.join(root, "image-jobs");
  const store = createImageJobStorage(() => root, parseJob);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, root, jobs, store, second: () => createImageJobStorage(() => root, parseJob) };
}
async function save(f, job = newJob()) { assert.equal(await f.store.create(job), true); return job; }
async function rawJob(f, job, bytes = JSON.stringify(job)) {
  await fs.writeFile(path.join(f.jobs, `${job.id}.json`), bytes, { mode: 0o600 });
}
async function seedJobs(f, count) {
  const jobs = Array.from({ length: count }, newJob);
  await Promise.all(jobs.map(async (job, index) => {
    await fs.writeFile(path.join(f.jobs, `.slot-${index + 1}`), `${job.id}\n`, { mode: 0o600 });
    await rawJob(f, job);
  }));
}

// A bitwise reference CRC keeps the PNG fixtures independent of the validator's table.
function chunk(type, bytes = Buffer.alloc(0)) {
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); result.write(type, 4, "ascii"); bytes.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
const signature = Buffer.from("89504e470d0a1a0a", "hex");
function header({ width = 1, height = 1, depth = 8, color = 6, compression = 0, filter = 0, interlace = 0 } = {}) {
  const bytes = Buffer.alloc(13);
  bytes.writeUInt32BE(width); bytes.writeUInt32BE(height, 4);
  bytes[8] = depth; bytes[9] = color; bytes[10] = compression; bytes[11] = filter; bytes[12] = interlace;
  return chunk("IHDR", bytes);
}
const end = () => chunk("IEND");
const pngParts = (...parts) => Buffer.concat([signature, ...parts]);
const png = (options = {}, rows = Buffer.from([0, 12, 34, 56, 255])) => pngParts(header(options), chunk("IDAT", deflateSync(rows)), end());

// Independent processes start together via IPC, without timing-based test sleeps.
async function processes(t, f, operation, jobs) {
  const script = `
    const { createImageJobStorage } = require(process.argv[1]);
    const store = createImageJobStorage(() => process.argv[2], value => value);
    const job = JSON.parse(process.argv[4]);
    process.once("message", async () => {
      try {
        const result = await store[process.argv[3]](process.argv[3] === "create" ? job : job.id);
        process.send({ result }, () => process.disconnect());
      } catch (error) { process.send({ error: error.code }, () => process.disconnect()); }
    });
    process.send({ ready: true });
  `;
  const children = jobs.map(job => {
    const child = spawn(process.execPath, ["-e", script, require.resolve("../lib/image-job-storage.js"), f.root, operation, JSON.stringify(job)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let readyResolve, readyReject, resultResolve, resultReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    child.on("message", message => { if (message.ready) readyResolve(); else resultResolve(message); });
    child.on("error", error => { readyReject(error); resultReject(error); });
    child.on("exit", code => { if (code !== 0) { const error = new Error(`Child exited: ${code}`); readyReject(error); resultReject(error); } });
    return { child, ready, result };
  });
  await Promise.all(children.map(child => child.ready));
  children.forEach(({ child }) => child.send("go"));
  return Promise.all(children.map(child => child.result));
}

test("prepare, claim, save result, finish, and restart preserve jobs and private permissions", async t => {
  const f = await fixture(t); const job = newJob();
  assert.deepEqual(await f.store.list(), []);
  await assert.rejects(f.store.read(job.id), bad("NOT_FOUND"));
  await assert.rejects(fs.stat(f.root), { code: "ENOENT" });
  await save(f, job);
  assert.equal(await f.store.hasClaim(job.id), false);
  assert.equal(await f.store.claim(job.id), true);
  await f.store.write({ ...job, status: "submitted" }, current);
  const bytes = png(); const descriptor = validatePng(bytes);
  await f.store.writeResult(job.id, bytes, current);
  const completed = { ...job, status: "succeeded", result: descriptor };
  await f.store.write(completed, current);
  const restarted = f.second();
  assert.deepEqual(await restarted.read(job.id), completed);
  assert.deepEqual(await restarted.list(), [completed]);
  assert.equal(await restarted.hasClaim(job.id), true);
  assert.equal(await restarted.claim(job.id), false);
  assert.deepEqual(await restarted.readResult(job.id), bytes);
  const detached = await restarted.readResult(job.id); detached.fill(0);
  assert.deepEqual(await restarted.readResult(job.id), bytes);
  for (const dir of [f.root, f.jobs]) assert.equal((await fs.lstat(dir)).mode & 0o777, 0o700);
  assert.deepEqual((await fs.readdir(f.jobs)).sort(), [".slot-0", `${job.id}.json`, `${job.id}.png`, `${job.id}.submitted`]);
  for (const name of await fs.readdir(f.jobs)) {
    const stat = await fs.lstat(path.join(f.jobs, name));
    assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.nlink, 1);
  }
});

test("two stores create atomically without replacing the winner and exclusively claim once", async t => {
  const f = await fixture(t); const job = newJob(); const second = f.second();
  const alternate = { ...job, requestHash: "alternate" };
  const created = await Promise.all([f.store.create(job), second.create(alternate)]);
  assert.deepEqual([...created].sort(), [false, true]);
  const winner = created[0] ? job : alternate;
  assert.deepEqual(await f.store.read(job.id), winner);
  assert.equal(await second.create({ ...job, status: "succeeded" }), false);
  assert.deepEqual(await second.read(job.id), winner);
  const claims = await Promise.all([f.store.claim(job.id), second.claim(job.id)]);
  assert.deepEqual(claims.sort(), [false, true]);
});

test("independent processes preserve exclusive creation and submission", { timeout: 15000 }, async t => {
  const f = await fixture(t); const job = newJob();
  const created = await processes(t, f, "create", [job, { ...job, requestHash: "other-process" }]);
  assert.deepEqual(created.map(item => item.result).sort(), [false, true]);
  assert.ok(created.every(item => !item.error));
  assert.deepEqual((await fs.readdir(f.jobs)).filter(name => name.startsWith(".slot-")), [".slot-0"]);
  const claims = await processes(t, f, "claim", [job, job]);
  assert.deepEqual(claims.map(item => item.result).sort(), [false, true]);
  assert.ok(claims.every(item => !item.error));
});

test("corrupt, oversized, invalid UTF-8, and mismatched jobs never reset or overwrite", async t => {
  const f = await fixture(t); const job = await save(f);
  for (const raw of ["{sensitive", JSON.stringify({ ...job, status: "invalid" }), JSON.stringify(newJob()), " ".repeat(65537), Buffer.from([0xff, 0xfe])]) {
    await rawJob(f, job, raw);
    for (const action of [() => f.store.read(job.id), () => f.store.list(), () => f.store.create(job), () => f.store.write(job, current), () => f.store.claim(job.id)]) {
      await assert.rejects(action(), bad("STORAGE_ERROR"));
    }
    assert.deepEqual(await fs.readFile(path.join(f.jobs, `${job.id}.json`)), Buffer.from(raw));
  }
  await assert.rejects(f.store.create({ ...newJob(), padding: "x".repeat(65536) }), bad("STORAGE_ERROR"));
});

test("missing jobs and interrupted submission markers fail closed", async t => {
  const f = await fixture(t); const job = await save(f); const missing = newJob();
  for (const action of [() => f.store.claim(missing.id), () => f.store.hasClaim(missing.id), () => f.store.write(missing, current), () => f.store.readResult(missing.id)]) {
    await assert.rejects(action(), bad("NOT_FOUND"));
  }
  await assert.rejects(f.store.writeResult(job.id, png(), current), bad("STORAGE_ERROR"));
  const marker = path.join(f.jobs, `${job.id}.submitted`);
  await fs.writeFile(marker, "", { mode: 0o600 });
  await assert.rejects(f.store.claim(job.id), bad("STORAGE_ERROR"));
  await assert.rejects(f.second().hasClaim(job.id), bad("STORAGE_ERROR"));
  assert.equal(await fs.readFile(marker, "utf8"), "");
  await fs.unlink(path.join(f.jobs, `${job.id}.json`));
  await assert.rejects(f.second().create(job), bad("STORAGE_ERROR"));
  assert.equal(await fs.readFile(marker, "utf8"), "");
});

test("stale checks after temporary writes preserve jobs and prevent result publication", async t => {
  const f = await fixture(t); const job = await save(f);
  let calls = 0;
  const stale = async () => { if (++calls === 2) throw Object.assign(new Error("sensitive private path"), { code: "CONFLICT" }); };
  await assert.rejects(f.store.write({ ...job, status: "submitted" }, stale), bad("CONFLICT"));
  assert.deepEqual(await f.store.read(job.id), job);
  assert.equal(await f.store.claim(job.id), true);
  calls = 0;
  await assert.rejects(f.store.writeResult(job.id, png(), stale), bad("CONFLICT"));
  await assert.rejects(f.store.readResult(job.id), bad("NOT_FOUND"));
  await assert.rejects(f.store.write(job, () => false), bad("CONFLICT"));
  await assert.rejects(f.store.write(job, () => { throw Object.assign(new Error("private path"), { code: "DISPOSED" }); }), bad("DISPOSED"));
  assert.deepEqual((await fs.readdir(f.jobs)).sort(), [".slot-0", `${job.id}.json`, `${job.id}.submitted`]);
});

test("publication exposes complete files and failures preserve the previous version", async t => {
  const f = await fixture(t); const job = newJob(); const link = fs.link;
  let publishing = 0;
  const mock = t.mock.method(fs, "link", async (from, to) => {
    if (to === path.join(f.jobs, `${job.id}.json`)) {
      publishing++;
      assert.deepEqual(JSON.parse(await fs.readFile(from, "utf8")), job);
      await assert.rejects(fs.stat(to), { code: "ENOENT" });
    }
    return link(from, to);
  });
  await save(f, job); mock.mock.restore(); assert.equal(publishing, 1);
  const failed = t.mock.method(fs, "rename", async () => { throw Object.assign(new Error(`EIO ${f.root}`), { code: "EIO" }); });
  await assert.rejects(f.store.write({ ...job, status: "submitted" }, current), bad("STORAGE_ERROR"));
  failed.mock.restore();
  assert.deepEqual(await f.second().read(job.id), job);
  assert.deepEqual((await fs.readdir(f.jobs)).sort(), [".slot-0", `${job.id}.json`]);
});

test("result writes are immutable, identical retries work, and both directions enforce 16 MiB", async t => {
  const f = await fixture(t); const job = await save(f); await f.store.claim(job.id);
  const bytes = png();
  await f.store.writeResult(job.id, bytes, current);
  await f.second().writeResult(job.id, Buffer.from(bytes), current);
  await assert.rejects(f.store.writeResult(job.id, png({}, Buffer.from([0, 1, 2, 3, 4])), current), bad("STORAGE_ERROR"));
  await assert.rejects(f.store.writeResult(job.id, Buffer.alloc(MAX_IMAGE_BYTES + 1), current), bad("STORAGE_ERROR"));
  assert.deepEqual(await f.store.readResult(job.id), bytes);
  const second = await save(f); await f.store.claim(second.id);
  const limit = Buffer.alloc(MAX_IMAGE_BYTES, 42);
  await f.store.writeResult(second.id, limit, current);
  assert.deepEqual(await f.store.readResult(second.id), limit);
  await fs.truncate(path.join(f.jobs, `${second.id}.png`), MAX_IMAGE_BYTES + 1);
  await assert.rejects(f.store.readResult(second.id), bad("STORAGE_ERROR"));
});

test("all entry points reject unsafe ids without creating files", async t => {
  const f = await fixture(t);
  for (const id of ["", "../other-plugin/job", "/tmp/job", "img-00000000-0000-1000-8000-000000000000", "img-00000000-0000-4000-7000-000000000000", `${newJob().id}/x`, `${newJob().id}\0`, `${newJob().id}.json`, newJob().id.toUpperCase()]) {
    for (const action of [() => f.store.read(id), () => f.store.create({ ...newJob(), id }), () => f.store.write({ ...newJob(), id }, current), () => f.store.claim(id), () => f.store.hasClaim(id), () => f.store.writeResult(id, png(), current), () => f.store.readResult(id)]) {
      await assert.rejects(action(), bad("STORAGE_ERROR"));
    }
  }
  await assert.rejects(fs.stat(f.root), { code: "ENOENT" });
});

test("root and job directory symlinks, replacements, and changed data paths are refused", async t => {
  for (const target of ["root", "jobs"]) {
    const f = await fixture(t); const elsewhere = path.join(f.parent, "elsewhere");
    await fs.mkdir(elsewhere);
    if (target === "jobs") await fs.mkdir(f.root);
    await fs.symlink(elsewhere, target === "root" ? f.root : f.jobs);
    await assert.rejects(f.store.create(newJob()), bad("STORAGE_ERROR"));
    await assert.rejects(f.store.list(), bad("STORAGE_ERROR"));
    assert.deepEqual(await fs.readdir(elsewhere), []);
  }
  const f = await fixture(t); await save(f);
  await fs.rename(f.jobs, path.join(f.root, "old-jobs")); await fs.mkdir(f.jobs);
  await assert.rejects(f.store.list(), bad("STORAGE_ERROR"));
  const g = await fixture(t); let supplied = g.root;
  const changing = createImageJobStorage(() => supplied, parseJob);
  await changing.create(newJob()); supplied = path.join(g.parent, "other-plugin");
  await assert.rejects(changing.list(), bad("STORAGE_ERROR"));
  await assert.rejects(fs.stat(supplied), { code: "ENOENT" });
  for (const suppliedPath of ["relative/path", "/", `${g.root}\0`]) {
    await assert.rejects(createImageJobStorage(() => suppliedPath, parseJob).list(), bad("STORAGE_ERROR"));
  }
});

for (const link of ["symlink", "link"]) {
  test(`${link} job, marker, and result files are refused`, async t => {
    for (const suffix of ["json", "submitted", "png"]) {
      const f = await fixture(t); const job = await save(f);
      const external = path.join(f.parent, "sensitive");
      const content = suffix === "json" ? JSON.stringify(job) : "outside bytes";
      await fs.writeFile(external, content, { mode: 0o600 });
      const target = path.join(f.jobs, `${job.id}.${suffix}`);
      if (suffix === "json") await fs.unlink(target);
      if (suffix === "png") await f.store.claim(job.id);
      await fs[link](external, target);
      const actions = suffix === "json" ? [() => f.store.read(job.id), () => f.store.list(), () => f.store.write(job, current), () => f.store.create(job)]
        : suffix === "submitted" ? [() => f.store.claim(job.id), () => f.store.hasClaim(job.id)]
          : [() => f.store.readResult(job.id), () => f.store.writeResult(job.id, png(), current)];
      for (const action of actions) await assert.rejects(action(), bad("STORAGE_ERROR"));
      assert.equal(await fs.readFile(external, "utf8"), content);
    }
  });
}

test("job limit is enforced, overflow is rejected, and unknown names are not parsed", async t => {
  const f = await fixture(t); const first = await save(f);
  await seedJobs(f, 199);
  await fs.writeFile(path.join(f.jobs, "not-a-job.json"), "broken");
  assert.equal((await f.store.list()).length, 200);
  assert.equal(await f.store.create(first), false);
  await assert.rejects(f.store.create(newJob()), bad("GENERATION_LIMIT"));
  await rawJob(f, newJob());
  await assert.rejects(f.store.list(), bad("GENERATION_LIMIT"));
});

test("interrupted publication and a legacy lock artifact do not block another job", async t => {
  const f = await fixture(t); const interrupted = await save(f);
  const temp = path.join(f.jobs, `.interrupted-${randomUUID()}.tmp`);
  await fs.link(path.join(f.jobs, `${interrupted.id}.json`), temp);
  const lock = path.join(f.jobs, ".publish.lock");
  await fs.writeFile(lock, "", { mode: 0o600 });
  const store = f.second(); const job = newJob();
  assert.equal(await store.create(job), true);
  assert.equal(await store.claim(job.id), true);
  await store.write({ ...job, status: "submitted" }, current);
  await store.writeResult(job.id, png(), current);
  assert.deepEqual(await store.readResult(job.id), png());
  await assert.rejects(store.read(interrupted.id), bad("STORAGE_ERROR"));
  assert.equal(await fs.readFile(lock, "utf8"), "");
  assert.equal((await fs.lstat(temp)).nlink, 2);
});

test("PNG metadata includes the byte digest and explicitly leaves quality unreviewed", () => {
  const bytes = png();
  assert.equal(chunk("IEND").toString("hex"), "0000000049454e44ae426082");
  assert.deepEqual(validatePng(bytes), {
    mimeType: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    width: 1, height: 1, verification: "png-validated", quality: "not-reviewed",
  });
  for (const [color, depths, channels] of [[0, [1, 2, 4, 8, 16], 1], [2, [8, 16], 3], [3, [1, 2, 4, 8], 1], [4, [8, 16], 2], [6, [8, 16], 4]]) {
    for (const depth of depths) {
      const rows = Buffer.alloc(Math.ceil(3 * channels * depth / 8) + 1);
      const chunks = [header({ width: 3, color, depth })];
      if (color === 3) chunks.push(chunk("PLTE", Buffer.from([1, 2, 3])));
      const compressed = deflateSync(rows);
      chunks.push(chunk("IDAT", compressed.subarray(0, 2)), chunk("IDAT"), chunk("IDAT", compressed.subarray(2)), end());
      assert.equal(validatePng(pngParts(...chunks)).width, 3);
    }
  }
  const rows = Buffer.from([0, 9, 1, 9, 2, 9, 3, 9, 4, 9]);
  assert.equal(validatePng(png({ color: 0, height: 5 }, rows)).height, 5);
});

test("PNG rejects CRC damage, truncated chunks, missing IEND, trailing bytes and oversized input", () => {
  const bytes = png();
  for (const index of [0, 29, 40, bytes.length - 1]) {
    const corrupt = Buffer.from(bytes); corrupt[index] ^= 1;
    assert.throws(() => validatePng(corrupt), bad("RESULT_INVALID"));
  }
  for (let length = 0; length < bytes.length; length++) {
    assert.throws(() => validatePng(bytes.subarray(0, length)), bad("RESULT_INVALID"));
  }
  for (const value of [Buffer.concat([bytes, Buffer.from([0])]), Buffer.alloc(MAX_IMAGE_BYTES + 1), "not a buffer", null]) {
    assert.throws(() => validatePng(value), bad("RESULT_INVALID"));
  }
});

test("PNG rejects unsupported dimensions, header modes, APNG, unknown critical chunks and chunk order", () => {
  for (const options of [{ width: 0 }, { height: 0 }, { width: 4097 }, { height: 4097 }, { depth: 3 }, { color: 1 }, { color: 5 }, { color: 2, depth: 4 }, { color: 3, depth: 16 }, { compression: 1 }, { filter: 1 }, { interlace: 1 }]) {
    assert.throws(() => validatePng(png(options)), bad("RESULT_INVALID"));
  }
  const data = chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4])));
  for (const type of ["acTL", "fcTL", "fdAT", "ABCD", "abca", "1BCD"]) {
    assert.throws(() => validatePng(pngParts(header(), chunk(type), data, end())), bad("RESULT_INVALID"));
  }
  for (const chunks of [[data, header(), end()], [header(), header(), data, end()], [chunk("IHDR", Buffer.alloc(12)), data, end()], [header(), data, chunk("tEXt"), data, end()], [header(), data, chunk("PLTE", Buffer.alloc(3)), end()], [header(), data, chunk("IEND", Buffer.from([0]))], [header(), end()]]) {
    assert.throws(() => validatePng(pngParts(...chunks)), bad("RESULT_INVALID"));
  }
  assert.equal(validatePng(pngParts(header(), chunk("tEXt", Buffer.from("key\0value")), data, end())).width, 1);
});

test("PNG requires a valid palette before indexed data and forbids grayscale palettes", () => {
  const data = chunk("IDAT", deflateSync(Buffer.from([0, 0])));
  for (const chunks of [[header({ color: 3 }), data, end()], [header({ color: 3 }), chunk("PLTE"), data, end()], [header({ color: 3 }), chunk("PLTE", Buffer.alloc(4)), data, end()], [header({ color: 3, depth: 1 }), chunk("PLTE", Buffer.alloc(9)), data, end()], [header({ color: 3 }), chunk("PLTE", Buffer.alloc(771)), data, end()], [header({ color: 0 }), chunk("PLTE", Buffer.alloc(3)), data, end()], [header({ color: 3 }), chunk("PLTE", Buffer.alloc(3)), chunk("PLTE", Buffer.alloc(3)), data, end()]]) {
    assert.throws(() => validatePng(pngParts(...chunks)), bad("RESULT_INVALID"));
  }
});

test("PNG bounds inflation and rejects wrong row sizes, invalid filters and incomplete or trailing zlib streams", () => {
  for (const rows of [Buffer.alloc(4), Buffer.alloc(6), Buffer.from([5, 0, 0, 0, 0]), Buffer.alloc(8 * 1024 * 1024)]) {
    assert.throws(() => validatePng(png({}, rows)), bad("RESULT_INVALID"));
  }
  const compressed = deflateSync(Buffer.from([0, 1, 2, 3, 4]));
  for (const stream of [compressed.subarray(0, -1), Buffer.concat([compressed, Buffer.from([0])]), Buffer.concat([compressed, compressed]), Buffer.from("not zlib")]) {
    assert.throws(() => validatePng(pngParts(header(), chunk("IDAT", stream), end())), bad("RESULT_INVALID"));
  }
});

test("parser and data-root failures cannot impersonate storage status codes", async t => {
  const f = await fixture(t); const job = await save(f);
  for (const code of ["NOT_FOUND", "CONFLICT", "DISPOSED", "GENERATION_LIMIT"]) {
    const broken = () => { throw Object.assign(new Error("sensitive private path"), { code }); };
    await assert.rejects(createImageJobStorage(() => f.root, broken).read(job.id), bad("STORAGE_ERROR"));
    await assert.rejects(createImageJobStorage(broken, parseJob).read(job.id), bad("STORAGE_ERROR"));
  }
});

test("the final current check runs after filesystem preparation and immediately before publication", async t => {
  const f = await fixture(t); const job = await save(f);
  const open = fs.open; const rename = fs.rename; let checked = false;
  t.mock.method(fs, "open", (...args) => { checked = false; return open(...args); });
  t.mock.method(fs, "rename", async (...args) => { assert.equal(checked, true); return rename(...args); });
  const updated = { ...job, status: "submitted" };
  await f.store.write(updated, () => { checked = true; });
  assert.deepEqual(await f.store.read(job.id), updated);
});

test("independent creators cannot exceed the last available job slot", { timeout: 15000 }, async t => {
  const f = await fixture(t); await save(f);
  await seedJobs(f, 198);
  const results = await processes(t, f, "create", [newJob(), newJob()]);
  assert.equal(results.filter(item => item.result === true).length, 1);
  assert.equal(results.filter(item => item.error === "GENERATION_LIMIT").length, 1);
  assert.equal((await f.store.list()).length, 200);
});

test("readers wait for publication cleanup without accepting or deleting persistent links", { timeout: 10000 }, async t => {
  const f = await fixture(t); const job = await save(f);
  const file = path.join(f.jobs, `${job.id}.json`); const temp = path.join(f.jobs, ".publication.tmp");
  await fs.link(file, temp);
  const lstat = fs.lstat; const open = fs.open;
  let observed;
  const linked = new Promise(resolve => { observed = resolve; });
  t.mock.method(fs, "lstat", async (...args) => {
    const stat = await lstat(...args);
    if (args[0] === file && stat.nlink === 2) observed();
    return stat;
  });
  t.mock.method(fs, "open", async (...args) => {
    if (args[0] === file) assert.equal((await lstat(file)).nlink, 1);
    return open(...args);
  });
  const reading = f.store.read(job.id);
  await linked; await fs.unlink(temp); // The publisher, not the reader, removes its temporary name.
  assert.deepEqual(await reading, job);
  await fs.link(file, temp);
  await assert.rejects(f.store.read(job.id), bad("STORAGE_ERROR"));
  assert.equal((await lstat(temp)).nlink, 2);
});

test("unsafe and incomplete reservations consume only their own slots", async t => {
  const f = await fixture(t); await save(f); const job = newJob();
  const external = path.join(f.parent, "external");
  await fs.writeFile(external, `${job.id}\n`, { mode: 0o600 });
  await fs.symlink(external, path.join(f.jobs, ".slot-1"));
  await fs.link(external, path.join(f.jobs, ".slot-2"));
  await fs.writeFile(path.join(f.jobs, ".slot-3"), "", { mode: 0o600 });
  assert.equal(await f.second().create(job), true);
  assert.equal(await fs.readFile(path.join(f.jobs, ".slot-4"), "utf8"), `${job.id}\n`);
  assert.equal(await fs.readFile(external, "utf8"), `${job.id}\n`);
  assert.equal((await fs.lstat(external)).nlink, 2);
  assert.equal(await fs.readFile(path.join(f.jobs, ".slot-3"), "utf8"), "");
});

test("read methods leave permissions and directory entries unchanged", async t => {
  const f = await fixture(t); const job = await save(f);
  await f.store.claim(job.id); await f.store.writeResult(job.id, png(), current);
  const before = await fs.readdir(f.jobs);
  const reader = f.second();
  for (const method of ["mkdir", "unlink", "link", "rename", "chmod", "writeFile"]) {
    t.mock.method(fs, method, () => { assert.fail("Read attempted a filesystem mutation"); });
  }
  await reader.read(job.id); await reader.hasClaim(job.id); await reader.readResult(job.id); await reader.list();
  assert.deepEqual(await fs.readdir(f.jobs), before);
  const handle = await fs.open(f.root, "r");
  try { await handle.chmod(0o755); } finally { await handle.close(); }
  await assert.rejects(reader.list(), bad("STORAGE_ERROR"));
  assert.equal((await fs.lstat(f.root)).mode & 0o777, 0o755);
  t.mock.restoreAll();
});

test("a killed publisher affects only its slot or job at each exclusive publication boundary", { timeout: 20000 }, async t => {
  for (const boundary of [".slot-0", ".json", ".submitted", ".png"]) {
    const f = await fixture(t); const interrupted = newJob();
    const script = `
      const fs = require("node:fs/promises");
      const { createImageJobStorage } = require(process.argv[1]);
      const job = JSON.parse(process.argv[3]); const link = fs.link;
      fs.link = async (from, to) => {
        await link(from, to);
        if (to.endsWith(process.argv[4])) {
          process.send({ paused: true });
          await new Promise(() => {});
        }
      };
      (async () => {
        const store = createImageJobStorage(() => process.argv[2], value => value);
        await store.create(job); await store.claim(job.id);
        await store.writeResult(job.id, Buffer.from([1]), () => {});
      })().catch(error => process.send({ error: error.code }));
    `;
    const child = spawn(process.execPath, ["-e", script, require.resolve("../lib/image-job-storage.js"), f.root, JSON.stringify(interrupted), boundary], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const exited = new Promise(resolve => child.once("exit", resolve));
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("message", message => message.paused ? resolve() : reject(new Error(message.error)));
      child.once("exit", () => reject(new Error("Publisher exited before the interruption boundary")));
    });
    child.kill("SIGKILL"); await exited;
    const job = await save(f); assert.equal(await f.store.claim(job.id), true);
    await f.store.write({ ...job, status: "submitted" }, current);
    await f.store.writeResult(job.id, png(), current);
    assert.deepEqual(await f.second().readResult(job.id), png());
    const stuck = path.join(f.jobs, boundary === ".slot-0" ? boundary : `${interrupted.id}${boundary}`);
    assert.equal((await fs.lstat(stuck)).nlink, 2);
  }
});

test("a duplicate published during the final capacity check returns false without replacement", async t => {
  const f = await fixture(t); await save(f); await seedJobs(f, 198);
  const requested = newJob(); const winner = { ...requested, requestHash: "concurrent-winner" };
  const opendir = fs.opendir;
  const scan = t.mock.method(fs, "opendir", async (...args) => {
    await fs.writeFile(path.join(f.jobs, ".slot-199"), `${winner.id}\n`, { mode: 0o600 });
    await rawJob(f, winner);
    return opendir(...args);
  });
  assert.equal(await f.store.create(requested), false); scan.mock.restore();
  assert.deepEqual(await f.store.read(winner.id), winner);
  assert.equal((await f.store.list()).length, 200);
});
