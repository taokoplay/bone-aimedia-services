"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { assert, fail } = require("./media-provider-schema.js");
const MAX_JOBS = 200;
const MAX_JOB_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
function safeId(id) { assert(typeof id === "string" && /^wf-[a-f0-9]{32}$/.test(id)); return id; }
function safeRoot(value) { assert(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0")); return path.resolve(value); }
function cleanError(error) { return error?.code === "NOT_FOUND" ? error : Object.assign(new Error("ComfyUI job storage failed."), { code: "STORAGE_ERROR" }); }
function createComfyJobStorage(getDataPath) {
  let root;
  async function directory(create = false) {
    const data = safeRoot(await getDataPath());
    assert(!root || root === data, "STORAGE_ERROR"); root = data;
    const jobs = path.join(root, "comfy-jobs");
    try { await fs.mkdir(jobs, { recursive: create, mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw cleanError(error); }
    try { const stat = await fs.lstat(jobs); assert(stat.isDirectory() && !stat.isSymbolicLink(), "STORAGE_ERROR"); return jobs; } catch (error) { if (error.code === "ENOENT" && !create) fail("NOT_FOUND"); throw cleanError(error); }
  }
  async function readFile(file, limit) {
    const stat = await fs.lstat(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit && (stat.mode & 0o777) === 0o600, "STORAGE_ERROR");
    const bytes = await fs.readFile(file); assert(bytes.length <= limit, "STORAGE_ERROR"); return bytes;
  }
  async function read(id) {
    safeId(id); const jobs = await directory();
    try { return JSON.parse((await readFile(path.join(jobs, `${id}.json`), MAX_JOB_BYTES)).toString("utf8")); }
    catch (error) { if (error.code === "ENOENT") fail("NOT_FOUND"); throw cleanError(error); }
  }
  async function write(id, value) {
    safeId(id); const jobs = await directory(true); const bytes = Buffer.from(JSON.stringify(value), "utf8");
    assert(bytes.length <= MAX_JOB_BYTES, "STORAGE_ERROR");
    const temp = path.join(jobs, `.${id}-${randomUUID()}.tmp`);
    try { await fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" }); await fs.rename(temp, path.join(jobs, `${id}.json`)); }
    catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw cleanError(error); }
  }
  async function create(job) {
    const jobs = await directory(true); safeId(job.id);
    try { await fs.access(path.join(jobs, `${job.id}.json`)); const existing = await read(job.id); assert(existing.requestHash === job.requestHash, "GENERATION_REQUEST_CONFLICT"); return false; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const names = await fs.readdir(jobs); assert(names.filter(name => name.endsWith(".json")).length < MAX_JOBS, "GENERATION_LIMIT");
    await write(job.id, job); return true;
  }
  async function list() {
    const jobs = await directory(false).catch(error => error.code === "NOT_FOUND" ? null : Promise.reject(error)); if (!jobs) return [];
    const names = (await fs.readdir(jobs)).filter(name => /^wf-[a-f0-9]{32}\.json$/.test(name));
    return Promise.all(names.map(name => read(name.slice(0, -5))));
  }
  async function resultPath(id) { safeId(id); return path.join(await directory(), `${id}.bin`); }
  async function writeResult(id, bytes) { assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_RESULT_BYTES, "RESULT_INVALID"); const file = await resultPath(id); const temp = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" }); await fs.rename(temp, file); }
  async function readResult(id) { const bytes = await readFile(await resultPath(id), MAX_RESULT_BYTES); return bytes; }
  async function removeResult(id) { await fs.rm(await resultPath(id), { force: true }); }
  return { create, read, write, list, writeResult, readResult, removeResult, hasResult: async id => { try { await fs.access(await resultPath(id)); return true; } catch { return false; } } };
}
module.exports = { createComfyJobStorage, MAX_RESULT_BYTES };
