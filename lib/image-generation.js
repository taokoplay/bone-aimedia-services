"use strict";
const { createMediaGeneration } = require("./media-generation.js");
const { createImageJobStorage } = require("./image-job-storage.js");
const { generateGptImage } = require("./gpt-image-adapter.js");
const { validatePng } = require("./image-png.js");
const schema = require("./image-generation-schema.js");
const { assert } = require("./media-provider-schema.js");
const { referenceSpecs, NO_REFERENCE_SUPPORT } = require("./image-reference-schema.js");
function createImageGeneration({ getDataPath, settings, request, now, budget, references, captureProject }) {
  const generate = async invocation => {
    if (!invocation.input.referenceImages) return generateGptImage(invocation);
    assert(references?.support?.supported === true, "REFERENCE_UNSUPPORTED");
    const loaded = await references.load(invocation.input.referenceImages, { workspaceHash: invocation.input.referenceWorkspaceHash, checkCurrent: invocation.checkCurrent });
    invocation.checkCurrent();
    return generateGptImage({ ...invocation, referenceImages: loaded.images, referenceTransport: references.support.transport });
  };
  const engine = createMediaGeneration({ store: createImageJobStorage(getDataPath, schema.parseJob), schema,
    withProfile: (input, work) => settings.withImageProfile(input, work), generate,
    validateResult: validatePng, kind: "image", mimeType: "image/png", request, now, budget, captureProject });
  return { ...engine, referenceSupport: references?.support ?? NO_REFERENCE_SUPPORT,
    async prepare(input, agentRequest, context, checkCurrent = () => {}) {
      if (input?.referenceImages === undefined) return engine.prepare(input, agentRequest, context);
      const { referenceImages, ...base } = input;
      schema.prepareInput(base);
      const specs = referenceSpecs(referenceImages);
      assert(references?.support?.supported === true, "REFERENCE_UNSUPPORTED");
      let saved;
      try { saved = await engine.get({ jobId: `img-${base.requestId}` }); }
      catch (error) { if (error?.code !== "NOT_FOUND") throw error; }
      checkCurrent();
      if (saved) {
        assert(saved.request.referenceWorkspaceHash, "GENERATION_REQUEST_CONFLICT");
        return engine.prepare({ ...base, referenceImages: specs, referenceWorkspaceHash: saved.request.referenceWorkspaceHash }, agentRequest, context);
      }
      const loaded = await references.load(specs, { checkCurrent });
      checkCurrent();
      return engine.prepare({ ...base, referenceImages: specs, referenceWorkspaceHash: loaded.workspaceHash }, agentRequest, context);
    } };
}
module.exports = { createImageGeneration };
