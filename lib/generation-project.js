"use strict";
const path = require("node:path");
const { createHash } = require("node:crypto");
const { assert, keys } = require("./media-provider-schema.js");

// Display metadata only: never a filesystem grant, project isolation boundary,
// model parameter or user-supplied tool argument.
function parseProject(value) {
  keys(value, ["status", "name"]);
  assert(["project", "none", "unknown"].includes(value.status));
  if (value.status === "project") {
    assert(typeof value.name === "string" && value.name.trim() === value.name && value.name.length > 0 && [...value.name].length <= 128 && value.name.isWellFormed() && !/[\x00-\x1f\x7f-\x9f/\\]/.test(value.name));
  } else assert(value.name === undefined);
  return structuredClone(value);
}
function projectBinding(job) {
  return createHash("sha256").update(JSON.stringify([job.id, job.requestHash, job.agentRequest ?? null])).digest("hex");
}
function parseProjectRecord(value, job) {
  keys(value, ["version", "binding", "project"]);
  assert(value.version === 1 && value.binding === projectBinding(job), "STORAGE_ERROR");
  return parseProject(value.project);
}
function normalizedPath(value) {
  if (typeof value !== "string" || !value || !value.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/.test(value)) return null;
  if (path.win32.isAbsolute(value) && /^[A-Za-z]:[\\/]/.test(value)) return path.win32.normalize(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return path.posix.isAbsolute(value) ? path.posix.normalize(value).replace(/\/+$/, "") || "/" : null;
}
function projectName(value) {
  if (typeof value !== "string" || !value.isWellFormed() || /[\x00-\x1f\x7f-\x9f/\\]/.test(value)) return null;
  const chars = [...value.trim()];
  return chars.length ? chars.slice(0, 127).join("") + (chars.length > 128 ? "…" : chars.slice(127).join("")) : null;
}
function fromPath(projectPath, preferredName) {
  const name = projectName(preferredName) || projectName(projectPath.split("/").filter(Boolean).at(-1));
  return name ? { status: "project", name } : { status: "unknown" };
}
function createProjectCapture(host) {
  const unavailable = new Set(["UNSUPPORTED", "NOT_FOUND", "PERMISSION_DENIED", "UNAVAILABLE"]);
  async function read(owner, method) {
    if (typeof owner?.[method] !== "function") return undefined;
    try { return await owner[method](); }
    catch (error) { if (unavailable.has(error?.code)) return undefined; throw Object.assign(new Error("Project context is unavailable."), { code: "UNAVAILABLE" }); }
  }
  return async context => {
    const unknown = { status: "unknown" };
    // Agent tools must never adopt whichever unrelated workspace happens to be
    // visible. Old hosts only expose the selected session, so unmatched callers
    // remain unknown rather than gaining broad session-read permission.
    const agent = context !== undefined;
    if (agent && (typeof context?.sessionId !== "string" || !context.sessionId)) return unknown;
    if (context?.signal?.aborted) throw Object.assign(new Error("Cancelled"), { code: "TOOL_ABORTED" });
    const before = await read(host.session, "getActive");
    if (agent && before?.sessionId !== context.sessionId) return unknown;
    if (before && before.projectPath === null) return { status: "none" };
    const workspace = await read(host.workspace, "get");
    const after = before ? await read(host.session, "getActive") : before;
    if (context?.signal?.aborted) throw Object.assign(new Error("Cancelled"), { code: "TOOL_ABORTED" });
    if (before && (!after || before.sessionId !== after.sessionId || before.projectPath !== after.projectPath)) return unknown;
    const sessionPath = normalizedPath(before?.projectPath);
    const workspacePath = normalizedPath(workspace?.path);
    if (before) {
      if (!sessionPath) return unknown;
      return fromPath(sessionPath, sessionPath === workspacePath ? workspace?.name : undefined);
    }
    if (agent) return unknown;
    if (workspace === null) return { status: "none" };
    return workspacePath ? fromPath(workspacePath, workspace.name) : unknown;
  };
}
module.exports = { createProjectCapture, parseProject, parseProjectRecord, projectBinding };
