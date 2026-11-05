"use strict";
const { createMediaGeneration } = require("./media-generation.js");
const { createImageJobStorage } = require("./image-job-storage.js");
const { generateGptImage } = require("./gpt-image-adapter.js");
const { validatePng } = require("./image-png.js");
const schema = require("./image-generation-schema.js");
function createImageGeneration({ getDataPath, settings, request, now, budget }) {
  return createMediaGeneration({ store: createImageJobStorage(getDataPath, schema.parseJob), schema,
    withProfile: (input, work) => settings.withImageProfile(input, work), generate: generateGptImage,
    validateResult: validatePng, kind: "image", mimeType: "image/png", request, now, budget });
}
module.exports = { createImageGeneration };
