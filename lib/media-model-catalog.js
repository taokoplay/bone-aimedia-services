"use strict";
const { assert, identifier } = require("./media-provider-schema.js");
const { isSupportedAudioModel } = require("./audio-models.js");
const AUDIO_CONSTRAINTS = Object.freeze({ operation: "speech", maxTextLength: 1000, voiceIdRequired: true, speed: { minimum: 0.5, maximum: 2, default: 1 }, formats: ["mp3"], outputCount: 1, maxAudioBytes: 16777216, price: "unknown" });
const IMAGE_CONSTRAINTS = Object.freeze({ sizes: ["1024x1024", "1536x1024", "1024x1536"], qualities: ["low", "medium", "high"], defaultSize: "1024x1024", defaultQuality: "medium", outputCount: 1, outputFormat: "png", price: "unknown" });
function modelRef(profileId, modelId) { return `media:${encodeURIComponent(identifier(profileId))}:${encodeURIComponent(identifier(modelId))}`; }
function parseModelRef(value) {
  assert(typeof value === "string" && value.length <= 900, "INVALID_ARGUMENT");
  const parts = value.split(":"); assert(parts.length === 3 && parts[0] === "media", "INVALID_ARGUMENT");
  let profileId, modelId;
  try { profileId = decodeURIComponent(parts[1]); modelId = decodeURIComponent(parts[2]); } catch { assert(false, "INVALID_ARGUMENT"); }
  assert(modelRef(profileId, modelId) === value, "INVALID_ARGUMENT"); return { profileId, modelId };
}
function mediaModelCatalog(snapshot, kind) {
  assert(kind === undefined || ["image", "video", "audio"].includes(kind), "INVALID_ARGUMENT");
  const models = snapshot.profiles.flatMap(profile => profile.models.filter(model => !kind || model.kind === kind).map(model => {
    const image = profile.provider === "openai" && model.kind === "image" && /^gpt-image-[A-Za-z0-9_.-]+$/.test(model.id);
    const audio = profile.provider === "minimax" && model.kind === "audio" && isSupportedAudioModel(model.id);
    const implemented = image || audio;
    const blockedBy = [];
    if (!implemented) blockedBy.push("adapter-not-implemented");
    if (!profile.enabled) blockedBy.push("profile-disabled");
    if (implemented && !profile.credentialConfigured) blockedBy.push("credential-required");
    const isDefault = snapshot.defaults[model.kind] === profile.id && profile.modelId === model.id;
    return { modelRef: modelRef(profile.id, model.id), profileId: profile.id, profileName: profile.name, provider: profile.provider,
      modelId: model.id, modelName: model.name, kind: model.kind, operations: image ? ["image.generate"] : audio ? ["audio.speech"] : [],
      implemented, ready: blockedBy.length === 0, blockedBy, isDefault, defaultProfile: snapshot.defaults[model.kind] === profile.id,
      ...(implemented ? { constraints: structuredClone(image ? IMAGE_CONSTRAINTS : AUDIO_CONSTRAINTS) } : {}) };
  }));
  return { contractVersion: 1, configRevision: snapshot.revision, models, defaults: structuredClone(snapshot.defaults),
    observation: "Local configuration only. Provider availability, pricing and image quality are not verified." };
}
module.exports = { modelRef, parseModelRef, mediaModelCatalog, IMAGE_CONSTRAINTS, AUDIO_CONSTRAINTS };
