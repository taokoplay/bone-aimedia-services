"use strict";
const { buildMediaExportDecoder } = require("./media-export-decoder.js");
function buildImageExportDecoder(expected) {
  return buildMediaExportDecoder({ ...expected, kind: "image" });
}
module.exports = { buildImageExportDecoder };
