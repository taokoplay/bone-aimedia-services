"use strict";
const { createHash, randomUUID } = require("node:crypto");
const { assert, keys, identifier } = require("./media-provider-schema.js");
const { createComfyJobStorage } = require("./comfy-job-storage.js");
const { convertCanvasWorkflow } = require("./comfy-canvas-converter.js");
const { requestJson } = require("./media-provider-request.js");
const { selectOutputs, resultDescriptor, FIELD_BY_KIND } = require("./comfy-output-validators.js");
const { uploadReferenceImages } = require("./comfy-input-upload.js");
const { isImageBindingPurpose, matchWorkflow } = require("./comfy-workflow-matching.js");
const { remoteWorkflowId, remoteWorkflowName } = require("./comfy-remote-workflows.js");
const schema = require("./comfy-generation-schema.js");
const { referenceSpecs } = require("./image-reference-schema.js");
const WAIT_STEP_MS = 250;
const DEFAULT_WAIT_MS = 15000;
const UNCERTAIN_CODES = new Set(["TIMEOUT", "NETWORK_ERROR", "PLUGIN_TOOL_ABORTED", "TOOL_ABORTED"]);
const KNOWN_FAILURE_CODES = new Set(["INVALID_ARGUMENT", "CONFLICT", "DISABLED", "NOT_FOUND", "PERMISSION_DENIED", "CREDENTIAL_REQUIRED", "RESULT_INVALID", "RESULT_UNAVAILABLE", "REQUEST_TOO_LARGE", "BINARY_REQUEST_UNSUPPORTED", "WORKFLOW_INPUT_REQUIRED", "WORKFLOW_INVALID", "WORKFLOW_NOT_FOUND", "WORKFLOW_NAME_AMBIGUOUS", "AUTHENTICATION_REQUIRED", "ENDPOINT_NOT_FOUND", "HTTP_ERROR", "INVALID_JSON"]);
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
function preflightRequest(input, snapshot, profile, path, catalogItem) {
  const catalog = catalogItem ? { path: catalogItem.path, size: catalogItem.size, modified: catalogItem.modified, created: catalogItem.created } : null;
  const fingerprint = createHash("sha256").update(JSON.stringify(["remote-preflight", profile.id, path, catalog])).digest("hex");
  const workflowId = remoteWorkflowId(profile.id, path);
  const request = schema.request({
    workflowId, profileId: profile.id, expectedRevision: snapshot.revision, workflowHash: fingerprint,
    workflowName: remoteWorkflowName(path), kind: input.kind, requestKey: input.requestKey, inputs: input.inputs,
    referenceImages: input.referenceImages,
    outputRules: [{ kind: input.kind, nodeId: "__preflight__", field: FIELD_BY_KIND[input.kind], index: 0 }],
    source: "remote", remotePath: path, remoteContentSha256: fingerprint,
  });
  return { id: schema.stableId(workflowId, input.requestKey), request, requestHash: requestHash(request), profile, snapshot };
}
function preflightFailure(error) {
  const patch = failurePatch(error);
  const httpStatus = Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {};
  return { ...patch, error: { ...patch.error, ...httpStatus } };
}
function createComfyWorkflowGeneration({ getDataPath, settings, request, getCapabilities, captureProject, references }) {
  const store = createComfyJobStorage(getDataPath);
  let disposed = false;
  async function binaryCapabilities() {
    assert(typeof getCapabilities === "function", "BINARY_RESPONSE_UNSUPPORTED");
    const capabilities = await getCapabilities();
    assert(capabilities?.binaryResponseBody === true && Number.isSafeInteger(capabilities.maxResponseBodyBytes) && capabilities.maxResponseBodyBytes >= 16 * 1024 * 1024, "BINARY_RESPONSE_UNSUPPORTED");
  }
  async function resolveRemotePath(input, snapshot) {
    if (input.remotePath !== undefined) return schema.remotePath(input.remotePath);
    const listing = await settings.listRemoteWorkflows({ profileId: input.profileId, expectedRevision: snapshot.revision });
    const workflows = listing.workflows || [];
    if (input.remoteWorkflowId !== undefined) {
      schema.remoteWorkflowId(input.remoteWorkflowId);
      const match = workflows.find(item => item.id === input.remoteWorkflowId);
      assert(match, "WORKFLOW_NOT_FOUND");
      return schema.remotePath(match.path);
    }
    const name = schema.remoteName(input.remoteName);
    const matches = workflows.filter(item => item.name === name);
    assert(matches.length > 0, "WORKFLOW_NOT_FOUND");
    assert(matches.length === 1, "WORKFLOW_NAME_AMBIGUOUS", "Remote workflow name is ambiguous; use its path or stable ID.");
    return schema.remotePath(matches[0].path);
  }
  async function getWorkflow(input) {
    const snapshot = await settings.read();
    const remoteRequested = input.remotePath !== undefined || input.remoteName !== undefined || input.remoteWorkflowId !== undefined;
    if (remoteRequested) {
      identifier(input.profileId); assert(input.workflowId === undefined);
      const profile = snapshot.profiles.find(item => item.id === input.profileId);
      assert(profile?.provider === "comfyui" && profile.enabled, "DISABLED");
      const path = await resolveRemotePath(input, snapshot);
      const detail = await settings.readResourceWorkflow({ profileId: profile.id, expectedRevision: snapshot.revision, path });
      let definition = detail.definition;
      if (detail.format === "canvas") {
        const conversion = await settings.convertResourceWorkflow({ profileId: profile.id, expectedRevision: snapshot.revision, path });
        assert(conversion.ok, "WORKFLOW_INVALID", conversion.issues?.map(item => item.message).join(" ") || "Canvas workflow could not be converted safely.");
        definition = conversion.definition;
      } else assert(detail.format === "api" && detail.importable, "WORKFLOW_INVALID", "Remote workflow must be exported in API format before execution.");
      const match = matchWorkflow(definition, input.kind);
      assert(match.suggestedOutput, "WORKFLOW_INVALID", "Remote workflow has no matched output node for this media kind.");
      const workflow = { id: remoteWorkflowId(profile.id, path), name: remoteWorkflowName(path), kind: input.kind, connectionId: profile.id, definition, bindings: match.suggestedBindings.map(({ purpose, nodeId, input: field }) => ({ purpose, nodeId, input: field })), enabled: true, origin: "comfyui-remote", remote: { profileId: profile.id, path, contentSha256: detail.contentSha256, syncedAt: detail.checkedAt }, executable: true, outputs: [match.suggestedOutput] };
      return { snapshot, workflow, profile };
    }
    identifier(input.workflowId);
    const workflow = snapshot.workflows.find(item => item.id === input.workflowId);
    assert(workflow, "WORKFLOW_NOT_FOUND"); assert(workflow.enabled && workflow.executable !== false, "WORKFLOW_INVALID"); assert(workflow.kind === input.kind, "INVALID_ARGUMENT");
    assert(workflow.connectionId, "WORKFLOW_INVALID");
    const profile = snapshot.profiles.find(item => item.id === workflow.connectionId);
    assert(profile?.provider === "comfyui" && profile.enabled, "DISABLED");
    return { snapshot, workflow, profile };
  }
  async function prepareRemotePreflight(input) {
    const remoteRequested = input.remotePath !== undefined || input.remoteName !== undefined || input.remoteWorkflowId !== undefined;
    if (!remoteRequested) return null;
    const snapshot = await settings.read();
    identifier(input.profileId);
    const profile = snapshot.profiles.find(item => item.id === input.profileId);
    assert(profile?.provider === "comfyui" && profile.enabled, "DISABLED");
    const path = await resolveRemotePath(input, snapshot);
    const resources = await settings.resourceSnapshot({ profileId: profile.id, expectedRevision: snapshot.revision });
    const catalogItem = resources.workflows?.items?.find(item => item.path === path);
    return preflightRequest(input, snapshot, profile, path, catalogItem);
  }
  async function recordPreflightFailure(preflight, error, context) {
    let existing;
    try { existing = await store.read(preflight.id); } catch (readError) { if (readError.code !== "NOT_FOUND") throw readError; }
    if (existing) {
      assert(existing.requestHash === preflight.requestHash, "GENERATION_REQUEST_CONFLICT");
      return existing;
    }
    const capturedProject = captureProject ? await captureProject(context).catch(() => undefined) : undefined;
    const base = { version: 1, id: preflight.id, revision: 2, state: "submitting", requestHash: preflight.requestHash, request: preflight.request, profileName: preflight.profile.name || "ComfyUI", createdAt: now(), updatedAt: now(), charging: "unknown", ...(capturedProject ? { project: capturedProject } : {}) };
    if (!await store.create(base)) return store.read(preflight.id);
    return update(base, preflightFailure(error));
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
  async function listRemote(input) { keys(input, ["profileId", "expectedRevision", "kind"]); return settings.listRemoteWorkflows(input); }
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
    assert(!disposed, "DISPOSED"); keys(input, ["workflowId", "profileId", "remotePath", "remoteName", "remoteWorkflowId", "requestKey", "kind", "inputs", "referenceImages", "waitMs"]);
    const selectors = [input.workflowId, input.remotePath, input.remoteName, input.remoteWorkflowId].filter(value => value !== undefined);
    assert(selectors.length === 1, "INVALID_ARGUMENT", "Choose exactly one local workflow ID or remote workflow selector.");
    const remoteRequested = input.remotePath !== undefined || input.remoteName !== undefined || input.remoteWorkflowId !== undefined;
    assert(remoteRequested ? typeof input.profileId === "string" : input.profileId === undefined, "INVALID_ARGUMENT");
    assert(typeof input.requestKey === "string"); assert(["image", "video", "audio"].includes(input.kind));
    const preflight = remoteRequested ? await prepareRemotePreflight(input) : null;
    if (preflight) {
      let existing;
      try { existing = await store.read(preflight.id); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
      if (existing) {
        if (existing.request.outputRules?.[0]?.nodeId === "__preflight__") {
          assert(existing.requestHash === preflight.requestHash, "GENERATION_REQUEST_CONFLICT");
          return schema.publicJob(existing);
        }
      }
    }
    let resolved;
    try { resolved = await getWorkflow(input); }
    catch (error) { if (preflight) await recordPreflightFailure(preflight, error, context); throw error; }
    const { snapshot, workflow, profile } = resolved;
    const expectedRevision = snapshot.revision;
    const remote = workflow.origin === "comfyui-remote";
    const jobRequestInput = { workflowId: workflow.id, profileId: profile.id, expectedRevision, workflowHash: createHash("sha256").update(JSON.stringify(workflow.definition)).digest("hex"), workflowName: workflow.name, kind: workflow.kind, requestKey: input.requestKey, inputs: input.inputs, referenceImages: input.referenceImages, outputRules: workflow.outputs, ...(remote ? { source: "remote", remotePath: workflow.remote.path, remoteContentSha256: workflow.remote.contentSha256 } : {}) };
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
    const snapshot = await settings.read();
    const profile = snapshot.profiles.find(item => item.id === job.request.profileId);
    assert(profile, "WORKFLOW_NOT_FOUND");
    let workflow;
    if (job.request.source === "remote") {
      const resolved = await getWorkflow({ profileId: job.request.profileId, remotePath: job.request.remotePath, kind: job.request.kind });
      workflow = resolved.workflow;
      assert(workflow.id === job.request.workflowId, "GENERATION_REQUEST_CONFLICT");
      assert(workflow.remote.contentSha256 === job.request.remoteContentSha256, "GENERATION_REQUEST_CONFLICT");
      assert(createHash("sha256").update(JSON.stringify(workflow.definition)).digest("hex") === job.request.workflowHash, "GENERATION_REQUEST_CONFLICT");
    } else workflow = snapshot.workflows.find(item => item.id === job.request.workflowId);
    assert(workflow, "WORKFLOW_NOT_FOUND");
    return settings.withComfyProfile({ profileId: profile.id, expectedRevision: snapshot.revision }, async ({ profile: selectedProfile, secret, checkCurrent }) => schema.publicJob(await run(job, selectedProfile, secret, workflow, checkCurrent, 0)));
  }
  async function regenerate(input) {
    keys(input, ["jobId", "confirm"]); assert(input.confirm === true, "INVALID_ARGUMENT", "Confirm one new generation.");
    const job = await store.read(input.jobId);
    assert(job.state === "failed", "INVALID_ARGUMENT", "Only failed records can be regenerated.");
    const request = job.request;
    const retry = { kind: request.kind, requestKey: `retry-${randomUUID()}`, inputs: request.inputs, referenceImages: request.referenceImages, waitMs: 0,
      ...(request.source === "remote" ? { profileId: request.profileId, remotePath: request.remotePath } : { workflowId: request.workflowId }) };
    return generate(retry);
  }
  async function dispose() { disposed = true; }
  return { generate, listRemote, get, list, regenerate, deleteMany, readResult, cancel, reconcile, dispose };
}
module.exports = { createComfyWorkflowGeneration };
