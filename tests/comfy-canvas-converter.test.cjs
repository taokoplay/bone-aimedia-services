"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { convertCanvasWorkflow } = require("../lib/comfy-canvas-converter.js");

const info = {
  LoadImage: { input: { required: { image: ["STRING", { default: "input.png" }] } } },
  CLIPTextEncode: { input: { required: { text: ["STRING", { default: "prompt" }], clip: ["CLIP"] } } },
  SaveVideo: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "video" }] } } },
};

test("Canvas converter maps links and widget values into a safe API prompt", () => {
  const result = convertCanvasWorkflow({
    nodes: [
      { id: 1, type: "LoadImage", inputs: [{ name: "image", link: null }], widgets_values: ["first.png"] },
      { id: 2, type: "CLIPTextEncode", inputs: [{ name: "clip", link: 1 }, { name: "text", link: null }], widgets_values: ["walk forward"] },
      { id: 3, type: "SaveVideo", inputs: [{ name: "images", link: 2 }], widgets_values: [] },
    ],
    links: [
      [1, 99, 0, 2, 0, "CLIP"],
      [2, 2, 0, 3, 0, "IMAGE"],
    ],
  }, info);
  assert.equal(result.ok, true);
  assert.deepEqual(result.definition["1"].inputs, { image: "first.png" });
  assert.deepEqual(result.definition["2"].inputs, { clip: ["99", 0], text: "walk forward" });
  assert.deepEqual(result.definition["3"].inputs, { images: ["2", 0], filename_prefix: "video" });
});

test("Canvas converter refuses missing node metadata, missing required widgets and unlinked inputs", () => {
  const result = convertCanvasWorkflow({ nodes: [{ id: 1, type: "UnknownNode", inputs: [], widgets_values: [] }], links: [] }, info);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "CANVAS_NODE_INFO_MISSING");

  const missing = convertCanvasWorkflow({ nodes: [{ id: 2, type: "CLIPTextEncode", inputs: [], widgets_values: [] }], links: [] }, { ...info, CLIPTextEncode: { input: { required: { text: ["STRING"], clip: ["CLIP"] } } } });
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some(issue => issue.code === "CANVAS_WIDGET_MISSING"));
  assert.ok(missing.issues.some(issue => issue.code === "CANVAS_INPUT_UNLINKED"));
});

test("Canvas converter rejects unverifiable links and bypassed nodes", () => {
  const result = convertCanvasWorkflow({
    nodes: [{ id: 1, type: "LoadImage", mode: 4, inputs: [{ name: "image", link: 7 }], widgets_values: ["x.png"] }],
    links: [[7, 1, 0, 99, 0, "IMAGE"]],
  }, info);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.code === "CANVAS_NODE_MODE_UNSUPPORTED"));
});
