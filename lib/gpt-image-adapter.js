"use strict";
const { assert } = require("./media-provider-schema.js");
const { validatePng, MAX_IMAGE_BYTES } = require("./image-png.js");
const { safeCodes } = require("./media-provider-request.js");
const MAX_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 256 * 1024;
// Leave time for parsing and persistence within the installed host's 110s tool
// deadline. The Agent invocation must stay alive for this entire HTTP exchange.
const IMAGE_REQUEST_TIMEOUT_MS = 90000;
function failure(code, state, httpStatus) { return { state, error: { code, ...(httpStatus ? { httpStatus } : {}) }, charging: "unknown" }; }
async function generateGptImage({ profile, secret, input, request, checkCurrent }) {
  const url = `${profile.baseUrl.replace(/\/+$/, "")}/images/generations`;
  assert(new URL(url).origin === new URL(profile.baseUrl).origin, "INVALID_ARGUMENT");
  checkCurrent();
  let response;
  try {
    response = await request({ url, method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: input.modelId, prompt: input.prompt, n: 1, size: input.size, quality: input.quality, output_format: "png" }),
      timeoutMs: IMAGE_REQUEST_TIMEOUT_MS, redirect: "error" });
  } catch (error) {
    if (safeCodes.has(error?.code)) return { state: "failed", error: { code: "PERMISSION_DENIED" }, charging: "not-submitted" };
    if (["PLUGIN_TOOL_ABORTED", "TOOL_ABORTED"].includes(error?.code)) return failure("TOOL_ABORTED", "unknown");
    return failure(error?.code === "TIMEOUT" ? "TIMEOUT" : error?.code === "REDIRECT_DISALLOWED" ? "REDIRECT_DISALLOWED" : "NETWORK_ERROR", "unknown");
  }
  const status = response?.status;
  if (!Number.isInteger(status) || status < 100 || status > 599) return failure("GENERATION_UNKNOWN", "unknown");
  if (status < 200 || status >= 300) {
    const code = status === 401 || status === 403 ? "AUTHENTICATION_REQUIRED" : status === 404 || status === 405 ? "ENDPOINT_NOT_FOUND" : status >= 300 && status < 400 ? "REDIRECT_DISALLOWED" : "HTTP_ERROR";
    return failure(code, status >= 500 || status === 408 || status >= 300 && status < 400 ? "unknown" : "failed", status);
  }
  if (typeof response.bodyText !== "string") return failure("RESULT_INVALID", "result-pending");
  if (Buffer.byteLength(response.bodyText) > MAX_RESPONSE_BYTES) return failure("RESPONSE_TOO_LARGE", "result-pending");
  try {
    const body = JSON.parse(response.bodyText);
    // No error bodies, URLs, usage guesses or provider metadata cross the boundary.
    assert(Array.isArray(body?.data) && body.data.length === 1, "RESULT_INVALID");
    const value = body.data[0]?.b64_json;
    if (typeof value !== "string" && typeof body.data[0]?.url === "string") return failure("RESULT_UNAVAILABLE", "result-pending");
    assert(typeof value === "string" && value.length > 0 && value.length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), "RESULT_INVALID");
    const bytes = Buffer.from(value, "base64");
    assert(bytes.toString("base64") === value && !bytes.includes(Buffer.from(secret)), "RESULT_INVALID");
    return { state: "succeeded", bytes, descriptor: validatePng(bytes), charging: "unknown" };
  } catch { return failure("RESULT_INVALID", "result-pending"); }
}
module.exports = { generateGptImage, IMAGE_REQUEST_TIMEOUT_MS };
