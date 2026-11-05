"use strict";
const { createHash } = require("node:crypto");
const { assert, keys, identifier, revision } = require("./media-provider-schema.js");
const { modelRef } = require("./media-model-catalog.js");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = ["prepared", "submitting", "succeeded", "failed", "unknown", "result-pending"];
const ERROR_CODES = new Set(["GENERATION_UNKNOWN", "GENERATION_UNSUPPORTED", "RESULT_INVALID", "RESULT_UNAVAILABLE", "STORAGE_ERROR", "CONFLICT", "CREDENTIAL_REQUIRED", "DISABLED", "NOT_FOUND", "DISPOSED", "TIMEOUT", "NETWORK_ERROR", "PERMISSION_DENIED", "HTTP_ERROR", "AUTHENTICATION_REQUIRED", "ENDPOINT_NOT_FOUND", "REDIRECT_DISALLOWED", "RESPONSE_TOO_LARGE"]);
ERROR_CODES.add("TOOL_ABORTED");
function jobId(value) { assert(typeof value === "string" && value.startsWith("img-") && UUID.test(value.slice(4))); return value; }
function hash(value) { assert(typeof value === "string" && HASH.test(value)); return value; }
function imageModel(value) { identifier(value); assert(/^gpt-image-[A-Za-z0-9_.-]+$/.test(value), "GENERATION_UNSUPPORTED", "Select a configured GPT image model."); return value; }
function imageRequest(value) {
  keys(value, ["profileId", "expectedRevision", "modelId", "prompt", "size", "quality", "outputCount"]);
  identifier(value.profileId); revision(value.expectedRevision); imageModel(value.modelId);
  assert(typeof value.prompt === "string" && value.prompt.trim().length > 0 && value.prompt.length <= 8000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.prompt) && value.prompt.isWellFormed());
  assert(!/\b(?:bearer\s+\S+|sk-[a-z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=])/i.test(value.prompt), "INVALID_ARGUMENT", "Do not put credentials in image prompts.");
  const size = value.size ?? "1024x1024", quality = value.quality ?? "medium";
  assert(["1024x1024", "1536x1024", "1024x1536"].includes(size));
  assert(["low", "medium", "high"].includes(quality));
  assert(value.outputCount === undefined || value.outputCount === 1);
  return { profileId: value.profileId, expectedRevision: value.expectedRevision, modelId: value.modelId, prompt: value.prompt.trim(), size, quality, outputCount: 1 };
}
function prepareInput(value) {
  keys(value, ["requestId", "profileId", "expectedRevision", "modelId", "prompt", "size", "quality"]);
  assert(typeof value.requestId === "string" && UUID.test(value.requestId));
  const { requestId, ...request } = value;
  return { id: `img-${requestId}`, request: imageRequest(request) };
}
function requestHash(request, identity) { return createHash("sha256").update(JSON.stringify({ request, identity })).digest("hex"); }
function resultDescriptor(value, id) {
  keys(value, ["resultId", "mimeType", "byteLength", "sha256", "width", "height", "verification", "quality"]);
  assert(value.resultId === id && value.mimeType === "image/png" && value.verification === "png-validated" && value.quality === "not-reviewed");
  hash(value.sha256);
  assert(Number.isInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= 16 * 1024 * 1024);
  for (const dimension of [value.width, value.height]) assert(Number.isInteger(dimension) && dimension > 0 && dimension <= 4096);
  return structuredClone(value);
}
function parseAgentRequest(value) {
  keys(value, ["version", "sessionHash", "turnHash", "requestKeyHash", "inputHash", "modelRef", "explicitModel"]);
  assert(value.version === 1 && typeof value.explicitModel === "boolean");
  for (const key of ["sessionHash", "turnHash", "requestKeyHash", "inputHash"]) hash(value[key]);
  require("./media-model-catalog.js").parseModelRef(value.modelRef);
  return structuredClone(value);
}
function parseJob(value) {
  keys(value, ["version", "id", "revision", "state", "requestHash", "profileIdentity", "request", "profileName", "estimatedCost", "createdAt", "updatedAt", "result", "error", "charging", ...(value?.version === 2 ? ["agentRequest"] : [])]);
  assert(value.version === 1 || value.version === 2); jobId(value.id); revision(value.revision); assert(value.revision >= 1 && value.revision <= 3);
  if (value.version === 2) parseAgentRequest(value.agentRequest);
  assert(STATES.includes(value.state)); hash(value.requestHash); hash(value.profileIdentity);
  const request = imageRequest(value.request);
  assert(value.requestHash === requestHash(request, value.profileIdentity));
  if (value.version === 2) assert(value.agentRequest.modelRef === modelRef(request.profileId, request.modelId));
  assert(typeof value.profileName === "string" && value.profileName.length <= 128 && !/[\x00-\x1f\x7f]/.test(value.profileName));
  for (const date of [value.createdAt, value.updatedAt]) assert(typeof date === "string" && Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date);
  keys(value.estimatedCost, ["status", "currency"]); assert(value.estimatedCost.status === "unknown" && value.estimatedCost.currency === null);
  assert(["not-submitted", "unknown"].includes(value.charging));
  if (value.result !== undefined) { assert(value.state === "succeeded"); resultDescriptor(value.result, value.id); }
  if (value.state === "succeeded") assert(value.result && !value.error);
  if (value.error !== undefined) {
    keys(value.error, ["code", "httpStatus"]); assert(ERROR_CODES.has(value.error.code));
    assert(value.error.httpStatus === undefined || Number.isInteger(value.error.httpStatus) && value.error.httpStatus >= 100 && value.error.httpStatus <= 599);
  }
  return structuredClone({ ...value, request });
}
function publicJob(value, summary = false) {
  const { version, profileIdentity, agentRequest, ...job } = structuredClone(value);
  if (summary) delete job.request.prompt;
  return job;
}
module.exports = { prepareInput, imageRequest, imageModel, jobId, hash, requestHash, parseJob, publicJob, ERROR_CODES, parseAgentRequest };
