"use strict";
const { createMediaResultExporter, MediaExportError } = require("./media-result-export.js");
function createImageResultExporter({ host, readResult }) {
  return createMediaResultExporter({ host, readResult, kind: "image" });
}
module.exports = { createImageResultExporter, ImageExportError: MediaExportError };
