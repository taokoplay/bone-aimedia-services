"use strict";
const { assert, keys } = require("./media-provider-schema.js");
const { createAgentGenerationService } = require("./agent-generation-service.js");
const { jobId } = require("./audio-generation-schema.js");
const { agentAudioInput } = require("./agent-audio-request.js");
const { resolveAudioModel } = require("./media-model-resolver.js");
const { mediaModelCatalog } = require("./media-model-catalog.js");
const { validateMp3 } = require("./audio-mp3.js");
const { contextIdentity } = require("./agent-image-request.js");
const { toolReply } = require("./agent-image-result.js");
async function audioReply(job, readResult, checkCurrent) {
  if (job.state !== "succeeded") return toolReply({ ok: true, job, delivery: { status: "not-ready", nextAction: ["prepared", "submitting"].includes(job.state) ? "audio_job.wait" : "audio_job.get" } });
  const { bytes } = await readResult(job.id); checkCurrent();
  const descriptor = validateMp3(bytes);
  assert(descriptor.sha256 === job.result.sha256 && descriptor.byteLength === job.result.byteLength, "RESULT_INVALID");
  return toolReply({ ok: true, job, delivery: { status: "export-required", mimeType: "audio/mpeg", nextAction: "export_audio_result", reason: "host-audio-content-unavailable", quality: "not-reviewed" } });
}
function createAgentAudioService({ settings, audio, exporter, clock }) {
  const service = createAgentGenerationService({ settings, engine: audio, exporter, clock,
    domain: { kind: "audio", prefix: "aud", jobId, input: agentAudioInput, resolveModel: resolveAudioModel, reply: audioReply,
      request: parsed => ({ operation: parsed.operation, text: parsed.text, voiceId: parsed.voiceId, speed: parsed.speed }) } });
  async function voices(input, ctx) {
    contextIdentity(ctx, true); service.check(ctx); keys(input, ["modelRef"]);
    assert(typeof input.modelRef === "string");
    const snapshot = await settings.read(); service.check(ctx);
    const selection = resolveAudioModel(mediaModelCatalog(snapshot, "audio"), input.modelRef);
    if (selection.status !== "selected") return toolReply({ ok: false, selection });
    const result = await settings.probe({ profileId: selection.model.profileId, expectedRevision: snapshot.revision, catalog: "voices" });
    service.check(ctx);
    return toolReply({ ok: result.catalogs?.voices?.status === "connected", modelRef: input.modelRef, voices: result.voices,
      catalog: result.catalogs?.voices, checkedAt: result.checkedAt, nextAction: "Choose an explicit voiceId for generate_audio; no voice is automatically selected." });
  }
  const { check, ...publicService } = service;
  return { ...publicService, voices };
}
module.exports = { createAgentAudioService, audioReply };
