"use strict";
const { assert, keys } = require("./media-provider-schema.js");
const { digest } = require("./agent-image-request.js");
const { parseModelRef } = require("./media-model-catalog.js");
const { audioRequest } = require("./audio-generation-schema.js");
function agentAudioInput(input) {
  keys(input, ["requestKey", "modelRef", "operation", "text", "voiceId", "speed", "waitMs"]);
  assert(typeof input.requestKey === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(input.requestKey));
  if (input.modelRef !== undefined) parseModelRef(input.modelRef);
  const normalized = audioRequest({ profileId: "validation", expectedRevision: 0, modelId: "speech-2.6-hd", operation: input.operation, text: input.text, voiceId: input.voiceId, speed: input.speed });
  const waitMs = input.waitMs ?? 10000;
  assert(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 10000);
  const intent = { modelRef: input.modelRef ?? null, operation: normalized.operation, text: normalized.text, voiceId: normalized.voiceId, speed: normalized.speed };
  return { requestKey: input.requestKey, ...intent, waitMs, inputHash: digest(JSON.stringify(intent)) };
}
module.exports = { agentAudioInput };
