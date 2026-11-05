"use strict";
// Keep this leaf module independent of schemas and catalogs to avoid cycles.
const SUPPORTED_AUDIO_MODEL_IDS = Object.freeze([
  "speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo",
  "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo",
]);
function isSupportedAudioModel(value) { return typeof value === "string" && SUPPORTED_AUDIO_MODEL_IDS.includes(value); }
module.exports = { SUPPORTED_AUDIO_MODEL_IDS, isSupportedAudioModel };
