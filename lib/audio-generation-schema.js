"use strict";
const { assert, keys, identifier, revision } = require("./media-provider-schema.js");
const { modelRef } = require("./media-model-catalog.js");
const { hash, requestHash, parseAgentRequest, ERROR_CODES: IMAGE_ERROR_CODES } = require("./image-generation-schema.js");
const { isSupportedAudioModel } = require("./audio-models.js");
const { MAX_AUDIO_BYTES, MAX_DURATION_MS, SAMPLE_RATES } = require("./audio-mp3.js");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUDIO_JOB_ID = /^aud-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODES = new Set([...IMAGE_ERROR_CODES, "RATE_LIMITED", "INVALID_ARGUMENT"]);
const CREDENTIAL_LITERAL = /\b(?:bearer\s+\S+|sk-[a-z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=])/i;
function jobId(value) { assert(typeof value === "string" && AUDIO_JOB_ID.test(value)); return value; }
function audioModel(value) { identifier(value); assert(isSupportedAudioModel(value), "GENERATION_UNSUPPORTED", "Select a configured MiniMax speech model."); return value; }
function audioRequest(value) {
  keys(value, ["profileId", "expectedRevision", "modelId", "operation", "text", "voiceId", "speed", "format", "outputCount"]);
  identifier(value.profileId); revision(value.expectedRevision); audioModel(value.modelId);
  assert(value.operation === "speech", "GENERATION_UNSUPPORTED", "Only speech synthesis is supported.");
  for (const [field, maximum] of [["text", 1000], ["voiceId", 128]]) {
    const text = value[field];
    const invalidControls = field === "text" ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/;
    assert(typeof text === "string" && text.length <= maximum * 2 && text.trim().length > 0 && text.isWellFormed() && [...text].length <= maximum && !invalidControls.test(text));
    assert(!CREDENTIAL_LITERAL.test(text), "INVALID_ARGUMENT", "Credentials cannot appear in speech parameters.");
  }
  const speed = value.speed === undefined ? 1 : value.speed;
  assert(typeof speed === "number" && Number.isFinite(speed) && speed >= 0.5 && speed <= 2);
  assert(value.format === undefined || value.format === "mp3");
  assert(value.outputCount === undefined || value.outputCount === 1);
  return { profileId: value.profileId, expectedRevision: value.expectedRevision, modelId: value.modelId,
    operation: "speech", text: value.text.trim(), voiceId: value.voiceId.trim(), speed, format: "mp3", outputCount: 1 };
}
function prepareInput(value) {
  keys(value, ["requestId", "profileId", "expectedRevision", "modelId", "operation", "text", "voiceId", "speed"]);
  assert(typeof value.requestId === "string" && UUID.test(value.requestId));
  const { requestId, ...request } = value;
  return { id: `aud-${requestId}`, request: audioRequest(request) };
}
function resultDescriptor(value, id) {
  keys(value, ["resultId", "mimeType", "byteLength", "sha256", "durationMs", "sampleRate", "channels", "verification", "quality"]);
  assert(value.resultId === id && value.mimeType === "audio/mpeg" && value.verification === "mp3-frames-validated" && value.quality === "not-reviewed");
  hash(value.sha256);
  assert(Number.isInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= MAX_AUDIO_BYTES);
  assert(Number.isInteger(value.durationMs) && value.durationMs > 0 && value.durationMs <= MAX_DURATION_MS);
  assert(SAMPLE_RATES.includes(value.sampleRate) && [1, 2].includes(value.channels));
  return structuredClone(value);
}
function parseJob(value) {
  keys(value, ["version", "id", "revision", "state", "requestHash", "profileIdentity", "request", "profileName", "estimatedCost", "createdAt", "updatedAt", "result", "error", "charging", ...(value?.version === 2 ? ["agentRequest"] : [])]);
  assert(value.version === 1 || value.version === 2); jobId(value.id); revision(value.revision); assert(value.revision >= 1 && value.revision <= 3);
  if (value.version === 2) parseAgentRequest(value.agentRequest);
  assert(["prepared", "submitting", "succeeded", "failed", "unknown", "result-pending"].includes(value.state)); hash(value.requestHash); hash(value.profileIdentity);
  const request = audioRequest(value.request);
  assert(value.requestHash === requestHash(request, value.profileIdentity));
  if (value.version === 2) assert(value.agentRequest.modelRef === modelRef(request.profileId, request.modelId));
  assert(typeof value.profileName === "string" && value.profileName.length <= 128 && value.profileName.isWellFormed() && !/[\x00-\x1f\x7f]/.test(value.profileName));
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
  if (summary) delete job.request.text;
  return { ...job, kind: "audio" };
}
module.exports = { prepareInput, audioRequest, audioModel, jobId, AUDIO_JOB_ID, hash, requestHash, resultDescriptor, parseJob, publicJob, ERROR_CODES, parseAgentRequest };
