"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { assert, fail } = require("./media-provider-schema.js");

function createPrivateJsonStorage(getDataPath, { filename, maxBytes, empty, parse }) {
  assert(typeof filename === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(filename), "STORAGE_ERROR", "Private storage requires a fixed JSON basename.");
  assert(Number.isSafeInteger(maxBytes) && maxBytes > 0 && typeof parse === "function", "STORAGE_ERROR");
  let root;
  async function paths(create = false) {
    const supplied = await getDataPath();
    assert(typeof supplied === "string" && path.isAbsolute(supplied), "STORAGE_ERROR", "Private storage is unavailable.");
    const resolved = path.resolve(supplied);
    assert(!root || resolved === root, "STORAGE_ERROR", "Private storage changed.");
    root = resolved;
    // Check the private root before and after creation; never follow a root link.
    let stat; try { stat = await fs.lstat(root); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert(!stat || (stat.isDirectory() && !stat.isSymbolicLink()), "STORAGE_ERROR", "Private storage must be a directory, not a link.");
    if (!stat && create) { await fs.mkdir(root, { recursive: true, mode: 0o700 }); stat = await fs.lstat(root); }
    assert(!stat || (stat.isDirectory() && !stat.isSymbolicLink()), "STORAGE_ERROR", "Private storage is unsafe.");
    const file = path.join(root, filename);
    let target; try { target = await fs.lstat(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert(!target || (target.isFile() && !target.isSymbolicLink() && target.nlink === 1), "STORAGE_ERROR", "Private storage must be a regular private file.");
    return { file, exists: !!target };
  }
  async function read() {
    try {
      const { file, exists } = await paths();
      if (!exists) return structuredClone(typeof empty === "function" ? empty() : empty);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw;
      try {
        const stat = await handle.stat(); assert(stat.isFile() && stat.size <= maxBytes && stat.nlink === 1, "STORAGE_ERROR");
        const buffer = Buffer.alloc(maxBytes + 1);
        let offset = 0;
        while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
        assert(offset <= maxBytes, "STORAGE_ERROR"); raw = buffer.subarray(0, offset).toString("utf8");
      } finally { await handle.close(); }
      // The raw text lets stricter schemas detect duplicate JSON member names.
      return parse(JSON.parse(raw), raw);
    } catch (error) {
      if (error?.code === "CONFLICT" || error?.code === "DISPOSED") throw error;
      fail("STORAGE_ERROR", "Private JSON data could not be read safely. Repair the file before continuing.");
    }
  }
  async function write(value, checkCurrent) {
    let temp;
    try {
      const serialized = JSON.stringify(value, null, 2);
      assert(Buffer.byteLength(serialized) <= maxBytes, "STORAGE_ERROR");
      const { file } = await paths(true);
      checkCurrent();
      temp = path.join(root, `.${filename.slice(0, -5)}-${randomUUID()}.tmp`);
      const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(serialized, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await paths();
      checkCurrent();
      await fs.rename(temp, file);
      temp = undefined;
      checkCurrent();
    } catch (error) {
      if (error?.code === "CONFLICT" || error?.code === "DISPOSED") throw error;
      fail("STORAGE_ERROR", "Private JSON data could not be saved safely. Existing session state was preserved.");
    } finally {
      if (temp) await fs.unlink(temp).catch(() => {});
    }
  }
  return { read, write };
}
module.exports = { createPrivateJsonStorage };
