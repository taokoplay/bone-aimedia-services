"use strict";
const { createAgentGenerationService } = require("./agent-generation-service.js");
const { jobId } = require("./image-generation-schema.js");
const { agentInput } = require("./agent-image-request.js");
const { resolveImageModel } = require("./media-model-resolver.js");
const { imageReply } = require("./agent-image-result.js");
function createAgentImageService({ settings, images, exporter, clock }) {
  const { check, ...service } = createAgentGenerationService({ settings, engine: images, exporter, clock,
    domain: { kind: "image", prefix: "img", jobId, input: agentInput, resolveModel: resolveImageModel, reply: imageReply,
      request: parsed => ({ prompt: parsed.prompt, size: parsed.size, quality: parsed.quality }) } });
  return service;
}
module.exports = { createAgentImageService };
