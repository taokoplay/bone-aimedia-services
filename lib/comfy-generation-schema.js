"use strict";
const { createHash } = require("node:crypto");
const { assert, keys, identifier, revision, object } = require("./media-provider-schema.js");
const { outputRules } = require("./comfy-output-validators.js");
const WF_ID = /^wf-[a-f0-9]{32}$/;
const STATES = ["submitting", "succeeded", "failed", "unknown", "result-pending"];
const ERROR_CODES = new Set(["INVALID_ARGUMENT", "CONFLICT", "DISABLED", "NOT_FOUND", "DISPOSED", "PERMISSION_DENIED", "CREDENTIAL_REQUIRED", "GENERATION_UNKNOWN", "RESULT_UNAVAILABLE", "RESULT_INVALID", "STORAGE_ERROR", "TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "AUTHENTICATION_REQUIRED", "ENDPOINT_NOT_FOUND", "RESPONSE_TOO_LARGE", "BINARY_RESPONSE_UNSUPPORTED", "WORKFLOW_INVALID", "WORKFLOW_NOT_FOUND", "WORKFLOW_CANCELED"]);
function hash(value) { assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value)); return value; }
function workflowJobId(value) { assert(typeof value === "string" && WF_ID.test(value)); return value; }
function stableId(workflowId, requestKey) { return `wf-${createHash("sha256").update(JSON.stringify([workflowId, requestKey])).digest("hex").slice(0, 32)}`; }
function inputs(value) { const source = value === undefined ? {} : value; assert(object(source)); assert(Object.keys(source).length <= 12); for (const [key, item] of Object.entries(source)) { assert(/^[A-Za-z0-9_.:-]{1,128}$/.test(key)); assert(["string", "number", "boolean"].includes(typeof item)); if (typeof item === "string") assert(item.length <= 8000 && !/\0/.test(item)); } return structuredClone(source); }
function request(value) {
  keys(value, ["workflowId", "profileId", "expectedRevision", "workflowHash", "workflowName", "kind", "requestKey", "inputs", "outputRules"]);
  identifier(value.workflowId); identifier(value.profileId); revision(value.expectedRevision); hash(value.workflowHash); assert(typeof value.workflowName === "string" && value.workflowName.length <= 128); assert(["image", "video", "audio"].includes(value.kind));
  assert(typeof value.requestKey === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value.requestKey));
  return { workflowId: value.workflowId, profileId: value.profileId, expectedRevision: value.expectedRevision, workflowHash: value.workflowHash, workflowName: value.workflowName, kind: value.kind, requestKey: value.requestKey, inputs: inputs(value.inputs), outputRules: outputRules(value.outputRules, value.kind) };
}
function parseJob(value) {
  keys(value, ["version", "id", "revision", "state", "requestHash", "request", "profileName", "remotePromptId", "createdAt", "updatedAt", "charging", "result", "error", "project"]);
  assert(value.version === 1); workflowJobId(value.id); assert(value.revision >= 1 && value.revision <= 3); assert(STATES.includes(value.state)); hash(value.requestHash); const parsed = request(value.request); assert(value.requestHash === createHash("sha256").update(JSON.stringify(parsed)).digest("hex"));
  assert(typeof value.profileName === "string" && value.profileName.length <= 128); assert(value.remotePromptId === undefined || typeof value.remotePromptId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.remotePromptId));
  for (const date of [value.createdAt, value.updatedAt]) assert(typeof date === "string" && Number.isFinite(Date.parse(date)));
  assert(["unknown", "not-submitted"].includes(value.charging));
  if (value.result !== undefined) { keys(value.result, ["resultId", "kind", "mimeType", "extension", "byteLength", "sha256", "verification"]); assert(value.result.resultId === value.id && value.result.kind === parsed.kind); hash(value.result.sha256); }
  if (value.error !== undefined) { keys(value.error, ["code", "httpStatus"]); assert(ERROR_CODES.has(value.error.code)); }
  return structuredClone(value);
}
function publicJob(value, summary = false) { const job = structuredClone(value); if (summary) delete job.request.inputs; return { ...job, kind: value.request.kind, provider: "comfyui" }; }
module.exports = { workflowJobId, stableId, request, parseJob, publicJob, ERROR_CODES, hash };
