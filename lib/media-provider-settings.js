"use strict";

const { createHash } = require("node:crypto");
const { getMediaProviderCatalog } = require("./media-provider-catalog.js");
const { assert, keys, identifier, revision, config, workflowConnections, workflow, object } = require("./media-provider-schema.js");
const { createStorage } = require("./media-provider-storage.js");
const { discover } = require("./media-provider-probe.js");
const { browseInput, browseResources, relativePath, jsonPath } = require("./comfy-resources.js");
const { createResourceSnapshotStore, profileIdentity } = require("./comfy-resource-snapshots.js");
const { syncCatalog, fetchWorkflowDetail } = require("./comfy-resource-sync.js");
const { requestJson } = require("./media-provider-request.js");
const { convertCanvasWorkflow } = require("./comfy-canvas-converter.js");
const { createCredentialPersistence } = require("./credential-persistence.js");
const { matchWorkflow } = require("./comfy-workflow-matching.js");
const { remoteWorkflowId, remoteWorkflowName, remoteWorkflowDisplayName } = require("./comfy-remote-workflows.js");
const { isSupportedAudioModel } = require("./audio-models.js");

function singletonConflicts(profiles) {
  return ["dreamina", "libtv"].map(provider => ({ provider, profileIds: profiles.filter(item => item.provider === provider).map(item => item.id) })).filter(item => item.profileIds.length > 1);
}
function validateSingletonSave(profiles, previous) {
  for (const { provider, profileIds } of singletonConflicts(profiles)) {
    const existing = new Set(previous.filter(item => item.provider === provider).map(item => item.id));
    assert(profileIds.every(id => existing.has(id)), "INVALID_ARGUMENT", "Dreamina and LibTV each support one profile in this plugin. Repair legacy duplicates by retaining or removing existing profiles.");
}
}
function selectNodeInfo(payload, classTypes) {
  assert(object(payload), "WORKFLOW_INVALID", "ComfyUI node metadata was invalid.");
  assert(Array.isArray(classTypes) && classTypes.length > 0 && classTypes.length <= 300, "WORKFLOW_INVALID");
  const selected = {};
  for (const classType of classTypes) {
    assert(typeof classType === "string" && classType.length > 0 && classType.length <= 128 && !/[\u0000-\u001f\u007f]/.test(classType), "WORKFLOW_INVALID");
    const source = payload[classType];
    assert(object(source) && object(source.input), "WORKFLOW_INVALID", `ComfyUI node metadata is missing for ${classType}.`);
    const input = {};
    for (const section of ["required", "optional"]) {
      if (source.input[section] === undefined) continue;
      assert(object(source.input[section]), "WORKFLOW_INVALID");
      input[section] = {};
      for (const [name, spec] of Object.entries(source.input[section])) {
        assert(typeof name === "string" && name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f]/.test(name));
        assert(Array.isArray(spec) && spec.length >= 1 && spec.length <= 2);
        assert(typeof spec[0] === "string" || Array.isArray(spec[0]));
        if (spec[1] !== undefined) assert(object(spec[1]));
        input[section][name] = structuredClone(spec);
      }
    }
    selected[classType] = { input };
  }
  return selected;
}

