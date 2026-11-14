"use strict";
const { randomUUID } = require("node:crypto");
const { assert } = require("./media-provider-schema.js");
const { MAX_MULTIPART_BYTES } = require("./image-reference-schema.js");
function imageEditBody(input, images) {
  let boundary;
  do { boundary = `bone-image-${randomUUID()}`; } while (images.some(image => image.bytes.includes(Buffer.from(boundary))) || input.prompt.includes(boundary));
  const parts = [], text = value => parts.push(Buffer.from(value, "utf8"));
  for (const [name, value] of Object.entries({ model: input.modelId, prompt: input.prompt, n: 1, size: input.size, quality: input.quality, output_format: "png" })) {
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  images.forEach((image, index) => {
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.mimeType];
    assert(extension, "REFERENCE_INVALID");
    text(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="reference-${index + 1}.${extension}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`);
    parts.push(image.bytes); text("\r\n");
  });
  text(`--${boundary}--\r\n`);
  const bytes = Buffer.concat(parts); assert(bytes.length <= MAX_MULTIPART_BYTES, "REFERENCE_INVALID");
  return { bodyBase64: bytes.toString("base64"), contentType: `multipart/form-data; boundary=${boundary}` };
}
module.exports = { imageEditBody };
