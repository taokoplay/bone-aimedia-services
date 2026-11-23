"use strict";

const { randomUUID } = require("node:crypto");
const { assert, fail, object, keys } = require("./media-provider-schema.js");
const { MAX_MULTIPART_BYTES } = require("./image-reference-schema.js");

const UPLOAD_RESPONSE_MAX_BYTES = 128 * 1024;
const MIME_EXTENSIONS = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });

function endpoint(profile, suffix) { return `${profile.baseUrl.replace(/\/+$/, "")}${suffix}`; }
function headers(profile, secret) {
  const result = { Accept: "application/json" };
  if (profile.authKind !== "none") result[profile.authKind === "header" ? profile.headerName : "Authorization"] = profile.authKind === "header" ? secret : `Bearer ${secret}`;
  if (profile.comfyUser) result["Comfy-User"] = profile.comfyUser;
  return result;
}
function safePath(value, allowEmpty = false) {
  assert(typeof value === "string" && value.length <= 512 && (allowEmpty || value.length > 0));
  if (allowEmpty && value === "") return value;
  assert(!value.includes("\0") && !value.includes("\\") && !value.includes("://") && !/[?#<>]/.test(value));
  assert(value.split("/").every(part => part && part !== "." && part !== ".." && part.trim() === part));
  return value;
}
function uploadReference(value) {
  assert(object(value));
  keys(value, ["name", "subfolder", "type"]);
  const name = safePath(value.name);
  const subfolder = safePath(value.subfolder || "", true);
  assert(value.type === "input");
  return { name, subfolder, type: value.type, path: subfolder ? `${subfolder}/${name}` : name };
}
function extension(mimeType) {
  const value = MIME_EXTENSIONS[mimeType];
  assert(value, "REFERENCE_INVALID");
  return value;
}
function multipartBody(image, filename, sha256) {
  assert(Buffer.isBuffer(image.bytes) && image.bytes.length > 0 && image.bytes.length <= MAX_MULTIPART_BYTES, "REFERENCE_INVALID");
  assert(typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256));
  let boundary;
  do { boundary = `bone-comfy-${randomUUID()}`; } while (image.bytes.includes(Buffer.from(boundary)));
  const parts = [];
  const text = value => parts.push(Buffer.from(value, "utf8"));
  const field = (name, value) => text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  field("overwrite", "true");
  field("type", "input");
  field("subfolder", "bone-aimedia");
  text(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`);
  parts.push(image.bytes);
  text("\r\n");
  text(`--${boundary}--\r\n`);
  const bytes = Buffer.concat(parts);
  assert(bytes.length <= MAX_MULTIPART_BYTES, "REQUEST_TOO_LARGE");
  return { bodyBase64: bytes.toString("base64"), contentType: `multipart/form-data; boundary=${boundary}`, sha256 };
}
async function parseUploadResponse(response) {
  assert(Number.isInteger(response?.status) && response.status >= 200 && response.status < 300, response?.status === 401 || response?.status === 403 ? "AUTHENTICATION_REQUIRED" : "HTTP_ERROR");
  assert(typeof response.bodyText === "string" && Buffer.byteLength(response.bodyText, "utf8") <= UPLOAD_RESPONSE_MAX_BYTES, "RESULT_INVALID");
  let body;
  try { body = JSON.parse(response.bodyText); } catch { fail("INVALID_JSON"); }
  return uploadReference(body);
}
async function uploadReferenceImages({ profile, secret, request, checkCurrent, getCapabilities, images }) {
  assert(Array.isArray(images) && images.length > 0 && images.length <= 8, "REFERENCE_INVALID");
  const capabilities = await getCapabilities();
  assert(capabilities?.binaryRequestBody === true && Number.isSafeInteger(capabilities.maxBinaryBodyBytes) && capabilities.maxBinaryBodyBytes >= MAX_MULTIPART_BYTES, "BINARY_REQUEST_UNSUPPORTED");
  assert(Array.isArray(capabilities.fetchRedirectModes) && capabilities.fetchRedirectModes.includes("error"), "BINARY_REQUEST_UNSUPPORTED");
  const uploaded = [];
  for (const image of images) {
    checkCurrent();
    const hash = image.sha256;
    const filename = `bone-aimedia-${hash.slice(0, 24)}.${extension(image.mimeType)}`;
    const body = multipartBody(image, filename, hash);
    const response = await request({
      url: endpoint(profile, "/upload/image"),
      method: "POST",
      headers: { ...headers(profile, secret), "Content-Type": body.contentType },
      bodyBase64: body.bodyBase64,
      maxRequestBodyBytes: MAX_MULTIPART_BYTES,
      timeoutMs: 15000,
      redirect: "error",
    });
    checkCurrent();
    uploaded.push({ ...await parseUploadResponse(response), sourceSha256: hash });
  }
  return uploaded;
}
module.exports = { uploadReferenceImages, multipartBody, uploadReference, MAX_MULTIPART_BYTES };
