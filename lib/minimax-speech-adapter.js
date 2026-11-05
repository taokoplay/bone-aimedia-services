"use strict";
const { assert } = require("./media-provider-schema.js");
const { safeCodes } = require("./media-provider-request.js");
const { audioRequest } = require("./audio-generation-schema.js");
const { validateMp3, MAX_AUDIO_BYTES } = require("./audio-mp3.js");
const AUDIO_REQUEST_TIMEOUT_MS = 90000;
const MAX_RESPONSE_BYTES = MAX_AUDIO_BYTES * 2 + 256 * 1024;
function failure(code, state, httpStatus) { return { state, error: { code, ...(httpStatus ? { httpStatus } : {}) }, charging: "unknown" }; }
async function generateMinimaxSpeech({ profile, secret, input, request, checkCurrent }) {
  input = audioRequest(input);
  assert(profile.provider === "minimax", "GENERATION_UNSUPPORTED");
  assert(typeof secret === "string" && secret.length > 0, "CREDENTIAL_REQUIRED");
  const url = `${profile.baseUrl.replace(/\/+$/, "")}/t2a_v2`;
  assert(new URL(url).origin === new URL(profile.baseUrl).origin, "INVALID_ARGUMENT");
  checkCurrent();
  let response;
  try {
    response = await request({ url, method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: input.modelId, text: input.text, stream: false, output_format: "hex",
        voice_setting: { voice_id: input.voiceId, speed: input.speed, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 } }),
      timeoutMs: AUDIO_REQUEST_TIMEOUT_MS, redirect: "error" });
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
  if (typeof response.bodyText !== "string") return failure("GENERATION_UNKNOWN", "unknown");
  if (Buffer.byteLength(response.bodyText) > MAX_RESPONSE_BYTES) return failure("RESPONSE_TOO_LARGE", "result-pending");
  let body;
  try { body = JSON.parse(response.bodyText); } catch { return failure("GENERATION_UNKNOWN", "unknown"); }
  const vendorCode = body?.base_resp?.status_code;
  if (vendorCode !== 0) {
    if (vendorCode === 1004) return failure("AUTHENTICATION_REQUIRED", "failed");
    if ([1002, 1039].includes(vendorCode)) return failure("RATE_LIMITED", "failed");
    if ([1042, 2013].includes(vendorCode)) return failure("INVALID_ARGUMENT", "failed");
    return failure("GENERATION_UNKNOWN", "unknown");
  }
  if (body?.data?.status !== 2) return failure("GENERATION_UNKNOWN", "unknown");
  // No URLs, raw vendor errors or extra_info cross this boundary. Hex is a
  // canonical lowercase byte encoding; dimensions and duration come from bytes.
  const value = body.data.audio;
  if (typeof value !== "string" && typeof body.data.audio_url === "string") return failure("RESULT_UNAVAILABLE", "result-pending");
  try {
    assert(typeof value === "string" && value.length > 0 && value.length <= MAX_AUDIO_BYTES * 2 && value.length % 2 === 0 && /^[0-9a-f]+$/.test(value), "RESULT_INVALID");
    const bytes = Buffer.from(value, "hex");
    assert(bytes.toString("hex") === value && !bytes.includes(Buffer.from(secret)), "RESULT_INVALID");
    return { state: "succeeded", bytes, descriptor: validateMp3(bytes), charging: "unknown" };
  } catch { return failure("RESULT_INVALID", "result-pending"); }
}
module.exports = { generateMinimaxSpeech, AUDIO_REQUEST_TIMEOUT_MS };
