"use strict";
const { randomUUID } = require("node:crypto");
const { assert } = require("./media-provider-schema.js");
const { MAX_MULTIPART_BYTES, MAX_JSON_REFERENCE_BODY_BYTES } = require("./image-reference-schema.js");
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
function jsonBody(fields) {
  const body = JSON.stringify(fields);
  assert(Buffer.byteLength(body) <= MAX_JSON_REFERENCE_BODY_BYTES, "REFERENCE_INVALID");
  return { contentType: "application/json", body };
}
function imageRequestBody(input, images, transport = "multipart") {
  const fields = { model: input.modelId, prompt: input.prompt, n: 1, size: input.size, quality: input.quality, output_format: "png" };
  if (!Array.isArray(images) || images.length === 0) return jsonBody(fields);
  for (const image of images) assert(Object.hasOwn(extensions, image.mimeType), "REFERENCE_INVALID");
  if (transport === "json-data-url") {
    return jsonBody({ ...fields, images: images.map(image => ({ image_url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` })) });
  }
  assert(transport === "multipart", "REFERENCE_UNSUPPORTED");
  let boundary;
  do { boundary = `bone-image-${randomUUID()}`; } while (images.some(image => image.bytes.includes(Buffer.from(boundary))) || input.prompt.includes(boundary));
  const parts = [], text = value => parts.push(Buffer.from(value, "utf8"));
  for (const [name, value] of Object.entries(fields)) {
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  images.forEach((image, index) => {
    text(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference-${index + 1}.${extensions[image.mimeType]}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`);
    parts.push(image.bytes); text("\r\n");
  });
  text(`--${boundary}--\r\n`);
  const bytes = Buffer.concat(parts); assert(bytes.length <= MAX_MULTIPART_BYTES, "REFERENCE_INVALID");
  return { bodyBase64: bytes.toString("base64"), contentType: `multipart/form-data; boundary=${boundary}` };
}
module.exports = { imageRequestBody };
