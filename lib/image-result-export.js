"use strict";

const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { MAX_IMAGE_BYTES } = require("./image-png.js");
const { buildImageExportDecoder } = require("./image-export-decoder.js");

const JOB_ID = /^img-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXPORT_ROOT = "bone-media/exports";
const MESSAGES = {
  INVALID_ARGUMENT: "Supply only a valid image job ID.",
  CONTEXT_REQUIRED: "Image export requires a trusted Agent session and turn.",
  ABORTED: "Image export was cancelled.",
  NO_WORKSPACE: "Open a local workspace before exporting an image.",
  WORKSPACE_CHANGED: "The workspace changed during image export. Export was not completed.",
  PERMISSION_DENIED: "Workspace image export permission was denied.",
  EXPORT_UNAVAILABLE: "The host does not support workspace image export.",
  EXPORT_CONFLICT: "An export destination already exists. No replacement was requested.",
  EXPORT_FAILED: "Image export could not be completed safely.",
  RESULT_INVALID: "The stored image result did not pass export verification.",
  RESULT_UNAVAILABLE: "A successful image result is required for export.",
  NOT_FOUND: "The image job or result was not found.",
  DISPOSED: "The image service is no longer available.",
};
class ImageExportError extends Error {
  constructor(code) { super(MESSAGES[code]); this.name = "ImageExportError"; this.code = code; }
}
function fail(code) { throw new ImageExportError(code); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function localWorkspace(info) {
  if (!info || info.remote != null || typeof info.path !== "string" || !path.isAbsolute(info.path) ||
      /[\x00-\x1f\x7f]/.test(info.path) || /^(?:\/\/|\\\\)/.test(info.path)) fail("NO_WORKSPACE");
  return path.resolve(info.path);
}
function contextIdentity(ctx) {
  if (!ctx || ctx.mode !== "agent" || ![ctx.sessionId, ctx.turnId].every(value =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value))) {
    fail("CONTEXT_REQUIRED");
  }
  if (ctx.signal?.aborted) fail("ABORTED");
  return [ctx.sessionId, ctx.turnId];
}

/**
 * Only the host-supplied tool context is trusted; callers cannot supply a target.
 * readResult(jobId) supplies { job: publicJob, bytes: Buffer }, already PNG-validated.
 * All workspace I/O uses the old SDK's fs.readText/stat/writeText permissions,
 * restricted by the manifest to root "workspace", scope "bone-media/exports/**".
 *
 * Old workspace.get/fs APIs are active-workspace APIs, NOT session-bound APIs.
 * The session/turn checks establish invocation provenance, not workspace ownership.
 * Rechecking around every await detects observed changes, but cannot prevent an
 * A -> B -> A switch inside a host call. Likewise stat + writeText is NOT atomic
 * create: UUID names and absence checks do not defeat a hostile concurrent writer.
 * The plugin never intentionally reuses an artifact or overwrites a PNG. Host
 * readText is also unbounded; stat bounds the expected file, not a concurrent edit.
 * Some old hosts collapse stat I/O failures to NOT_FOUND; the plugin cannot
 * recover an error code the host discarded and accepts only its documented
 * absence codes. Raw host messages are never parsed or returned.
 * Stronger guarantees require a host API change. Failed/partial exports retain the
 * original private result and any artifacts; there is no unsafe rollback/delete.
 */
