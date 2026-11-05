"use strict";
const { assert } = require("./media-provider-schema.js");
const { validatePng } = require("./image-png.js");
const INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
function toolReply(data, image) {
  const content = [{ type: "text", text: JSON.stringify(data) }];
  if (image) content.push({ type: "image", mimeType: "image/png", data: image.toString("base64") });
  return { content, structuredContent: data };
}
async function imageReply(job, readResult, checkCurrent) {
  if (job.state !== "succeeded") return toolReply({ ok: true, job, delivery: { status: "not-ready", nextAction: ["prepared", "submitting"].includes(job.state) ? "image_job.wait" : "image_job.get" } });
  if (job.result.byteLength > INLINE_IMAGE_BYTES) return toolReply({ ok: true, job, delivery: { status: "export-required", reason: "inline-size-limit", nextAction: "export_image_result", maxInlineBytes: INLINE_IMAGE_BYTES } });
  const { bytes } = await readResult(job.id); checkCurrent();
  const descriptor = validatePng(bytes);
  assert(descriptor.sha256 === job.result.sha256 && descriptor.byteLength === job.result.byteLength, "RESULT_INVALID");
  return toolReply({ ok: true, job, delivery: { status: "image-content", mimeType: "image/png", quality: "not-reviewed" } }, bytes);
}
module.exports = { INLINE_IMAGE_BYTES, toolReply, imageReply };
