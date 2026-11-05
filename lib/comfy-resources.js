"use strict";

const { assert, fail, object, keys, identifier, revision, workflow, workflowTree } = require("./media-provider-schema.js");
const { requestJson } = require("./media-provider-request.js");
const { resourceErrorDetails } = require("./comfy-resource-errors.js");
const resources = ["model-folders", "models", "workflows", "workflow", "queue", "history"];
const MAX_ITEMS = 10000;
const MAX_WORKFLOW = 200 * 1024;

function safeText(value, secrets, max = 2048) {
  assert(typeof value === "string" && value.length <= max && !/[\uD800-\uDFFF]/.test(value) && !/[\x00-\x1f\x7f-\x9f]|[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|file|data|javascript):|\/\/|@|\b(?:bearer|basic)\s|\b(?:authorization|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|credential|password|secret|cookie|token)\s*[:=]|\bsk-[a-z0-9_-]{8,}/i.test(value));
  assert(secrets.every(secret => !value.includes(secret)));
  return value;
}
function relativePath(value, secrets = [], folder = false) {
  safeText(value, secrets, folder ? 256 : 2048);
  // Reject percent escapes outright: no downstream decoding may turn a safe
  // name into traversal, separators, query parameters, or a different member.
  assert(value.length > 0 && !/[\\%:?#<>]/.test(value));
  const parts = value.split("/");
  assert(parts.every(part => part && part !== "." && part !== ".." && part.trim() === part));
  if (folder) assert(parts.length === 1);
  return value;
}
function browseInput(input) {
  keys(input, ["profileId", "expectedRevision", "resource", "folder", "path", "offset", "limit"]);
  const profileId = identifier(input.profileId); const expectedRevision = revision(input.expectedRevision);
  assert(resources.includes(input.resource));
  const { resource } = input;
  assert(resource === "models" ? typeof input.folder === "string" : input.folder === undefined);
  assert(resource === "workflow" ? typeof input.path === "string" : input.path === undefined);
  const offset = input.offset === undefined ? 0 : input.offset;
  const limit = input.limit === undefined ? 50 : input.limit;
  assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
  assert(resource !== "workflow" || offset === 0);
  return { profileId, expectedRevision, resource, offset, limit,
    ...(resource === "models" ? { folder: relativePath(input.folder, [], true) } : {}),
    ...(resource === "workflow" ? { path: jsonPath(input.path) } : {}) };
}
function jsonPath(value, secrets = []) { relativePath(value, secrets); assert(/\.json$/i.test(value)); return value; }
function array(value) { assert(Array.isArray(value) && value.length <= MAX_ITEMS); return value; }
function nonnegative(value) { assert(Number.isSafeInteger(value) && value >= 0); return value; }
function promptId(value, secrets) { safeText(value, secrets, 128); return identifier(value); }
function tuple(value, secrets) {
  assert(Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && Number.isFinite(value[0]));
  return { promptId: promptId(value[1], secrets), number: value[0] };
}
const credentialAssignment = /\b(?:authorization|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|credential|password|secret|cookie|token)\s*[:=]|\b(?:bearer|basic)\s+\S+|\bsk-[a-z0-9_-]{8,}/i;
const credentialParameter = /^(?:key|token|apikey|accesstoken|authtoken|refreshtoken|sessiontoken|idtoken|credential|password|secret|cookie|authorization|auth|signature|sig|accesskey|accesskeyid|awsaccesskeyid|x(?:amz|goog)(?:signature|credential|securitytoken))$/i;
function workflowText(value, secrets) {
  // Body text is rendered via textContent, never used as a path or executable
  // markup. Notes may contain line breaks, ordinary HTTP links and emoji.
  assert(!/[\uD800-\uDFFF]/u.test(value) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value));
  assert(!credentialAssignment.test(value) && secrets.every(secret => !value.includes(secret)));
  assert(!/\b(?:file|data|javascript):|\b(?!https?:)[a-z][a-z0-9+.-]*:\/\//i.test(value));
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = new URL(match[0]);
    assert(!url.username && !url.password);
    let decoded = match[0];
    for (let n = 0; n < 4 && /%[0-9a-f]{2}/i.test(decoded); n++) decoded = decodeURIComponent(decoded);
    assert(!/%[0-9a-f]{2}/i.test(decoded) && !credentialAssignment.test(decoded));
    assert(secrets.every(secret => !decoded.includes(secret)));
    const decodedUrl = new URL(decoded);
    assert(!decodedUrl.username && !decodedUrl.password);
    for (const params of [decodedUrl.searchParams, new URLSearchParams(decodedUrl.hash.slice(1))]) {
      for (const name of params.keys()) assert(!credentialParameter.test(name.replace(/[^a-z0-9]/gi, "")));
    }
  }
}
function scanWorkflow(value, secrets) {
  // workflowTree supplies bounded depth/array sizes and rejects credential and
  // prototype keys. Scan decoded keys and values as well as the serialized body.
  workflowTree(value);
  function scan(item) {
    if (typeof item === "string") workflowText(item, secrets);
    else if (Array.isArray(item)) item.forEach(scan);
    else if (object(item)) for (const [key, child] of Object.entries(item)) { workflowText(key, secrets); assert(!/(?:authorization|apikey|accesstoken|authtoken|refreshtoken|sessiontoken|idtoken|password|credential|secret|cookie|headers|^auth$|authentication)/i.test(key.replace(/[^a-z0-9]/gi, ""))); scan(child); }
  }
  scan(value);
}
function detail(value, secrets) {
  assert(object(value) && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_WORKFLOW);
  scanWorkflow(value, secrets);
  if (Array.isArray(value.nodes)) {
    assert(value.nodes.length <= 300 && (value.links === undefined || Array.isArray(value.links)));
    return { definition: value, format: "canvas", importable: false };
  }
  const nodes = Object.values(value);
  if (nodes.length > 0 && nodes.some(node => object(node) && Object.hasOwn(node, "class_type"))) {
    return { definition: workflow(value), format: "api", importable: true };
  }
  return { definition: value, format: "unknown", importable: false };
}
function parse(resource, value, secrets) {
  if (resource === "model-folders" || resource === "models") {
    return array(value).map(name => ({ name: relativePath(name, secrets, resource === "model-folders") }));
  }
  if (resource === "workflows") {
    // Validate every record, including non-JSON entries, before filtering or paging.
    return array(value).map(item => {
      assert(object(item));
      return { path: relativePath(item.path, secrets), size: nonnegative(item.size), modified: nonnegative(item.modified), created: nonnegative(item.created) };
    }).filter(item => /\.json$/i.test(item.path));
  }
  if (resource === "queue") {
    assert(object(value));
    const running = array(value.queue_running); const pending = array(value.queue_pending);
    assert(running.length + pending.length <= MAX_ITEMS);
    return [...running.map(item => ({ ...tuple(item, secrets), state: "running" })), ...pending.map(item => ({ ...tuple(item, secrets), state: "pending" }))];
  }
  assert(resource === "history" && object(value) && Object.keys(value).length <= 100);
  return Object.entries(value).map(([id, item]) => {
    promptId(id, secrets);
    assert(object(item) && object(item.outputs));
    assert(tuple(item.prompt, secrets).promptId === id);
    assert(item.status === undefined || object(item.status));
    const status = item.status?.status_str;
    if (status !== undefined) safeText(status, secrets, 128);
    const completed = item.status?.completed;
    assert(completed === undefined || completed === null || typeof completed === "boolean");
    // Count output node records, not media files or quality. Payloads, URLs,
    // prompts and extra_data from other clients are never copied into results.
    assert(Object.values(item.outputs).every(object));
    return { promptId: id, status: ["success", "error"].includes(status) ? status : "unknown", completed: completed ?? null, outputCount: Object.keys(item.outputs).length };
  });
}
function result(input, status, message, items = [], extra = {}) {
  return { profileId: input.profileId, resource: input.resource, status, checkedAt: new Date().toISOString(), items: items.slice(input.offset, input.offset + input.limit), total: items.length, offset: input.offset, limit: input.limit, truncated: input.offset > 0 || items.length > input.limit, message, ...extra };
}

async function browseResources(input, captured, request, checkCurrent) {
  const { profile, secret, secrets, allowed } = captured;
  if (input.resource === "models" && !allowed?.folders?.has(input.folder)) {
    return { output: result(input, "unavailable", "Reload model folders before selecting a listed folder.", [], { code: "RESOURCE_LIST_STALE" }) };
  }
  if (input.resource === "workflow" && !allowed?.workflows?.has(input.path)) {
    return { output: result(input, "unavailable", "Reload workflows before selecting a listed JSON workflow.", [], { code: "RESOURCE_LIST_STALE" }) };
  }
  const suffixes = {
    "model-folders": "/models", models: `/models/${encodeURIComponent(input.folder || "")}`,
    workflows: "/userdata?dir=workflows&recurse=true&full_info=true",
    workflow: `/userdata/${encodeURIComponent(`workflows/${input.path || ""}`)}`,
    queue: "/queue", history: "/history?max_items=100",
  };
  try {
    const value = await requestJson(profile, secret, request, checkCurrent, suffixes[input.resource], undefined, input.resource !== "workflow");
    if (input.resource === "workflow") {
      assert(Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_WORKFLOW, "WORKFLOW_TOO_LARGE");
      let parsed;
      try { parsed = detail(value, secrets); } catch { fail("WORKFLOW_INVALID", "Workflow content could not be previewed safely."); }
      return { output: result(input, "ok", "Read-only workflow preview. Only validated API format can be imported; nothing was executed.", [], parsed) };
    }
    const items = parse(input.resource, value, secrets);
    const serverWide = input.resource === "queue" || input.resource === "history";
    const message = serverWide
      ? "Server-wide metadata, not plugin-owned jobs. History is limited to at most 100 server entries; totals describe only returned entries. No duration, owner or quality is inferred."
      : "Read-only resource listing. Pagination may omit entries; availability does not verify generation compatibility.";
    const output = result(input, "ok", message, items);
    if (input.resource === "history" && items.length === 100) output.truncated = true;
    return { output, items, ...(input.resource === "model-folders" ? { folders: new Set(items.map(item => item.name)) } : {}), ...(input.resource === "workflows" ? { workflows: new Set(items.map(item => item.path)) } : {}) };
  } catch (error) {
    checkCurrent();
    if (error?.code === "RESOURCE_UNSUPPORTED") return { output: result(input, "unsupported", "This ComfyUI resource endpoint is not supported by the server.", [], { code: "RESOURCE_UNSUPPORTED" }) };
    return { output: result(input, "unavailable", "ComfyUI resource request failed or returned unsafe or invalid data.", [], resourceErrorDetails(error, input.resource)) };
  }
}
module.exports = { browseInput, browseResources, relativePath, jsonPath, parseResourceItems: parse, parseWorkflowDetail: detail };
