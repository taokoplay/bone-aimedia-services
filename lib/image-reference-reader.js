"use strict";
const { createHash } = require("node:crypto");
const path = require("node:path");
const { assert } = require("./media-provider-schema.js");
const { referenceSpecs, referenceBytes, MAX_REFERENCE_TOTAL_BYTES, MAX_MULTIPART_BYTES, MAX_JSON_REFERENCE_BODY_BYTES } = require("./image-reference-schema.js");
const hashWorkspace = workspace => createHash("sha256").update(workspace).digest("hex");
async function createImageReferenceReader({ host }) {
  const blockedBy = [], multipartBlockedBy = [];
  let capabilities;
  if (typeof host.net?.getCapabilities === "function") {
    try { capabilities = await host.net.getCapabilities(); }
    catch { multipartBlockedBy.push("host-capability-query-failed"); }
  }
  const binary = capabilities?.binaryRequestBody === true;
  const hostMaxBinaryBodyBytes = Number.isSafeInteger(capabilities?.maxBinaryBodyBytes) && capabilities.maxBinaryBodyBytes > 0
    ? capabilities.maxBinaryBodyBytes : null;
  if (!binary) multipartBlockedBy.push("host-binary-image-input-required");
  else if (hostMaxBinaryBodyBytes === null) multipartBlockedBy.push("host-binary-body-limit-invalid");
  else if (hostMaxBinaryBodyBytes < MAX_MULTIPART_BYTES) multipartBlockedBy.push("host-binary-body-limit-too-small");
  if (!Array.isArray(capabilities?.fetchRedirectModes) || !capabilities.fetchRedirectModes.includes("error")) {
    blockedBy.push("host-redirect-error-required");
  }
  if (typeof host.net?.fetch !== "function") blockedBy.push("host-http-api-required");
  if (typeof host.workspace?.get !== "function") blockedBy.push("host-workspace-api-required");
  if (typeof host.fs?.readPreview !== "function") blockedBy.push("host-image-preview-api-required");
  const transport = multipartBlockedBy.length === 0 ? "multipart" : "json-data-url";
  const support = Object.freeze({ supported: blockedBy.length === 0, blockedBy: Object.freeze(blockedBy), transport,
    multipartBlockedBy: Object.freeze(multipartBlockedBy),
    requiredBinaryBodyBytes: transport === "multipart" ? MAX_MULTIPART_BYTES : 0, hostMaxBinaryBodyBytes,
    maxRequestBodyBytes: transport === "multipart" ? MAX_MULTIPART_BYTES : MAX_JSON_REFERENCE_BODY_BYTES });
  async function load(specs, { workspaceHash, checkCurrent = () => {} } = {}) {
    assert(support.supported, "REFERENCE_UNSUPPORTED", "Check referenceImages.blockedBy in media_catalog for the required Host capability.");
    specs = referenceSpecs(specs); checkCurrent();
    const workspace = await host.workspace.get(); checkCurrent();
    assert(typeof workspace?.path === "string" && path.isAbsolute(workspace.path), "REFERENCE_UNSUPPORTED");
    const capturedHash = hashWorkspace(workspace.path);
    assert(workspaceHash === undefined || workspaceHash === capturedHash, "CONFLICT", "The reference workspace changed.");
    async function current() {
      checkCurrent(); const latest = await host.workspace.get(); checkCurrent();
      assert(latest?.path === workspace.path, "CONFLICT", "The reference workspace changed.");
    }
    const images = []; let total = 0;
    for (const spec of specs) {
      // The Host pins each read; the previous read already checked this workspace.
      checkCurrent();
      let preview;
      try { preview = await host.fs.readPreview(spec.path, { workspacePath: workspace.path }); }
      catch (error) {
        if (error?.code === "WORKSPACE_CHANGED") assert(false, "CONFLICT", "The reference workspace changed.");
        throw error;
      }
      checkCurrent();
      await current();
      const image = referenceBytes(preview, spec.sha256);
      total += image.bytes.length; assert(total <= MAX_REFERENCE_TOTAL_BYTES, "REFERENCE_INVALID");
      images.push(image);
    }
    await current();
    return { images, workspaceHash: capturedHash };
  }
  return { support, load };
}
module.exports = { createImageReferenceReader };
