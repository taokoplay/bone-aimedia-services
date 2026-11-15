"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { referenceBytes } = require("../lib/image-reference-schema.js");
const { imageRequestBody } = require("../lib/gpt-image-body.js");
const { png } = require("./image-fixture.cjs");
// Deterministic 2x2 RGB files encoded once with Pillow; no codec dependency at test time.
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDxuiiitjI//9k=", "base64");
const webp = Buffer.from("UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoCAAIAAUAmJZQCdAFAAAD++3sItRJUvJ+iMAAA", "base64");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const preview = (bytes, mimeType) => ({ kind: "image", size: bytes.length, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` });
const samples = () => [{ mimeType: "image/png", bytes: png() }, { mimeType: "image/jpeg", bytes: jpeg }, { mimeType: "image/webp", bytes: webp }];

test("PNG, JPEG and WebP reference bytes must match their type, byte count and hash", () => {
  for (const sample of samples()) {
    assert.deepEqual(referenceBytes(preview(sample.bytes, sample.mimeType), digest(sample.bytes)), sample);
    assert.throws(() => referenceBytes(preview(sample.bytes, sample.mimeType), "0".repeat(64)), { code: "REFERENCE_CHANGED" });
  }
  const image = png(), correct = preview(image, "image/png");
  for (const invalid of [{ ...correct, kind: "tooLarge" }, { ...correct, size: 4 * 1024 * 1024 + 1 },
    { ...correct, size: image.length + 1 }, { ...correct, dataUrl: correct.dataUrl + "=" },
    preview(image, "image/jpeg"), preview(image, "image/webp"), preview(image, "image/svg+xml"),
    preview(Buffer.from("invalid"), "image/png")]) {
    assert.throws(() => referenceBytes(invalid, digest(image)), { code: "REFERENCE_INVALID" });
  }
});

test("multipart parses as OpenAI fields with exact ordered binary files and UTF-8 prompt", async () => {
  const images = samples(), spec = { modelId: "gpt-image-2.6-flare", prompt: "蓝色杯子 on a white table", size: "1536x1024", quality: "medium" };
  const payload = imageRequestBody(spec, images, "multipart");
  const form = await new Response(Buffer.from(payload.bodyBase64, "base64"), { headers: { "Content-Type": payload.contentType } }).formData();
  assert.equal(form.get("model"), spec.modelId); assert.equal(form.get("prompt"), spec.prompt);
  assert.equal(form.get("n"), "1"); assert.equal(form.get("output_format"), "png");
  assert.equal(form.get("size"), spec.size); assert.equal(form.get("quality"), spec.quality);
  assert.equal(form.has("input_fidelity"), false); assert.equal(form.has("response_format"), false);
  const files = form.getAll("image[]"); assert.equal(files.length, 3);
  for (let i = 0; i < files.length; i++) {
    assert.equal(files[i].type, images[i].mimeType);
    assert.deepEqual(Buffer.from(await files[i].arrayBuffer()), images[i].bytes);
  }
  assert.throws(() => imageRequestBody(spec, [{ mimeType: "image/png", bytes: Buffer.alloc(16 * 1024 * 1024) }], "multipart"), { code: "REFERENCE_INVALID" });
});

test("JSON edits contain exact ordered data URLs and keep normal generation parameters", () => {
  const images = samples(), spec = { modelId: "gpt-image-2.6-flare", prompt: "保留原脸", size: "1024x1024", quality: "high" };
  const payload = imageRequestBody(spec, images, "json-data-url");
  assert.equal(payload.contentType, "application/json"); assert.equal(payload.bodyBase64, undefined);
  const body = JSON.parse(payload.body);
  assert.deepEqual(body.images, images.map(image => ({ image_url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` })));
  assert.equal(body.model, spec.modelId); assert.equal(body.prompt, spec.prompt); assert.equal(body.n, 1);
  assert.equal(body.output_format, "png"); assert.equal(body.size, spec.size); assert.equal(body.quality, spec.quality);
  assert.equal(body.input_fidelity, undefined); assert.equal(body.response_format, undefined);
  const text = JSON.parse(imageRequestBody(spec).body);
  assert.deepEqual(text, { model: spec.modelId, prompt: spec.prompt, n: 1, size: spec.size, quality: spec.quality, output_format: "png" });
  assert.throws(() => imageRequestBody(spec, images, "unknown"), { code: "REFERENCE_UNSUPPORTED" });
  assert.throws(() => imageRequestBody(spec, [{ mimeType: "image/png", bytes: Buffer.alloc(16 * 1024 * 1024) }], "json-data-url"), { code: "REFERENCE_INVALID" });
});
