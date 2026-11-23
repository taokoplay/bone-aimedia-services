"use strict";

const { createHash } = require("node:crypto");

function remoteWorkflowId(profileId, path) {
  return `remote-${createHash("sha256").update(JSON.stringify([profileId, path])).digest("hex").slice(0, 32)}`;
}

function remoteWorkflowName(path) {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return basename.replace(/\.json$/i, "");
}

function remoteWorkflowDisplayName(name, path, ambiguous) {
  return ambiguous ? `${name} · ${path}` : name;
}

module.exports = { remoteWorkflowId, remoteWorkflowName, remoteWorkflowDisplayName };
