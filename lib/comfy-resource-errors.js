"use strict";
const { requestErrorDetails } = require("./media-provider-request.js");
const resourceCodes = new Set(["WORKFLOW_INVALID", "WORKFLOW_TOO_LARGE", "WORKFLOW_NOT_FOUND", "RESOURCE_LIST_STALE", "RESOURCE_UNSUPPORTED"]);
function resourceErrorDetails(error, resource) {
  if (resourceCodes.has(error?.code)) return { code: error.code };
  const details = requestErrorDetails(error);
  if (resource === "workflow" && details.code === "ENDPOINT_NOT_FOUND" && details.httpStatus === 404) details.code = "WORKFLOW_NOT_FOUND";
  return details;
}
module.exports = { resourceErrorDetails };
