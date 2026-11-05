"use strict";

const { assert, fail } = require("./media-provider-schema.js");
const { browseResources } = require("./comfy-resources.js");

async function readResource(resource, captured, request, checkCurrent, extra = {}) {
  const input = { profileId: captured.profile.id, expectedRevision: captured.revision, resource, offset: 0, limit: 100, ...extra };
  const result = await browseResources(input, captured, request, checkCurrent);
  checkCurrent();
  if (result.output.status !== "ok") {
    if (resource === "workflow" && result.output.code) fail(result.output.code, "Workflow detail could not be read safely. The previous snapshot was retained.");
    fail(result.output.status === "unsupported" ? "SYNC_UNSUPPORTED" : "SYNC_FAILED", "Resource synchronization failed. The previous snapshot was retained.");
  }
  return result;
}

async function syncCatalog(resource, captured, request, checkCurrent) {
  if (resource === "workflows") {
    const result = await readResource("workflows", captured, request, checkCurrent);
    return { workflows: { checkedAt: result.output.checkedAt, items: result.items } };
  }
  assert(resource === "models");
  const directory = await readResource("model-folders", captured, request, checkCurrent);
  assert(directory.items.length <= 256, "SYNC_FAILED", "The model directory exceeds the snapshot limit.");
  const scoped = { ...captured, allowed: { folders: directory.folders } };
  const folders = [];
  let bytes = 0;
  // Bounded concurrency; settle every issued request before releasing the profile.
  for (let index = 0; index < directory.items.length; index += 4) {
    checkCurrent();
    const batch = await Promise.allSettled(directory.items.slice(index, index + 4).map(async ({ name }) => {
      const result = await readResource("models", scoped, request, checkCurrent, { folder: name });
      return { name, items: result.items };
    }));
    const rejected = batch.find(item => item.status === "rejected");
    if (rejected) throw rejected.reason;
    folders.push(...batch.map(item => item.value));
    bytes += batch.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.value)), 0);
    assert(bytes <= 32 * 1024 * 1024, "SYNC_FAILED", "The model catalog exceeds the snapshot limit.");
  }
  return { models: { checkedAt: new Date().toISOString(), folders } };
}

async function fetchWorkflowDetail(path, snapshot, captured, request, checkCurrent) {
  const allowed = new Set((snapshot.workflows?.items || []).map(item => item.path));
  assert(allowed.has(path), "NOT_FOUND", "Synchronize the workflow directory before reading this workflow.");
  const cached = snapshot.details.find(item => item.path === path);
  if (cached) return cached;
  const result = await readResource("workflow", { ...captured, allowed: { workflows: allowed } }, request, checkCurrent, { path });
  const { checkedAt, definition, format, importable } = result.output;
  return { path, checkedAt, definition, format, importable };
}

module.exports = { syncCatalog, fetchWorkflowDetail };