function createMediaProviderSettings({ getDataPath, request, secrets }) {
  assert(typeof getDataPath === "function" && typeof request === "function");
  const storage = createStorage(getDataPath);
  const snapshots = createResourceSnapshotStore(getDataPath);
  const credentialStore = createCredentialPersistence(secrets);
  let state; let credentials = new Map(); let generation = 0; let epoch = 0; let disposed = false;
  let queue = Promise.resolve();
  const pending = new Set(); const probes = new Map(); const resourceMembers = new Map();
  function alive() { assert(!disposed, "DISPOSED", "Media provider settings have been disposed."); }
  function enqueue(work) {
    const task = queue.then(work);
    queue = task.catch(() => {});
    return task;
  }
  async function load() {
    alive();
    if (!state) {
      const loaded = await storage.read(); alive();
      const restored = await credentialStore.restore(loaded.encryptedCredentials, loaded.profiles); alive();
      state = loaded; credentials = restored;
    }
  }
  function snapshot() {
    const credentialStorageStatus = credentialStore.status();
    return { revision: state.revision, credentialStorageStatus, profiles: state.profiles.map(profile => ({ ...structuredClone(profile), credentialConfigured: credentials.has(profile.id), ...(probes.has(profile.id) ? { lastProbe: structuredClone(probes.get(profile.id)) } : {}) })), defaults: { ...state.defaults }, catalog: getMediaProviderCatalog(), workflows: structuredClone(state.workflows), singletonConflicts: singletonConflicts(state.profiles) };
  }
  function read() { return enqueue(async () => { await load(); return snapshot(); }); }
  async function save(input) {
    // Validate and detach at entry so callers cannot mutate queued input.
    alive(); const candidate = config(input); const capturedEpoch = epoch;
    return enqueue(async () => {
      await load();
      assert(capturedEpoch === epoch, "DISPOSED", "Media provider settings have been disposed.");
      assert(candidate.revision === state.revision, "CONFLICT", "Provider configuration changed. Read settings again before saving.");
      validateSingletonSave(candidate.profiles, state.profiles);
      const workflows = candidate.workflows === undefined ? state.workflows : candidate.workflows;
      workflowConnections(workflows, candidate.profiles);
      const nextCredentials = new Map();
      for (const profile of candidate.profiles) {
        const update = candidate.updates.get(profile.id);
        const previous = state.profiles.find(item => item.id === profile.id);
        // Old panel clients may omit the newly added public auth fields.
        if (profile.provider === "comfyui" && profile.authKind === undefined && previous?.provider === "comfyui" && previous.authKind !== undefined) {
          profile.authKind = previous.authKind; profile.headerName = previous.headerName;
        }
        if (profile.provider === "comfyui" && profile.authKind === "none") {
          assert(update.action !== "replace", "INVALID_ARGUMENT", "Credentials require an explicit authentication mode.");
          continue;
        }
        const sameAuth = profile.provider !== "comfyui" ||
          (previous?.authKind || "bearer") === (profile.authKind || "bearer") &&
          (previous?.headerName || "").toLowerCase() === (profile.headerName || "").toLowerCase() && previous?.comfyUser === profile.comfyUser;
        if (update.action === "replace") nextCredentials.set(profile.id, update.value);
        else if (update.action === "preserve" && sameAuth && previous?.provider === profile.provider && previous.baseUrl === profile.baseUrl && credentials.has(profile.id)) nextCredentials.set(profile.id, credentials.get(profile.id));
      }
      const next = { revision: state.revision + 1, profiles: candidate.profiles, defaults: candidate.defaults, workflows };
      const serialized = JSON.stringify(next);
      // Prevent accidental copies of known credentials into public fields.
      for (const secret of new Set([...credentials.values(), ...nextCredentials.values()])) assert(!serialized.includes(JSON.stringify(secret).slice(1, -1)), "INVALID_ARGUMENT", "Credentials must appear only in credentialUpdate.");
      const encryptedCredentials = await credentialStore.seal(nextCredentials, next.profiles); alive();
      if (encryptedCredentials !== undefined) next.encryptedCredentials = encryptedCredentials;
      const invalidated = state.profiles.filter(previous => {
        const profile = candidate.profiles.find(item => item.id === previous.id);
        return previous.provider === "comfyui" && (!profile || profile.provider !== "comfyui" || profileIdentity(profile) !== profileIdentity(previous) || candidate.updates.get(previous.id)?.action !== "preserve");
      }).map(profile => profile.id);
      // Invalidate before committing config so a failed second write can only
      // discard a cache, never expose resources under a changed credential.
      if (invalidated.length) await snapshots.invalidate(invalidated, alive);
      await storage.write(next, alive);
      alive(); state = next; credentials = nextCredentials; generation += 1; probes.clear(); resourceMembers.clear();
      return snapshot();
    });
  }
  async function probe(input) {
    alive(); keys(input, ["profileId", "expectedRevision", "workflowId", "catalog"]);
    const profileId = identifier(input.profileId); const expectedRevision = revision(input.expectedRevision);
    const workflowId = input.workflowId === undefined ? undefined : identifier(input.workflowId);
    const catalog = input.catalog;
    assert(catalog === undefined || ["models", "voices"].includes(catalog), "INVALID_ARGUMENT");
    assert(!pending.has(profileId), "PROBE_PENDING", "A discovery request is already pending for this profile.");
    pending.add(profileId);
    try {
      const captured = await enqueue(async () => {
        await load();
        assert(expectedRevision === state.revision, "CONFLICT", "Provider configuration changed. Read settings again before probing.");
        const profile = state.profiles.find(item => item.id === profileId);
        assert(profile, "NOT_FOUND", "Provider profile was not found.");
        assert(profile.enabled, "DISABLED", "Enable the saved provider profile before probing.");
        assert(catalog === undefined || profile.provider === "minimax", "INVALID_ARGUMENT");
        const selected = structuredClone(profile);
        if (workflowId !== undefined) {
          assert(profile.provider === "comfyui", "INVALID_ARGUMENT", "Workflow discovery requires a saved ComfyUI profile.");
          const workflow = state.workflows.find(item => item.id === workflowId);
          assert(workflow, "NOT_FOUND", "Workflow was not found.");
          assert(workflow.enabled, "DISABLED", "Enable the saved workflow before probing.");
          assert(workflow.connectionId === profileId, "INVALID_ARGUMENT", "Workflow must be bound to the selected saved ComfyUI profile.");
          selected.workflow = structuredClone(workflow.definition);
        }
        return { profile: selected, secret: credentials.get(profileId), revision: state.revision, generation, epoch };
      });
      function current() {
        assert(!disposed && captured.epoch === epoch && captured.revision === state.revision && captured.generation === generation, "CONFLICT", "Provider configuration changed while discovery was pending.");
      }
      current();
      const output = await discover(captured.profile, captured.secret, request, current, catalog);
      output.scope = workflowId === undefined ? { kind: "profile", profileId } : { kind: "workflow", profileId, workflowId };
      if (catalog !== undefined) output.scope.catalog = catalog;
      current(); probes.set(profileId, output);
      return structuredClone(output);
    } finally { pending.delete(profileId); }
  }
  async function browse(input) {
    alive(); const selected = browseInput(input); const { profileId, expectedRevision } = selected;
    assert(!pending.has(profileId), "PROBE_PENDING", "A discovery request is already pending for this profile.");
    pending.add(profileId);
    try {
      const captured = await enqueue(async () => {
        await load();
        assert(expectedRevision === state.revision, "CONFLICT", "Provider configuration changed. Read settings again before browsing.");
        const profile = state.profiles.find(item => item.id === profileId);
        assert(profile, "NOT_FOUND", "Provider profile was not found.");
        assert(profile.enabled, "DISABLED", "Enable the saved provider profile before browsing.");
        assert(profile.provider === "comfyui", "INVALID_ARGUMENT", "Resource browsing requires a saved ComfyUI profile.");
        const allowed = resourceMembers.get(profileId) || {};
        // A failed refresh must not leave an older listing selectable.
        if (selected.resource === "model-folders") delete allowed.folders;
        if (selected.resource === "workflows") delete allowed.workflows;
        return { profile: structuredClone(profile), secret: credentials.get(profileId), secrets: [...new Set(credentials.values())], allowed, revision: state.revision, generation, epoch };
      });
      if (selected.folder !== undefined) relativePath(selected.folder, captured.secrets, true);
      if (selected.path !== undefined) jsonPath(selected.path, captured.secrets);
      function current() {
        assert(!disposed && captured.epoch === epoch && captured.revision === state.revision && captured.generation === generation, "CONFLICT", "Provider configuration changed while resource browsing was pending.");
      }
      current();
      const { output, folders, workflows } = await browseResources(selected, captured, request, current);
      current();
      if (folders || workflows) resourceMembers.set(profileId, { ...captured.allowed, ...(folders ? { folders } : {}), ...(workflows ? { workflows } : {}) });
      return structuredClone(output);
    } finally { pending.delete(profileId); }
  }
  function resourceInput(input, extra = []) {
    alive(); keys(input, ["profileId", "expectedRevision", ...extra]);
    return { profileId: identifier(input.profileId), expectedRevision: revision(input.expectedRevision) };
  }
  async function captureResources({ profileId, expectedRevision }) {
    await load();
    assert(expectedRevision === state.revision, "CONFLICT", "Provider configuration changed.");
    const profile = state.profiles.find(item => item.id === profileId);
    assert(profile, "NOT_FOUND"); assert(profile.provider === "comfyui", "INVALID_ARGUMENT"); assert(profile.enabled, "DISABLED");
    return { profile: structuredClone(profile), secret: credentials.get(profileId), secrets: [...credentials.values()], revision: state.revision, generation, epoch };
  }
  function currentResources(captured) {
    assert(!disposed && captured.epoch === epoch && captured.revision === state.revision && captured.generation === generation, "CONFLICT", "Configuration changed while synchronizing resources.");
  }
  function publicSnapshot(captured, snapshot) {
    return { profileId: captured.profile.id, revision: captured.revision, models: snapshot.models, workflows: snapshot.workflows };
  }
  function resourceSnapshot(input) {
    const selected = resourceInput(input);
    return enqueue(async () => {
      const captured = await captureResources(selected);
      const snapshot = await snapshots.read(captured.profile, captured.secrets);
      currentResources(captured); return publicSnapshot(captured, snapshot);
    });
  }
  async function syncResources(input) {
    const selected = resourceInput(input, ["resource"]), resource = input.resource;
    assert(["models", "workflows"].includes(resource));
    assert(!pending.has(selected.profileId), "PROBE_PENDING"); pending.add(selected.profileId);
    try {
      const captured = await enqueue(() => captureResources(selected));
      const checkCurrent = () => currentResources(captured);
      const patch = await syncCatalog(resource, captured, request, checkCurrent);
      return await enqueue(async () => {
        checkCurrent();
        const snapshot = await snapshots.write(captured.profile, patch, checkCurrent, captured.secrets);
        checkCurrent(); return publicSnapshot(captured, snapshot);
      });
    } finally { pending.delete(selected.profileId); }
  }
  async function readResourceWorkflow(input) {
    const selected = resourceInput(input, ["path"]), path = jsonPath(input.path);
    assert(!pending.has(selected.profileId), "PROBE_PENDING"); pending.add(selected.profileId);
    try {
      const { captured, snapshot } = await enqueue(async () => {
        const captured = await captureResources(selected);
        const snapshot = await snapshots.read(captured.profile, captured.secrets);
        currentResources(captured); return { captured, snapshot };
      });
      const checkCurrent = () => currentResources(captured);
      const detail = await fetchWorkflowDetail(path, snapshot, captured, request, checkCurrent);
      checkCurrent();
      if (!snapshot.details.some(item => item.path === path)) await enqueue(async () => {
        checkCurrent();
        const details = [...snapshot.details.filter(item => item.path !== path).slice(-63), detail];
        await snapshots.write(captured.profile, { details }, checkCurrent, captured.secrets);
      });
      checkCurrent(); return { profileId: captured.profile.id, revision: captured.revision, contentSha256: createHash("sha256").update(JSON.stringify(detail.definition)).digest("hex"), ...structuredClone(detail) };
    } finally { pending.delete(selected.profileId); }
  }
  async function convertResourceWorkflow(input) {
    const selected = resourceInput(input, ["path"]), path = jsonPath(input.path);
    assert(!pending.has(selected.profileId), "PROBE_PENDING"); pending.add(selected.profileId);
    try {
      const { captured, snapshot } = await enqueue(async () => {
        const captured = await captureResources(selected);
        const snapshot = await snapshots.read(captured.profile, captured.secrets);
        currentResources(captured); return { captured, snapshot };
      });
      const checkCurrent = () => currentResources(captured);
      const detail = await fetchWorkflowDetail(path, snapshot, captured, request, checkCurrent);
      assert(detail.format === "canvas", "INVALID_ARGUMENT", "Only Canvas workflows can use the in-plugin converter.");
      checkCurrent();
      if (!snapshot.details.some(item => item.path === path)) await enqueue(async () => {
        checkCurrent();
        const details = [...snapshot.details.filter(item => item.path !== path).slice(-63), detail];
        await snapshots.write(captured.profile, { details }, checkCurrent, captured.secrets);
      });
      const classTypes = [...new Set(detail.definition.nodes.map(node => node?.type).filter(type => typeof type === "string"))];
      const objectInfo = await requestJson(captured.profile, captured.secret, request, checkCurrent, "/object_info", undefined, false, 16 * 1024 * 1024);
      const selectedInfo = selectNodeInfo(objectInfo, classTypes);
      const conversion = convertCanvasWorkflow(detail.definition, selectedInfo);
      checkCurrent();
      if (conversion.ok) conversion.definition = workflow(conversion.definition);
      return { profileId: captured.profile.id, revision: captured.revision, path, contentSha256: detail.contentSha256, sourceFormat: "canvas", ...conversion };
    } finally { pending.delete(selected.profileId); }
  }
  async function listRemoteWorkflows(input) {
    const selected = resourceInput(input, ["kind"]);
    const captured = await enqueue(() => captureResources(selected));
    const snapshot = await snapshots.read(captured.profile, captured.secrets);
    currentResources(captured);
    const kind = input.kind;
    assert(kind === undefined || ["image", "video", "audio"].includes(kind), "INVALID_ARGUMENT");
    const items = snapshot.workflows?.items || [];
    const names = new Map();
    for (const item of items) {
      const name = remoteWorkflowName(item.path);
      names.set(name, (names.get(name) || 0) + 1);
    }
    const workflows = items.map(item => {
      const detail = snapshot.details.find(entry => entry.path === item.path);
      const name = remoteWorkflowName(item.path);
      const ambiguous = names.get(name) > 1;
      const matches = detail?.format === "api" ? ["image", "video", "audio"].filter(candidate => !kind || candidate === kind).map(candidate => ({ kind: candidate, ...matchWorkflow(detail.definition, candidate) })) : [];
      const executableKinds = matches.filter(match => match.suggestedOutput).map(match => match.kind);
      return { id: remoteWorkflowId(captured.profile.id, item.path), name, displayName: remoteWorkflowDisplayName(name, item.path, ambiguous), ambiguous, path: item.path, size: item.size, modified: item.modified, format: detail?.format || "unknown", importable: detail?.importable === true, executable: executableKinds.length > 0, executableKinds, contentSha256: detail?.contentSha256 || null, matches };
    });
    return { profileId: captured.profile.id, revision: captured.revision, workflows: workflows.filter(item => !kind || item.executableKinds.includes(kind)) };
  }
  // Entry-only callback: the credential never enters a panel/Agent response.
  async function withGenerationProfile(input, work, supports, publicFields, unsupportedMessage) {
    alive(); assert(typeof work === "function");
    input = structuredClone(input);
    const captured = await enqueue(async () => {
      await load();
      assert(input.expectedRevision === state.revision, "CONFLICT", "Read the current configuration before generating.");
      const profile = state.profiles.find(item => item.id === input.profileId);
      assert(profile, "NOT_FOUND"); assert(profile.enabled, "DISABLED");
      assert(supports(profile, input.modelId), "GENERATION_UNSUPPORTED", unsupportedMessage);
      assert(credentials.has(profile.id), "CREDENTIAL_REQUIRED", "Save an API credential before generating.");
      for (const field of publicFields) if (typeof input[field] === "string") {
        for (const value of credentials.values()) assert(!input[field].includes(value), "INVALID_ARGUMENT", "Credentials cannot appear in generation parameters.");
      }
      return { profile: structuredClone(profile), secret: credentials.get(profile.id), revision: state.revision, generation, epoch };
    });
    const checkCurrent = () => {
      alive();
      assert(captured.epoch === epoch && captured.revision === state.revision && captured.generation === generation, "CONFLICT", "The configuration changed before dispatch.");
    };
    checkCurrent();
    return work({ profile: captured.profile, secret: captured.secret, checkCurrent });
  }
  function withImageProfile(input, work) {
    return withGenerationProfile(input, work,
      (profile, modelId) => profile.provider === "openai" && /^gpt-image-/.test(modelId) && profile.models.some(model => model.kind === "image" && model.id === modelId),
      ["prompt"], "Select a configured GPT image model.");
  }
  function withAudioProfile(input, work) {
    return withGenerationProfile(input, work,
      (profile, modelId) => profile.provider === "minimax" && isSupportedAudioModel(modelId) && profile.models.some(model => model.kind === "audio" && model.id === modelId),
      ["text", "voiceId"], "Select a configured MiniMax speech model.");
  }
  function withComfyProfile(input, work) {
    alive(); assert(typeof work === "function"); input = structuredClone(input);
    return enqueue(async () => {
      await load();
      assert(input.expectedRevision === state.revision, "CONFLICT", "Read the current configuration before generating.");
      const profile = state.profiles.find(item => item.id === input.profileId);
      assert(profile, "NOT_FOUND"); assert(profile.provider === "comfyui", "INVALID_ARGUMENT"); assert(profile.enabled, "DISABLED");
      assert(profile.authKind === undefined || profile.authKind === "none" || credentials.has(profile.id), "CREDENTIAL_REQUIRED", "Save the ComfyUI credential before generating.");
      const captured = { profile: structuredClone(profile), secret: credentials.get(profile.id), revision: state.revision, generation, epoch };
      const checkCurrent = () => { alive(); assert(captured.epoch === epoch && captured.revision === state.revision && captured.generation === generation, "CONFLICT", "The configuration changed before dispatch."); };
      checkCurrent(); return work({ ...captured, checkCurrent });
    });
  }
  function dispose() {
    disposed = true; epoch += 1; generation += 1; credentials.clear(); probes.clear(); resourceMembers.clear();
    // A rename already issued to the OS cannot be cancelled. Drain it before
    // a replacement service may read this directory, without reinstalling keys.
    return queue;
  }
  return { read, save, probe, browse, resourceSnapshot, syncResources, readResourceWorkflow, convertResourceWorkflow, listRemoteWorkflows, withImageProfile, withAudioProfile, withComfyProfile, dispose };
}
module.exports = { createMediaProviderSettings };
