"use strict";
const { createMediaGeneration } = require("./media-generation.js");
const { createMediaJobStorage } = require("./media-job-storage.js");
const { generateMinimaxSpeech } = require("./minimax-speech-adapter.js");
const { validateMp3, MAX_AUDIO_BYTES } = require("./audio-mp3.js");
const schema = require("./audio-generation-schema.js");
function createAudioGeneration({ getDataPath, settings, request, now, budget }) {
  const store = createMediaJobStorage(getDataPath, schema.parseJob, {
    kind: "audio", idPattern: schema.AUDIO_JOB_ID, resultExtension: "mp3", maxResultBytes: MAX_AUDIO_BYTES,
  });
  return createMediaGeneration({ store, schema, withProfile: (input, work) => settings.withAudioProfile(input, work),
    generate: generateMinimaxSpeech, validateResult: validateMp3, kind: "audio", mimeType: "audio/mpeg", request, now, budget });
}
module.exports = { createAudioGeneration };
