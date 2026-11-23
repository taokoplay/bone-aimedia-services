"use strict";
const { createHash } = require("node:crypto");
const { assert, keys, identifier } = require("./media-provider-schema.js");
const { createComfyJobStorage } = require("./comfy-job-storage.js");
const { requestJson } = require("./media-provider-request.js");
const { selectOutputs, resultDescriptor } = require("./comfy-output-validators.js");
const { uploadReferenceImages } = require("./comfy-input-upload.js");
const { isImageBindingPurpose } = require("./comfy-workflow-matching.js");
const schema = require("./comfy-generation-schema.js");
const { referenceSpecs } = require("./image-reference-schema.js");
const WAIT_STEP_MS = 250;
const DEFAULT_WAIT_MS = 15000;
const UNCERTAIN_CODES = new Set(["TIMEOUT", "NETWORK_ERROR", "PLUGIN_TOOL_ABORTED", "TOOL_ABORTED"]);
const KNOWN_FAILURE_CODES = new Set(["INVALID_ARGUMENT", "CONFLICT", "DISABLED", "NOT_FOUND", "PERMISSION_DENIED", "CREDENTIAL_REQUIRED", "RESULT_INVALID", "RESULT_UNAVAILABLE", "REQUEST_TOO_LARGE", "BINARY_REQUEST_UNSUPPORTED", "WORKFLOW_INPUT_REQUIRED", "WORKFLOW_INVALID", "WORKFLOW_NOT_FOUND", "AUTHENTICATION_REQUIRED", "ENDPOINT_NOT_FOUND", "HTTP_ERROR", "INVALID_JSON"]);
function now() { return new Date().toISOString(); }
function requestHash(request) { return createHash("sha256").update(JSON.stringify(request)).digest("hex"); }
function cloneDefinition(definition) { return structuredClone(definition); }
function endpoint(profile, suffix) { return `${profile.baseUrl.replace(/\/+$/, "")}${suffix}`; }
function headers(profile, secret) {
  const result = { Accept: "application/json" };
  if (profile.authKind !== "none") result[profile.authKind === "header" ? profile.headerName : "Authorization"] = profile.authKind === "header" ? secret : `Bearer ${secret}`;
  if (profile.comfyUser) result["Comfy-User"] = profile.comfyUser;
  return result;
}
function assertNoCredentialInputs(inputs, secret) {
  if (typeof secret !== "string" || secret.length === 0) return;
  for (const value of Object.values(inputs || {})) {
    if (typeof value === "string") assert(!value.includes(secret), "INVALID_ARGUMENT", "Credentials cannot appear in workflow inputs.");
  }
}
function applyBindings(definition, bindings, values, uploadedByPurpose) {
  const result = cloneDefinition(definition);
  const source = values || {};
  for (const binding of bindings) {
    const node = result[binding.nodeId];
    assert(node && Object.hasOwn(node.inputs, binding.input), "WORKFLOW_INVALID");
    const value = isImageBindingPurpose(binding.purpose) ? uploadedByPurpose?.[binding.purpose]?.path : source[binding.purpose];
    if (value === undefined) continue;
    node.inputs[binding.input] = value;
  }
  return result;
}
function referenceIndex(purpose) {
  if (purpose === "lastFrame") return 1;
  const match = /^referenceImage([1-8])$/.exec(purpose);
  if (match) return Number(match[1]) - 1;
  return 0;
}
function requiredReferenceIndices(bindings, count) {
  const indices = new Set();
  for (const binding of bindings) {
    if (!isImageBindingPurpose(binding.purpose)) continue;
    const index = referenceIndex(binding.purpose);
    assert(index < count, "WORKFLOW_INPUT_REQUIRED", `Workflow input ${binding.purpose} requires a reference image.`);
    indices.add(index);
  }
  assert(count === 0 || indices.size > 0, "WORKFLOW_INPUT_REQUIRED", "Reference images were supplied but this workflow has no image input binding.");
  return [...indices].sort((left, right) => left - right);
}
function uploadedByPurpose(bindings, uploaded) {
  const result = {};
  for (const binding of bindings) {
    if (isImageBindingPurpose(binding.purpose)) result[binding.purpose] = uploaded[referenceIndex(binding.purpose)];
  }
  return result;
}
function failurePatch(error) {
  const code = KNOWN_FAILURE_CODES.has(error?.code) ? error.code : "HTTP_ERROR";
  const uncertain = UNCERTAIN_CODES.has(error?.code);
  return { state: uncertain ? "unknown" : "failed", error: { code }, charging: uncertain ? "unknown" : "not-submitted" };
}
function createComfyWorkflowGeneration({ getDataPath, settings, request, getCapabilities, captureProject, references }) {
  const store = createComfyJobStorage(getDataPath);
  let disposed = false;
  async function binaryCapabilities() {
    assert(typeof getCapabilities === "function", "BINARY_RESPONSE_UNSUPPORTED");
    const capabilities = await getCapabilities();
    assert(capabilities?.binaryResponseBody === true && Number.isSafeInteger(capabilities.maxResponseBodyBytes) && capabilities.maxResponseBodyBytes >= 16 * 1024 * 1024, "BINARY_RESPONSE_UNSUPPORTED");
  }
  async function getWorkflow(input) {
    const snapshot = await settings.read();
    const workflow = snapshot.workflows.find(item => item.id === input.workflowId);
    assert(workflow, "WORKFLOW_NOT_FOUND"); assert(workflow.enabled && workflow.executable !== false, "WORKFLOW_INVALID"); assert(workflow.kind === input.kind, "INVALID_ARGUMENT");
    assert(workflow.connectionId, "WORKFLOW_INVALID");
    const profile = snapshot.profiles.find(item => item.id === workflow.connectionId);
    assert(profile?.provider === "comfyui" && profile.enabled, "DISABLED");
    return { snapshot, workflow, profile };
  }
  async function update(job, patch) { const next = { ...job, ...patch, revision: 3, updatedAt: now() }; await store.write(job.id, next); return next; }
  async function history(profile, secret, promptId, checkCurrent) {
    const body = await requestJson(profile, secret, request, checkCurrent, `/history/${encodeURIComponent(promptId)}`, undefined, false);
    const record = body?.[promptId] || body;
    assert(record && typeof record === "object", "RESULT_UNAVAILABLE");
    return record;
  }
  async function download(profile, secret, file, checkCurrent) {
    await binaryCapabilities(); checkCurrent();
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const response = await request({ url: endpoint(profile, `/view?${query}`), method: "GET", headers: { ...headers(profile, secret), Accept: "application/octet-stream" }, responseType: "base64", maxResponseBytes: 16 * 1024 * 1024, timeoutMs: 15000, redirect: "error" });
    assert(response?.status >= 200 && response.status < 300, response?.status === 404 ? "RESULT_UNAVAILABLE" : "HTTP_ERROR");
    assert(typeof response.bodyBase64 === "string" && response.byteLength !== undefined, "RESULT_INVALID");
    return { bytes: Buffer.from(response.bodyBase64, "base64"), contentType: response.contentType || "" };
  }
  async function run(job, profile, secret, workflow, checkCurrent, waitMs) {
    const promptId = job.remotePromptId;
    assert(promptId, "RESULT_UNAVAILABLE");
    const start = Date.now();
    for (;;) {
      checkCurrent();
      const record = await history(profile, secret, promptId, checkCurrent);
      const status = record.status?.status_str;
      if (status === "error") return update(job, { state: "failed", error: { code: "HTTP_ERROR" }, charging: "unknown" });
      if (record.outputs && status === "success" || record.outputs && record.status?.completed === true) {
        const selected = selectOutputs(record.outputs || record, job.request.outputRules);
        const first = selected[0];
        const downloaded = await download(profile, secret, first.file, checkCurrent);
        const descriptor = resultDescriptor(job.request.kind, downloaded.bytes, downloaded.contentType, first.file);
        await store.writeResult(job.id, downloaded.bytes);
        return update(job, { state: "succeeded", charging: "unknown", result: { resultId: job.id, kind: job.request.kind, ...descriptor } });
      }
      if (Date.now() - start >= waitMs) return update(job, { state: "unknown", error: { code: "TIMEOUT" }, charging: "unknown" });
      await new Promise(resolve => setTimeout(resolve, WAIT_STEP_MS));
    }
  }
  async function uploadInputs(input, profile, secret, checkCurrent, workflow) {
    const referenceImages = input.referenceImages === undefined ? [] : referenceSpecs(input.referenceImages);
    const indices = requiredReferenceIndices(workflow.bindings, referenceImages.length);
    if (!indices.length) return {};
    assert(references && typeof references.load === "function", "BINARY_REQUEST_UNSUPPORTED");
    const loaded = await references.load(indices.map(index => referenceImages[index]), { checkCurrent });
    const uploaded = await uploadReferenceImages({ profile, secret, request, checkCurrent, getCapabilities, images: loaded.images });
    const ordered = [];
    for (const index of indices) ordered[index] = uploaded[indices.indexOf(index)];
    return uploadedByPurpose(workflow.bindings, ordered);
  }
  async function generate(input, context = {}) {
    assert(!disposed, "DISPOSED"); keys(input, ["workflowId", "requestKey", "kind", "inputs", "referenceImages", "waitMs"]);
    identifier(input.workflowId); assert(typeof input.requestKey === "string"); assert(["image", "video", "audio"].includes(input.kind));
    const { snapshot, workflow, profile } = await getWorkflow(input);
    const expectedRevision = snapshot.revision;
    const jobRequestInput = { workflowId: workflow.id, profileId: profile.id, expectedRevision, workflowHash: createHash("sha256").update(JSON.stringify(workflow.definition)).digest("hex"), workflowName: workflow.name, kind: workflow.kind, requestKey: input.requestKey, inputs: input.inputs, outputRules: workflow.outputs };
    if (input.referenceImages !== undefined) jobRequestInput.referenceImages = input.referenceImages;
    const jobRequest = schema.request(jobRequestInput);
    const id = schema.stableId(workflow.id, input.requestKey); const digest = requestHash(jobRequest);
    let existing;
    try { existing = await store.read(id); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
    if (existing) {
      assert(existing.requestHash === digest, "GENERATION_REQUEST_CONFLICT");
      if (!existing.remotePromptId) return schema.publicJob(existing);
      if (["succeeded", "failed"].includes(existing.state)) return schema.publicJob(existing);
    }
    const capturedProject = captureProject ? await captureProject(context).catch(() => undefined) : undefined;
    const base = existing || { version: 1, id, revision: 2, state: "submitting", requestHash: digest, request: jobRequest, profileName: profile.name, createdAt: now(), updatedAt: now(), charging: "unknown", ...(capturedProject ? { project: capturedProject } : {}) };
    if (!existing) await store.create(base);
    try {
      return await settings.withComfyProfile({ profileId: profile.id, expectedRevision }, async ({ profile: selectedProfile, secret, checkCurrent }) => {
        assertNoCredentialInputs(input.inputs, secret);
        if (!existing) {
          const uploaded = await uploadInputs(input, selectedProfile, secret, checkCurrent, workflow);
          const prompt = applyBindings(workflow.definition, workflow.bindings, input.inputs, uploaded);
          const response = await requestJson(selectedProfile, secret, request, checkCurrent, "/prompt", { prompt, client_id: "bone-aimedia-services" }, false);
          const promptId = response?.prompt_id;
          assert(typeof promptId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(promptId), "RESULT_INVALID");
          existing = await update(base, { remotePromptId: promptId });
        }
        return schema.publicJob(await run(existing, selectedProfile, secret, workflow, checkCurrent, Number.isSafeInteger(input.waitMs) ? input.waitMs : DEFAULT_WAIT_MS));
      });
    } catch (error) {
      if (!base.remotePromptId && !base.result) await update(base, failurePatch(error));
      throw error;
    }
  }
  async function get(input) { keys(input, ["jobId"]); return schema.publicJob(await store.read(input.jobId)); }
  async function list() { const jobs = await store.list(); jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); return { jobs: jobs.map(job => schema.publicJob(job, true)), limit: null }; }
  async function deleteMany(input) {
    keys(input, ["jobIds", "confirm"]);
    assert(input.confirm === true, "INVALID_ARGUMENT", "Confirm local record deletion.");
    assert(Array.isArray(input.jobIds) && input.jobIds.length > 0);
    const ids = [...new Set(input.jobIds)], jobs = await Promise.all(ids.map(id => store.read(id)));
    for (const job of jobs) assert(["succeeded", "failed"].includes(job.state), "GENERATION_UNRESOLVED", "Review the task before deleting its record.");
    await store.removeMany(ids);
    return { deleted: ids, count: ids.length };
  }
  async function readResult(input) { keys(input, ["jobId", "expectedSha256"]); const job = await store.read(input.jobId); assert(job.state === "succeeded" && job.result?.sha256 === input.expectedSha256, "RESULT_UNAVAILABLE"); return { job: schema.publicJob(job), bytes: await store.readResult(input.jobId) }; }
  async function cancel(input) { keys(input, ["jobId"]); const job = await store.read(input.jobId); assert(job.remotePromptId && job.state === "submitting", "INVALID_ARGUMENT"); return settings.withComfyProfile({ profileId: job.request.profileId, expectedRevision: job.request.expectedRevision }, async ({ profile, secret, checkCurrent }) => { const body = await requestJson(profile, secret, request, checkCurrent, "/queue", { delete: [job.remotePromptId] }, false); assert(body && typeof body === "object", "RESULT_INVALID"); return schema.publicJob(await update(job, { state: "failed", error: { code: "WORKFLOW_CANCELED" }, charging: "unknown" })); }); }
  async function reconcile(input) {
    keys(input, ["jobId"]); const job = await store.read(input.jobId); assert(job.remotePromptId, "RESULT_UNAVAILABLE");
    const snapshot = await settings.read(); const workflow = snapshot.workflows.find(item => item.id === job.request.workflowId); const profile = snapshot.profiles.find(item => item.id === job.request.profileId);
    assert(workflow && profile, "WORKFLOW_NOT_FOUND");
    return settings.withComfyProfile({ profileId: profile.id, expectedRevision: snapshot.revision }, async ({ profile: selectedProfile, secret, checkCurrent }) => schema.publicJob(await run(job, selectedProfile, secret, workflow, checkCurrent, 0)));
  }
  async function dispose() { disposed = true; }
  return { generate, get, list, deleteMany, readResult, cancel, reconcile, dispose };
}
module.exports = { createComfyWorkflowGeneration };
