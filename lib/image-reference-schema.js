"use strict";
const { createHash } = require("node:crypto");
const { assert, keys } = require("./media-provider-schema.js");
const { validatePng } = require("./image-png.js");
const MAX_REFERENCE_IMAGES = 16;
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_MULTIPART_BYTES = 16 * 1024 * 1024;
const REFERENCE_SCOPE = "bone-media/references/**";
const NO_REFERENCE_SUPPORT = Object.freeze({ supported: false,
  blockedBy: Object.freeze(["host-binary-image-input-required"]),
  requiredBinaryBodyBytes: MAX_MULTIPART_BYTES, hostMaxBinaryBodyBytes: null });
const referenceImagesSchema = {
  type: "array", minItems: 1, maxItems: MAX_REFERENCE_IMAGES,
  description: "Ordered local reference images staged under bone-media/references/. Each SHA-256 must match the original bytes. Requires host binary request support; never paste image Base64 into tool arguments.",
  items: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 512 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["path", "sha256"], additionalProperties: false },
};
function referenceSpecs(value) {
  assert(Array.isArray(value) && value.length > 0 && value.length <= MAX_REFERENCE_IMAGES);
  return value.map(item => {
    keys(item, ["path", "sha256"]);
    assert(typeof item.path === "string" && item.path.length <= 512 && item.path.startsWith("bone-media/references/") && !/[\\\x00-\x1f\x7f:]/.test(item.path));
    assert(item.path.split("/").every(part => part && part !== "." && part !== ".." && part.length <= 255));
    assert(/\.(?:png|jpe?g|webp)$/i.test(item.path) && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256));
    return { path: item.path, sha256: item.sha256 };
  });
}
function referenceBytes(preview, expectedHash) {
  assert(preview?.kind === "image" && Number.isSafeInteger(preview.size) && preview.size > 0 && preview.size <= MAX_REFERENCE_BYTES, "REFERENCE_INVALID");
  assert(typeof preview.dataUrl === "string" && preview.dataUrl.length <= Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 40, "REFERENCE_INVALID");
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(preview.dataUrl);
  assert(match, "REFERENCE_INVALID");
  const bytes = Buffer.from(match[2], "base64"), mimeType = match[1];
  assert(bytes.length === preview.size && bytes.toString("base64") === match[2], "REFERENCE_INVALID");
  if (mimeType === "image/png") {
    try { validatePng(bytes); } catch { assert(false, "REFERENCE_INVALID"); }
  } else if (mimeType === "image/jpeg") {
    assert(bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217, "REFERENCE_INVALID");
  } else {
    assert(bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16)), "REFERENCE_INVALID");
  }
  assert(createHash("sha256").update(bytes).digest("hex") === expectedHash, "REFERENCE_CHANGED");
  return { mimeType, bytes };
}
const referenceConstraints = Object.freeze({ maxImages: MAX_REFERENCE_IMAGES, maxImageBytes: MAX_REFERENCE_BYTES, maxTotalBytes: MAX_REFERENCE_TOTAL_BYTES,
  formats: ["image/png", "image/jpeg", "image/webp"], scope: REFERENCE_SCOPE, sha256Required: true, maskSupported: false });
module.exports = { referenceSpecs, referenceBytes, referenceImagesSchema, referenceConstraints, NO_REFERENCE_SUPPORT, MAX_REFERENCE_TOTAL_BYTES, MAX_MULTIPART_BYTES, REFERENCE_SCOPE };
