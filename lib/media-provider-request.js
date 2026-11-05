"use strict";

const { assert, fail } = require("./media-provider-schema.js");
const MAX_RESPONSE = 2 * 1024 * 1024;
const safeCodes = new Set(["PERMISSION_DENIED", "HOST_PERMISSION_DENIED", "NETWORK_PERMISSION_DENIED", "NET_PERMISSION_DENIED", "CAPABILITY_DENIED", "FORBIDDEN", "APPROVAL_REQUIRED"]);
const diagnosticCodes = new Set([...safeCodes, "TIMEOUT", "REDIRECT_DISALLOWED", "NETWORK_ERROR", "AUTHENTICATION_REQUIRED", "ENDPOINT_NOT_FOUND", "HTTP_ERROR", "INVALID_RESPONSE", "INVALID_JSON", "RESPONSE_TOO_LARGE", "CREDENTIAL_REQUIRED"]);
function requestFailure(code, httpStatus) {
  return Object.assign(new Error("Provider request failed."), { code, ...(httpStatus === undefined ? {} : { httpStatus }) });
}
function requestErrorDetails(error) {
  return { code: diagnosticCodes.has(error?.code) ? error.code : "INVALID_RESPONSE",
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}) };
}

// Only internal adapters supply suffixes. Credentials and redirect policy are
// shared by discovery and browsing; no caller may provide a URL or headers.
async function requestJson(profile, secret, request, checkCurrent, suffix, body, unsupported = false) {
  checkCurrent();
  const url = `${profile.baseUrl}${suffix}`;
  assert(new URL(url).origin === new URL(profile.baseUrl).origin, "INVALID_ARGUMENT");
  const headers = { Accept: "application/json" };
  const authKind = profile.provider === "comfyui" ? profile.authKind : "bearer";
  if (profile.provider === "comfyui" && ["bearer", "header"].includes(authKind) && !secret) throw requestFailure("CREDENTIAL_REQUIRED");
  if (secret && authKind !== "none") {
    if (authKind === "header") headers[profile.headerName] = secret;
    else headers.Authorization = `Bearer ${secret}`;
  }
  if (profile.provider === "comfyui" && profile.comfyUser) headers["Comfy-User"] = profile.comfyUser;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await request({ url, method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs: 15000, redirect: "error" });
  } catch (error) {
    checkCurrent();
    const code = safeCodes.has(error?.code) || ["TIMEOUT", "REDIRECT_DISALLOWED"].includes(error?.code) ? error.code : "NETWORK_ERROR";
    throw requestFailure(code);
  }
  checkCurrent();
  const status = response?.status;
  assert(Number.isInteger(status) && status >= 100 && status <= 599, "INVALID_RESPONSE");
  if (unsupported && [404, 405, 501].includes(status)) fail("RESOURCE_UNSUPPORTED", "This ComfyUI endpoint is not available.");
  if (status === 401 || status === 403) throw requestFailure("AUTHENTICATION_REQUIRED", status);
  if (status === 404 || status === 405) throw requestFailure("ENDPOINT_NOT_FOUND", status);
  if (status >= 300 && status < 400) throw requestFailure("REDIRECT_DISALLOWED", status);
  if (status < 200 || status >= 300) throw requestFailure("HTTP_ERROR", status);
  assert(typeof response.bodyText === "string", "INVALID_RESPONSE");
  if (Buffer.byteLength(response.bodyText, "utf8") > MAX_RESPONSE) throw requestFailure("RESPONSE_TOO_LARGE");
  try { return JSON.parse(response.bodyText); } catch { throw requestFailure("INVALID_JSON"); }
}
module.exports = { requestJson, safeCodes, requestErrorDetails };
