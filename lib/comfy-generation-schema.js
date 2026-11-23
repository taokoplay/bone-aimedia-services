"use strict";
const { createHash } = require("node:crypto");
const { assert, keys, identifier, revision, object } = require("./media-provider-schema.js");
const { outputRules } = require("./comfy-output-validators.js");
const { referenceSpecs } = require("./image-reference-schema.js");
const WF_ID = /^wf-[a-f0-9]{32}$/;
const REMOTE_ID = /^remote-[a-f0-9]{32}$/;
const STATES = ["submitting", "succeeded", "failed", "unknown", "result-pending"];
const ERROR_CODES = new Set(["INVALID_ARGUMENT", "CONFLICT", "DISABLED", "NOT_FOUND", "DISPOSED", "PERMISSION_DENIED", "CREDENTIAL_REQUIRED", "GENERATION_UNKNOWN", "GENERATION_UNRESOLVED", "GENERATION_REQUEST_CONFLICT", "RESULT_UNAVAILABLE", "RESULT_INVALID", "STORAGE_ERROR", "TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "AUTHENTICATION_REQUIRED", "ENDPOINT_NOT_FOUND", "RESPONSE_TOO_LARGE", "REQUEST_TOO_LARGE", "BINARY_REQUEST_UNSUPPORTED", "WORKFLOW_INPUT_REQUIRED", "WORKFLOW_INVALID", "WORKFLOW_NOT_FOUND", "WORKFLOW_NAME_AMBIGUOUS", "WORKFLOW_CANCELED"]);
function hash(value) { assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value)); return value; }
function remotePath(value) {
  assert(typeof value === "string" && value.length > 0 && value.length <= 2048 && /\.json$/i.test(value));
  assert(!value.includes("\0") && !value.includes("\\") && !/[?#<>:]/.test(value));
  assert(value.split("/").every(part => part && part !== "." && part !== ".." && part.trim() === part));
  return value;
}
function remoteName(value) {
  assert(typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value && !/[\0-\x1f\x7f/\\]/.test(value));
  return value;
}
function remoteWorkflowId(value) { assert(typeof value === "string" && REMOTE_ID.test(value)); return value; }
function workflowJobId(value) { assert(typeof value === "string" && WF_ID.test(value)); return value; }
function stableId(workflowId, requestKey) { return `wf-${createHash("sha256").update(JSON.stringify([workflowId, requestKey])).digest("hex").slice(0, 32)}`; }
function inputs(value) { const source = value === undefined ? {} : value; assert(object(source)); assert(Object.keys(source).length <= 12); for (const [key, item] of Object.entries(source)) { assert(/^[A-Za-z0-9_.:-]{1,128}$/.test(key)); assert(["string", "number", "boolean"].includes(typeof item)); if (typeof item === "string") assert(item.length <= 8000 && !/\0/.test(item)); } return structuredClone(source); }
function request(value) {
  keys(value, ["workflowId", "profileId", "expectedRevision", "workflowHash", "workflowName", "kind", "requestKey", "inputs", "referenceImages", "outputRules", "source", "remotePath", "remoteContentSha256"]);
  identifier(value.workflowId); identifier(value.profileId); revision(value.expectedRevision); hash(value.workflowHash); assert(typeof value.workflowName === "string" && value.workflowName.length <= 128); assert(["image", "video", "audio"].includes(value.kind));
  assert(typeof value.requestKey === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value.requestKey));
  const result = { workflowId: value.workflowId, profileId: value.profileId, expectedRevision: value.expectedRevision, workflowHash: value.workflowHash, workflowName: value.workflowName, kind: value.kind, requestKey: value.requestKey, inputs: inputs(value.inputs), outputRules: outputRules(value.outputRules, value.kind) };
  if (value.source !== undefined) {
    assert(value.source === "remote"); remotePath(value.remotePath); hash(value.remoteContentSha256);
    result.source = value.source; result.remotePath = value.remotePath; result.remoteContentSha256 = value.remoteContentSha256;
  }
  if (value.referenceImages !== undefined) result.referenceImages = referenceSpecs(value.referenceImages);
  return result;
}
function parseJob(value) {
  keys(value, ["version", "id", "revision", "state", "requestHash", "request", "profileName", "remotePromptId", "createdAt", "updatedAt", "charging", "result", "error", "project"]);
  assert(value.version === 1); workflowJobId(value.id); assert(value.revision >= 1 && value.revision <= 3); hash(value.requestHash); const parsed = request(value.request); assert(value.requestHash === createHash("sha256").update(JSON.stringify(parsed)).digest("hex"));
  assert(typeof value.profileName === "string" && value.profileName.length <= 128); assert(value.remotePromptId === undefined || typeof value.remotePromptId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.remotePromptId));
  for (const date of [value.createdAt, value.updatedAt]) assert(typeof date === "string" && Number.isFinite(Date.parse(date)));
  assert(["unknown", "not-submitted"].includes(value.charging));
  if (value.result !== undefined) { keys(value.result, ["resultId", "kind", "mimeType", "extension", "byteLength", "sha256", "verification"]); assert(value.result.resultId === value.id && value.result.kind === parsed.kind); hash(value.result.sha256); }
  if (value.error !== undefined) { keys(value.error, ["code", "httpStatus"]); assert(ERROR_CODES.has(value.error.code)); }
  return structuredClone(value);
}
function publicJob(value, summary = false) { const job = structuredClone(value); if (job.request.referenceImages) job.request.referenceImages = job.request.referenceImages.map(item => ({ sha256: item.sha256 })); if (summary) delete job.request.inputs; return { ...job, kind: value.request.kind, provider: "comfyui" }; }
module.exports = { workflowJobId, stableId, request, parseJob, publicJob, ERROR_CODES, hash, remotePath, remoteName, remoteWorkflowId };
