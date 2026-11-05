"use strict";
const { parseModelRef } = require("./media-model-catalog.js");
function resolveMediaModel(catalog, explicitRef, rememberedRef, kind, operation) {
  const candidates = catalog.models.filter(model => model.kind === kind && model.ready && model.operations.includes(operation));
  const choices = candidates.map(({ modelRef, profileName, modelName }) => ({ modelRef, profileName, modelName }));
  if (explicitRef !== undefined) {
    parseModelRef(explicitRef);
    const selected = catalog.models.find(model => model.modelRef === explicitRef && model.kind === kind);
    if (!selected || !candidates.includes(selected)) return { status: "unavailable", code: "MODEL_UNAVAILABLE", requestedModelRef: explicitRef, blockedBy: selected?.blockedBy.length ? selected.blockedBy : [selected ? "operation-not-supported" : "model-not-configured"], choices };
    return { status: "selected", source: "explicit", model: selected };
  }
  const remembered = candidates.find(model => model.modelRef === rememberedRef);
  if (remembered) return { status: "selected", source: "session", model: remembered };
  const defaultModel = candidates.find(model => model.isDefault);
  if (defaultModel) return { status: "selected", source: "default", model: defaultModel };
  if (candidates.length === 1) return { status: "selected", source: "unique", model: candidates[0] };
  return { status: candidates.length ? "selection-required" : "unavailable", code: candidates.length ? "MODEL_SELECTION_REQUIRED" : "MODEL_UNAVAILABLE", choices };
}
const resolveImageModel = (catalog, explicitRef, rememberedRef) => resolveMediaModel(catalog, explicitRef, rememberedRef, "image", "image.generate");
const resolveAudioModel = (catalog, explicitRef, rememberedRef) => resolveMediaModel(catalog, explicitRef, rememberedRef, "audio", "audio.speech");
module.exports = { resolveImageModel, resolveAudioModel };
