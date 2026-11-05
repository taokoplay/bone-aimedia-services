"use strict";
const { createMediaResultExporter } = require("./media-result-export.js");
function createAudioResultExporter({ host, readResult }) {
  return createMediaResultExporter({ host, readResult, kind: "audio" });
}
module.exports = { createAudioResultExporter };
