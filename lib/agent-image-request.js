"use strict";
const { createHash } = require("node:crypto");
const { assert, keys } = require("./media-provider-schema.js");
const { imageRequest, parseAgentRequest } = require("./image-generation-schema.js");
const { parseModelRef } = require("./media-model-catalog.js");
const digest = value => createHash("sha256").update(value).digest("hex");
function contextIdentity(ctx, mutating = false) {
  assert(ctx && typeof ctx.sessionId === "string" && ctx.sessionId.length > 0 && ctx.sessionId.length <= 256 &&
    typeof ctx.turnId === "string" && ctx.turnId.length > 0 && ctx.turnId.length <= 256, "AGENT_CONTEXT_REQUIRED", "A host-attested session and turn are required.");
  assert(["agent", "plan", "goal"].includes(ctx.mode), "AGENT_CONTEXT_REQUIRED", "A host-attested operating mode is required.");
  if (mutating) assert(ctx.mode === "agent", "PERMISSION_DENIED", "Generation and export require Agent mode.");
  assert(!ctx.signal?.aborted, "TOOL_ABORTED", "This tool invocation was cancelled.");
  return { sessionHash: digest(ctx.sessionId), turnHash: digest(ctx.turnId) };
}
function agentInput(input) {
  keys(input, ["requestKey", "modelRef", "prompt", "size", "quality", "waitMs"]);
  assert(typeof input.requestKey === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(input.requestKey));
  if (input.modelRef !== undefined) parseModelRef(input.modelRef);
  const normalized = imageRequest({ profileId: "validation", expectedRevision: 0, modelId: "gpt-image-validation", prompt: input.prompt, size: input.size, quality: input.quality });
  const waitMs = input.waitMs ?? 10000;
  assert(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 10000);
  const intent = { modelRef: input.modelRef ?? null, prompt: normalized.prompt, size: normalized.size, quality: normalized.quality };
  return { requestKey: input.requestKey, ...intent, waitMs, inputHash: digest(JSON.stringify(intent)) };
}
function agentJobIdentity(sessionHash, requestKey) {
  const bytes = Buffer.from(digest(`bone.aimedia.agent-request.v1\0${sessionHash}\0${requestKey}`).slice(0, 32), "hex");
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
module.exports = { digest, contextIdentity, agentInput, agentJobIdentity, parseAgentRequest };
