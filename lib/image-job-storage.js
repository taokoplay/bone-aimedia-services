"use strict";
const { createMediaJobStorage } = require("./media-job-storage.js");
const { MAX_IMAGE_BYTES } = require("./image-png.js");
const ID = /^img-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function createImageJobStorage(getDataPath, parseJob) {
  return createMediaJobStorage(getDataPath, parseJob, { kind: "image", idPattern: ID, resultExtension: "png", maxResultBytes: MAX_IMAGE_BYTES });
}
module.exports = { createImageJobStorage };
