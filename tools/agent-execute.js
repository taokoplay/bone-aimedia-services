"use strict";
const { toolReply } = require("../lib/agent-image-result.js");
const { MediaExportError } = require("../lib/media-result-export.js");
const SAFE_ERRORS = new Set(["INVALID_ARGUMENT", "CONFLICT", "NOT_FOUND", "DISABLED", "DISPOSED", "PERMISSION_DENIED", "AGENT_CONTEXT_REQUIRED", "CONTEXT_REQUIRED", "TOOL_ABORTED", "ABORTED", "GENERATION_REQUEST_CONFLICT", "GENERATION_BUSY", "GENERATION_LIMIT", "GENERATION_UNSUPPORTED", "CREDENTIAL_REQUIRED", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_ERROR", "CREDENTIAL_LEGACY", "RESULT_UNAVAILABLE", "RESULT_INVALID", "STORAGE_ERROR", "EXPORT_UNAVAILABLE", "EXPORT_FAILED", "EXPORT_CONFLICT", "WORKSPACE_CHANGED", "WORKSPACE_REQUIRED", "NO_WORKSPACE", "PROBE_PENDING"]);
function agentExecute(access) {
  return method => async (input, ctx) => {
    try { return await access(method, input, ctx); }
    catch (error) {
      const code = SAFE_ERRORS.has(error?.code) ? error.code : "UNAVAILABLE";
      const recovery = error instanceof MediaExportError && error.recovery ? structuredClone(error.recovery) : undefined;
      return { ...toolReply({ ok: false, error: { code }, ...(recovery ? { recovery } : {}), nextAction: "Inspect the same request/job; do not blindly create another billable request." }), isError: true };
    }
  };
}
const schema = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
module.exports = { agentExecute, schema };
