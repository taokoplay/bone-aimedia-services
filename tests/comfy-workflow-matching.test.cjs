"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { matchWorkflow } = require("../lib/comfy-workflow-matching.js");

test("workflow matching suggests scalar, frame and output fields without exposing defaults", () => {
  const result = matchWorkflow({
    "1": { class_type: "CLIPTextEncode", _meta: { title: "Positive prompt" }, inputs: { text: "a prompt" } },
    "2": { class_type: "CLIPTextEncode", _meta: { title: "Negative prompt" }, inputs: { text: "bad" } },
    "3": { class_type: "LoadImage", _meta: { title: "First frame" }, inputs: { image: "first.png" } },
    "4": { class_type: "LoadImage", _meta: { title: "Last frame" }, inputs: { image: "last.png" } },
    "5": { class_type: "SaveVideo", inputs: { filename_prefix: "video" } },
  }, "video");
  assert.deepEqual(result.suggestedBindings, [
    { purpose: "prompt", nodeId: "1", input: "text" },
    { purpose: "negativePrompt", nodeId: "2", input: "text" },
    { purpose: "firstFrame", nodeId: "3", input: "image" },
    { purpose: "lastFrame", nodeId: "4", input: "image" },
  ]);
  assert.deepEqual(result.suggestedOutput, { kind: "video", nodeId: "5", field: "videos", index: 0 });
  assert.equal(result.supportsReferenceImages, true);
  assert.equal(result.inputs.some(item => Object.hasOwn(item, "value")), false);
});

test("workflow matching handles localized frame titles and common video node fields", () => {
  const result = matchWorkflow({
    "10": { class_type: "LoadImage", _meta: { title: "参考图" }, inputs: { image: "reference.png" } },
    "11": { class_type: "LoadImage", _meta: { title: "尾帧" }, inputs: { image: "last.png" } },
    "12": { class_type: "KSampler", inputs: { noise_seed: 1, width: 1024, height: 576, steps: 18 } },
    "13": { class_type: "EmptyLatentVideo", inputs: { num_frames: 49, frame_rate: 24 } },
    "14": { class_type: "VHS_VideoCombine", inputs: { filename_prefix: "result" } },
  }, "video");
  assert.deepEqual(result.suggestedBindings, [
    { purpose: "referenceImage1", nodeId: "10", input: "image" },
    { purpose: "lastFrame", nodeId: "11", input: "image" },
    { purpose: "seed", nodeId: "12", input: "noise_seed" },
    { purpose: "width", nodeId: "12", input: "width" },
    { purpose: "height", nodeId: "12", input: "height" },
    { purpose: "steps", nodeId: "12", input: "steps" },
    { purpose: "duration", nodeId: "13", input: "num_frames" },
    { purpose: "fps", nodeId: "13", input: "frame_rate" },
  ]);
  assert.deepEqual(result.suggestedOutput, { kind: "video", nodeId: "14", field: "videos", index: 0 });
});
