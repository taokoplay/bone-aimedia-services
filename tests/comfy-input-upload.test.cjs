"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { png } = require("./image-fixture.cjs");
const { multipartBody, uploadReference } = require("../lib/comfy-input-upload.js");

test("ComfyUI upload multipart contains a bounded image part and safe response reference", () => {
  const bytes = png(2, 2);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const payload = multipartBody({ mimeType: "image/png", bytes }, "bone-aimedia-test.png", sha256);
  const body = Buffer.from(payload.bodyBase64, "base64");
  assert.match(payload.contentType, /^multipart\/form-data; boundary=bone-comfy-/);
  assert.ok(body.includes(Buffer.from('name="image"')));
  assert.ok(body.includes(Buffer.from("bone-aimedia-test.png")));
  assert.ok(body.includes(bytes));
  assert.deepEqual(uploadReference({ name: "bone-aimedia-test.png", subfolder: "bone-aimedia", type: "input" }), {
    name: "bone-aimedia-test.png", subfolder: "bone-aimedia", type: "input", path: "bone-aimedia/bone-aimedia-test.png",
  });
  assert.throws(() => uploadReference({ name: "../outside.png", subfolder: "", type: "input" }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => uploadReference({ name: "x.png", subfolder: "", type: "output" }), { code: "INVALID_ARGUMENT" });
});
