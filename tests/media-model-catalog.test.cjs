"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { mediaModelCatalog, modelRef, parseModelRef } = require("../lib/media-model-catalog.js");
const { resolveImageModel } = require("../lib/media-model-resolver.js");
const p = (id, extra = {}) => ({ id, name: id, provider: "openai", enabled: true, credentialConfigured: true, modelId: "", models: [{ id: "gpt-image-2", name: "GPT Image 2", kind: "image" }], ...extra });
const catalog = (profiles, image = null) => mediaModelCatalog({ revision: 12, profiles, defaults: { image, video: null, audio: null } });
test("catalog describes actual implemented capabilities without credentials or network claims", () => {
  const c = catalog([p("ready"), p("disabled", { enabled: false }), p("no-key", { credentialConfigured: false }), p("comfy", { provider: "comfyui" }), p("audio", { provider: "xiaomi", models: [{ id: "tts", name: "TTS", kind: "audio" }] })]);
  assert.equal(c.configRevision, 12); assert.equal(c.models[0].ready, true);
  assert.deepEqual(c.models.slice(1).map(m => m.blockedBy), [["profile-disabled"], ["credential-required"], ["adapter-not-implemented"], ["adapter-not-implemented"]]);
  assert.ok(c.models[0].constraints.outputCount === 1); assert.ok(!JSON.stringify(c).includes("baseUrl"));
});
test("explicit, remembered, saved default and unique selection have deterministic precedence", () => {
  const c = catalog([p("a", { modelId: "gpt-image-2" }), p("b"), p("c")], "a");
  assert.equal(resolveImageModel(c, modelRef("c", "gpt-image-2"), modelRef("b", "gpt-image-2")).source, "explicit");
  assert.equal(resolveImageModel(c, undefined, modelRef("b", "gpt-image-2")).source, "session");
  assert.equal(resolveImageModel(c).source, "default");
  assert.equal(resolveImageModel(catalog([p("a")])).source, "unique");
});
test("explicit unavailable model never falls back, stale remembered choice can use valid default", () => {
  const c = catalog([p("a", { enabled: false }), p("b", { modelId: "gpt-image-2" })], "b");
  const unavailable = resolveImageModel(c, modelRef("a", "gpt-image-2"));
  assert.equal(unavailable.status, "unavailable"); assert.deepEqual(unavailable.blockedBy, ["profile-disabled"]);
  assert.equal(resolveImageModel(c, undefined, modelRef("a", "gpt-image-2")).model.profileId, "b");
  assert.equal(resolveImageModel(c, modelRef("missing", "gpt-image-2")).status, "unavailable");
});
test("multiple candidates require one selection and do not mutate defaults", () => {
  const c = catalog([p("a"), p("b")], "a"), before = structuredClone(c);
  const r = resolveImageModel(c); assert.equal(r.status, "selection-required"); assert.equal(r.choices.length, 2); assert.deepEqual(c, before);
  assert.equal(resolveImageModel(catalog([])).status, "unavailable");
});
test("model refs preserve encoded identifiers and reject ambiguous or malformed shapes", () => {
  const ref = modelRef("service:1", "gpt-image-2"); assert.deepEqual(parseModelRef(ref), { profileId: "service:1", modelId: "gpt-image-2" });
  for (const value of ["media:../x:gpt-image-2", "media:%xx:x", "media:a:b:c", "wrong:a:b", "media:%61:b"]) assert.throws(() => parseModelRef(value));
});