function createImageResultExporter({ host, readResult }) {
  async function exportResult(args, ctx) {
    let recovery;
    try {
      if (!args || typeof args !== "object" || Array.isArray(args) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
          Reflect.ownKeys(args).length !== 1 || !Object.hasOwn(args, "jobId") ||
          typeof args.jobId !== "string" || !JOB_ID.test(args.jobId)) fail("INVALID_ARGUMENT");
      const jobId = args.jobId;
      const identity = contextIdentity(ctx);
      function current() {
        const now = contextIdentity(ctx);
        if (now[0] !== identity[0] || now[1] !== identity[1]) fail("CONTEXT_REQUIRED");
      }
      if (typeof host?.workspace?.get !== "function" || typeof readResult !== "function" ||
          !["stat", "writeText", "readText"].every(key => typeof host?.fs?.[key] === "function")) fail("EXPORT_UNAVAILABLE");
      const info = await host.workspace.get();
      current();
      const workspacePath = localWorkspace(info);
      async function guard() {
        current();
        const info = await host.workspace.get();
        current();
        let next;
        try { next = localWorkspace(info); } catch { fail("WORKSPACE_CHANGED"); }
        if (next !== workspacePath) fail("WORKSPACE_CHANGED");
      }
      async function checked(action) {
        await guard();
        let result, failure, rejected = false;
        try { result = await action(); } catch (error) { failure = error; rejected = true; }
        await guard();
        if (rejected) throw failure;
        return result;
      }
      async function absent(file) {
        const exists = await checked(async () => {
          try { await host.fs.stat(file); return true; } catch (error) {
            // Never treat permission, transport, or unknown errors as absence.
            if (error?.code === "ENOENT" || error?.code === "NOT_FOUND") return false;
            throw error;
          }
        });
        if (exists) fail("EXPORT_CONFLICT");
      }
      async function writeVerified(file, content) {
        await absent(file);
        await checked(() => {
          recovery.attemptedPaths.push(file);
          return host.fs.writeText(file, content);
        });
        const stat = await checked(() => host.fs.stat(file));
        if (stat?.size !== Buffer.byteLength(content, "utf8")) fail("EXPORT_FAILED");
        const saved = await checked(() => host.fs.readText(file));
        if (saved !== content) fail("EXPORT_FAILED");
      }
      const result = await checked(() => readResult(jobId));
      if (result?.job?.id !== jobId || result.job.state !== "succeeded") fail("RESULT_UNAVAILABLE");
      const descriptor = result.job.result;
      if (!Buffer.isBuffer(result.bytes) || result.bytes.length < 57 || result.bytes.length > MAX_IMAGE_BYTES) fail("RESULT_INVALID");
      const bytes = Buffer.from(result.bytes);
      const sha256 = hash(bytes);
      if (descriptor?.mimeType !== "image/png" || descriptor.byteLength !== bytes.length || descriptor.sha256 !== sha256 ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail("RESULT_INVALID");
      const stem = `image-${randomUUID()}`;
      const handoffPath = `${EXPORT_ROOT}/${stem}.image.json`;
      const decoderPath = `${EXPORT_ROOT}/${stem}.decode.cjs`;
      const outputPath = `${EXPORT_ROOT}/${stem}.png`;
      const handoff = JSON.stringify({ version: 1, jobId, mimeType: "image/png", byteLength: bytes.length,
        sha256, base64: bytes.toString("base64"), outputBasename: `${stem}.png` });
      const decoder = buildImageExportDecoder({ workspacePath, stem, jobId, byteLength: bytes.length,
        sha256, handoffSha256: hash(handoff) });
      for (const file of [handoffPath, decoderPath, outputPath]) await absent(file);
      recovery = { status: "incomplete", workspacePath, handoffPath, decoderPath, outputPath, attemptedPaths: [],
        diagnostic: "Export artifacts may remain. The original image result is retained; request a fresh export." };
      recovery.diagnostic += " A workspace switch can leave artifacts in either workspace.";
      await writeVerified(handoffPath, handoff);
      await writeVerified(decoderPath, decoder);
      await absent(outputPath);
      await guard();
      return { status: "handoff-ready", jobId, mimeType: "image/png", byteLength: bytes.length, sha256,
        workspacePath, handoffPath, decoderPath, outputPath, command: `node '${decoderPath}'` };
    } catch (error) {
      const code = ["EACCES", "EPERM", "PERMISSION_DENIED"].includes(error?.code) ? "PERMISSION_DENIED"
        : error instanceof ImageExportError || ["RESULT_INVALID", "RESULT_UNAVAILABLE", "NOT_FOUND", "DISPOSED"].includes(error?.code)
          ? error.code : "EXPORT_FAILED";
      const safe = new ImageExportError(code);
      if (recovery?.attemptedPaths.length) safe.recovery = recovery;
      throw safe;
    }
  }
  return { exportResult };
}

module.exports = { createImageResultExporter, ImageExportError };
