"use strict";

const { createHash } = require("node:crypto");
const { assert, object } = require("./media-provider-schema.js");

const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MIME_BY_KIND = Object.freeze({ image: ["image/png", "image/jpeg", "image/webp"], video: ["video/mp4", "video/webm"], audio: ["audio/mpeg", "audio/wav", "audio/ogg"] });
const FIELD_BY_KIND = Object.freeze({ image: "images", video: "videos", audio: "audio" });

function safePath(value) {
  assert(typeof value === "string" && value.length > 0 && value.length <= 512);
  assert(!value.includes("\0") && !value.includes("\\") && !value.includes("://"));
  const parts = value.split("/");
  assert(parts.every(part => part && part !== "." && part !== ".." && part.trim() === part));
  return value;
}
function fileRef(value) {
  assert(object(value));
  const keys = Object.keys(value);
  assert(keys.every(key => ["filename", "subfolder", "type"].includes(key)));
  const filename = safePath(value.filename);
  const subfolder = value.subfolder === undefined || value.subfolder === "" ? "" : safePath(value.subfolder);
  const type = value.type === undefined ? "output" : value.type;
  assert(["output", "input", "temp"].includes(type));
  return { filename, subfolder, type };
}
function outputRule(value, expectedKind) {
  assert(object(value));
  const keys = Object.keys(value);
  assert(keys.every(key => ["kind", "nodeId", "field", "index"].includes(key)));
  const kind = value.kind || expectedKind;
  assert(["image", "video", "audio"].includes(kind));
  const field = value.field || FIELD_BY_KIND[kind];
  assert(FIELD_BY_KIND[kind] === field);
  assert(typeof value.nodeId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.nodeId));
  const index = value.index === undefined ? 0 : value.index;
  assert(Number.isSafeInteger(index) && index >= 0 && index < 100);
  return { kind, nodeId: value.nodeId, field, index };
}
function outputRules(value, kind) {
  assert(Array.isArray(value) && value.length >= 1 && value.length <= 8);
  const rules = value.map(item => outputRule(item, kind));
  assert(new Set(rules.map(item => `${item.kind}:${item.nodeId}:${item.field}:${item.index}`)).size === rules.length);
  assert(rules.every(item => item.kind === kind));
  return rules;
}
function selectOutputs(history, rules) {
  assert(object(history));
  const results = [];
  for (const rule of rules) {
    const node = history[rule.nodeId];
    const values = node?.outputs?.[rule.field] || node?.[rule.field];
    assert(Array.isArray(values), "RESULT_UNAVAILABLE");
    const value = values[rule.index];
    assert(value !== undefined, "RESULT_UNAVAILABLE");
    results.push({ rule, file: fileRef(value) });
  }
  return results;
}
function kindMime(kind, contentType, file) {
  const normalized = typeof contentType === "string" ? contentType.split(";", 1)[0].toLowerCase() : "";
  const extension = file.filename.toLowerCase().split(".").pop();
  const allowed = MIME_BY_KIND[kind];
  const extensionMime = kind === "image" ? { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }[extension]
    : kind === "video" ? { mp4: "video/mp4", webm: "video/webm" }[extension]
      : { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg" }[extension];
  assert(extensionMime && (normalized === "" || normalized === extensionMime) && allowed.includes(extensionMime), "RESULT_INVALID");
  return extensionMime;
}
function validateBytes(kind, bytes, mimeType) {
  assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_RESULT_BYTES, "RESULT_INVALID");
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  const webp = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  const mp4 = bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  const webm = bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const mp3 = bytes.length >= 3 && (bytes.toString("ascii", 0, 3) === "ID3" || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const wav = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  const ogg = bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS";
  const valid = kind === "image" && ((mimeType === "image/png" && png) || (mimeType === "image/jpeg" && jpeg) || (mimeType === "image/webp" && webp))
    || kind === "video" && ((mimeType === "video/mp4" && mp4) || (mimeType === "video/webm" && webm))
    || kind === "audio" && ((mimeType === "audio/mpeg" && mp3) || (mimeType === "audio/wav" && wav) || (mimeType === "audio/ogg" && ogg));
  assert(valid, "RESULT_INVALID");
  return { mimeType, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), verification: "comfy-output-signature-validated" };
}
function resultDescriptor(kind, bytes, contentType, file) {
  const mimeType = kindMime(kind, contentType, file);
  return { ...validateBytes(kind, bytes, mimeType), extension: file.filename.toLowerCase().split(".").pop() };
}
module.exports = { MAX_RESULT_BYTES, FIELD_BY_KIND, outputRule, outputRules, selectOutputs, resultDescriptor, safePath, fileRef };
