"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const MAX_JOB_BYTES = 64 * 1024;
const MAX_JOBS = 200;
const SLOT_BYTES = 41; // A fixed UUID job id and newline.
const queues = new Map();
function messages(kind) { return {
  STORAGE_ERROR: `${kind[0].toUpperCase()}${kind.slice(1)} job storage could not be accessed safely.`,
  NOT_FOUND: `The ${kind} job or result was not found.`,
  GENERATION_LIMIT: `The ${kind} job storage limit has been reached.`,
  CONFLICT: `The ${kind} job operation is no longer current.`,
  DISPOSED: `The ${kind} job service is no longer available.`,
}; }

class MediaStorageError extends Error {
  constructor(code, kind = "media") { super(messages(kind)[code]); this.code = code; }
}
function fail(code = "STORAGE_ERROR") { throw new MediaStorageError(code); }
function requireSafe(value) { if (!value) fail(); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function regular(stat, limit, maxLinks = 1) {
  requireSafe(stat.isFile() && !stat.isSymbolicLink() && stat.nlink >= 1 && stat.nlink <= maxLinks && stat.size <= limit);
  requireSafe((stat.mode & 0o777) === 0o600);
}
async function lstat(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function syncHandle(handle) {
  try { await handle.sync(); } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
  }
}
function serialized(root, action) {
  const next = (queues.get(root) || Promise.resolve()).then(action, action);
  queues.set(root, next);
  const release = () => { if (queues.get(root) === next) queues.delete(root); };
  next.then(release, release);
  return next;
}

// Domain adapters select a namespace; all publication and safety rules stay here.
function createMediaJobStorage(getDataPath, parseJob, { kind, idPattern: ID, resultExtension, maxResultBytes }) {
  requireSafe(["image", "audio"].includes(kind) && ID instanceof RegExp && !ID.global && !ID.sticky);
  requireSafe(["png", "mp3"].includes(resultExtension) && Number.isSafeInteger(maxResultBytes) && maxResultBytes >= MAX_JOB_BYTES);
  const MARKER = Buffer.from(`${kind}-job-submitted-v1\n`);
  function validId(id) { requireSafe(typeof id === "string" && ID.test(id)); return id; }
  requireSafe(typeof getDataPath === "function" && typeof parseJob === "function");
  requireSafe(typeof constants.O_NOFOLLOW === "number" && typeof constants.O_DIRECTORY === "number");
  let root;
  const identities = new Map();

  async function resolveRoot() {
    const supplied = await getDataPath();
    requireSafe(typeof supplied === "string" && !supplied.includes("\0") && path.isAbsolute(supplied));
    const resolved = path.resolve(supplied);
    requireSafe(resolved !== path.parse(resolved).root && (!root || root === resolved));
    root = resolved;
    return root;
  }
  async function directory(file, create) {
    let stat = await lstat(file);
    let created = false;
    if (!stat) {
      requireSafe(!identities.has(file));
      if (!create) return false;
      try { await fs.mkdir(file, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
      stat = await fs.lstat(file);
    }
    requireSafe(stat.isDirectory() && !stat.isSymbolicLink());
    requireSafe(!identities.has(file) || sameFile(identities.get(file), stat));
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      requireSafe(sameFile(stat, await handle.stat()));
      if ((stat.mode & 0o777) !== 0o700) {
        requireSafe(create);
        await handle.chmod(0o700);
      }
      requireSafe(sameFile(stat, await fs.lstat(file)));
    } finally { await handle.close(); }
    identities.set(file, stat);
    if (created) {
      const parent = await fs.open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await syncHandle(parent); } finally { await parent.close(); }
    }
    return true;
  }
  async function paths(create = false) {
    await resolveRoot();
    const jobs = path.join(root, `${kind}-jobs`);
    if (!create) {
      const rootStat = await lstat(root);
      if (!rootStat) { requireSafe(!identities.has(root)); return null; }
      requireSafe(rootStat.isDirectory() && !rootStat.isSymbolicLink());
      requireSafe(!identities.has(root) || sameFile(identities.get(root), rootStat));
      // The host creates a new plugin data root as 0755. There is no job data
      // to expose until this store exists; reads stay non-mutating. First create
      // still hardens both directories, and existing stores retain strict checks.
      if (!await lstat(jobs)) { requireSafe(!identities.has(jobs)); identities.set(root, rootStat); return null; }
    }
    if (!await directory(root, create)) return null;
    if (!await directory(jobs, create)) return null;
    return jobs;
  }
  async function guard(jobs) { requireSafe(await paths() === jobs); }
  async function syncDirectory(jobs) {
    await guard(jobs);
    const handle = await fs.open(jobs, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      requireSafe(sameFile(identities.get(jobs), await handle.stat()));
      await syncHandle(handle);
    } finally { await handle.close(); }
  }
  async function run(action) {
    try {
      const resolved = await resolveRoot();
      return await serialized(resolved, action);
    } catch (error) {
      throw new MediaStorageError(error instanceof MediaStorageError ? error.code : "STORAGE_ERROR", kind);
    }
  }
  async function current(checkCurrent) {
    if (checkCurrent === undefined) return;
    requireSafe(typeof checkCurrent === "function");
    try {
      if (await checkCurrent() === false) fail("CONFLICT");
    } catch (error) {
      fail(["CONFLICT", "DISPOSED"].includes(error?.code) ? error.code : "STORAGE_ERROR");
    }
  }
  function parsed(bytes, id) {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const job = parseJob(JSON.parse(raw), raw);
    requireSafe(job && job.id === id);
    return job;
  }
  function encode(job) {
    const id = validId(job?.id);
    const bytes = Buffer.from(JSON.stringify(job), "utf8");
    requireSafe(bytes.length <= MAX_JOB_BYTES);
    parsed(bytes, id);
    return { id, bytes };
  }
  async function singleLink(jobs, file, limit) {
    let identity;
    for (let attempt = 0; attempt <= 40; attempt++) {
      await guard(jobs);
      const stat = await lstat(file);
      if (!stat) fail("NOT_FOUND");
      regular(stat, limit, 2);
      requireSafe(!identity || sameFile(identity, stat));
      if (stat.nlink === 1) return stat;
      // Publication briefly has two names. Never read or reclaim a persistent hardlink.
      identity = stat;
      if (attempt === 40) fail();
      await delay(10);
    }
  }
  async function readPrivate(jobs, basename, limit) {
    const file = path.join(jobs, basename);
    const before = await singleLink(jobs, file, limit);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat(); regular(stat, limit);
      requireSafe(sameFile(before, stat));
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat(); regular(after, limit);
      requireSafe(offset === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs);
      await guard(jobs);
      const target = await fs.lstat(file); regular(target, limit);
      requireSafe(sameFile(stat, target));
      return buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }
  async function readJob(jobs, id) {
    if (!jobs) fail("NOT_FOUND");
    return parsed(await readPrivate(jobs, `${id}.json`, MAX_JOB_BYTES), id);
  }
  async function hasMarker(jobs, id) {
    await guard(jobs);
    if (!await lstat(path.join(jobs, `${id}.submitted`))) return false;
    requireSafe((await readPrivate(jobs, `${id}.submitted`, MARKER.length)).equals(MARKER));
    return true;
  }
  async function names(jobs) {
    if (!jobs) return [];
    await guard(jobs);
    const result = [];
    const dir = await fs.opendir(jobs);
    let scanned = 0;
    for await (const entry of dir) {
      requireSafe(++scanned <= MAX_JOBS * 6 + 32);
      // Slots, temporary files, and obsolete .publish.lock artifacts are not jobs.
      if (!entry.name.endsWith(".json") || !ID.test(entry.name.slice(0, -5))) continue;
      result.push(entry.name.slice(0, -5));
      if (result.length > MAX_JOBS) fail("GENERATION_LIMIT");
    }
    await guard(jobs);
    return result.sort();
  }
  async function removeOwned(jobs, file, identity) {
    await guard(jobs);
    const stat = await fs.lstat(file);
    regular(stat, maxResultBytes, 2);
    requireSafe(sameFile(stat, identity));
    await fs.unlink(file);
  }
  async function publish(jobs, basename, bytes, checkCurrent, verifyTarget, replace = false) {
    const temp = path.join(jobs, `.${basename}-${randomUUID()}.tmp`);
    await guard(jobs);
    const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let identity;
    let renamed = false;
    try {
      identity = await handle.stat();
      await handle.chmod(0o600);
      await handle.writeFile(bytes); await handle.sync();
      regular(await handle.stat(), maxResultBytes);
      if (verifyTarget) await verifyTarget();
      await guard(jobs);
      const source = await fs.lstat(temp); regular(source, maxResultBytes);
      requireSafe(sameFile(identity, source));
      await current(checkCurrent);
      if (replace) {
        await fs.rename(temp, path.join(jobs, basename));
        renamed = true;
      } else {
        try { await fs.link(temp, path.join(jobs, basename)); } catch (error) {
          if (error.code === "EEXIST") return false;
          throw error;
        }
      }
      return true;
    } finally {
      try { await handle.close(); } finally {
        if (!renamed && identity) await removeOwned(jobs, temp, identity);
        await syncDirectory(jobs);
      }
    }
  }
  async function reserveSlot(jobs, id) {
    const bytes = Buffer.from(`${id}\n`);
    // Permanent, ordered reservations avoid a global lock and bound crash losses to slots.
    // Equal ids contend for the same first free slot; an existing matching slot is reusable.
    for (let index = 0; index < MAX_JOBS; index++) {
      const basename = `.slot-${index}`;
      await guard(jobs);
      if (!await lstat(path.join(jobs, basename)) && await publish(jobs, basename, bytes)) return;
      try {
        if ((await readPrivate(jobs, basename, SLOT_BYTES)).equals(bytes)) return;
      } catch (error) {
        // An unsafe or interrupted slot remains occupied, never followed, reset or reclaimed.
        // This loses capacity locally; it must not make other slots unavailable.
        if (!(error instanceof MediaStorageError) || error.code !== "STORAGE_ERROR") throw error;
      }
    }
    fail("GENERATION_LIMIT");
  }

  return {
    read(id) {
      return run(async () => { validId(id); return readJob(await paths(), id); });
    },
    create(job) {
      return run(async () => {
        const { id, bytes } = encode(job);
        const jobs = await paths(true);
        if (await lstat(path.join(jobs, `${id}.json`))) {
          await readJob(jobs, id);
          return false;
        }
        requireSafe(!await lstat(path.join(jobs, `${id}.submitted`)) && !await lstat(path.join(jobs, `${id}.${resultExtension}`)));
        if ((await names(jobs)).length >= MAX_JOBS) {
          if (await lstat(path.join(jobs, `${id}.json`))) {
            await readJob(jobs, id);
            return false;
          }
          fail("GENERATION_LIMIT");
        }
        await reserveSlot(jobs, id);
        const created = await publish(jobs, `${id}.json`, bytes);
        if (!created) await readJob(jobs, id);
        return created;
      });
    },
    write(job, checkCurrent) {
      return run(async () => {
        const { id, bytes } = encode(job);
        const jobs = await paths();
        await readJob(jobs, id);
        await current(checkCurrent);
        // The service's successful claim elects the worker; this layer never reclaims it.
        await publish(jobs, `${id}.json`, bytes, checkCurrent, () => readJob(jobs, id), true);
      });
    },
    claim(id) {
      return run(async () => {
        validId(id);
        const jobs = await paths();
        await readJob(jobs, id);
        const claimed = await publish(jobs, `${id}.submitted`, MARKER, undefined, () => readJob(jobs, id));
        requireSafe(await hasMarker(jobs, id));
        return claimed;
      });
    },
    hasClaim(id) {
      return run(async () => {
        validId(id);
        const jobs = await paths();
        await readJob(jobs, id);
        return hasMarker(jobs, id);
      });
    },
    list() {
      return run(async () => {
        const jobs = await paths();
        const result = [];
        for (const id of await names(jobs)) result.push(await readJob(jobs, id));
        return result;
      });
    },
    writeResult(id, bytes, checkCurrent) {
      return run(async () => {
        validId(id);
        requireSafe(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maxResultBytes);
        const snapshot = Buffer.from(bytes);
        const jobs = await paths();
        await readJob(jobs, id);
        requireSafe(await hasMarker(jobs, id));
        await current(checkCurrent);
        const created = await publish(jobs, `${id}.${resultExtension}`, snapshot, checkCurrent, async () => {
          await readJob(jobs, id);
          requireSafe(await hasMarker(jobs, id));
        });
        if (!created) {
          requireSafe((await readPrivate(jobs, `${id}.${resultExtension}`, maxResultBytes)).equals(snapshot));
          await current(checkCurrent);
        }
      });
    },
    readResult(id) {
      return run(async () => {
        validId(id);
        const jobs = await paths();
        await readJob(jobs, id);
        return readPrivate(jobs, `${id}.${resultExtension}`, maxResultBytes);
      });
    },
  };
}

module.exports = { createMediaJobStorage };
