"use strict";

const { isIP } = require("node:net");
const { getMediaProviderCatalog } = require("./media-provider-catalog.js");
const kinds = ["image", "video", "audio"];
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function fail(code = "INVALID_ARGUMENT", message = "Invalid media provider configuration.") { throw Object.assign(new Error(message), { code }); }
function assert(ok, code, message) { if (!ok) fail(code, message); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function keys(value, allowed) { assert(object(value) && Object.keys(value).every(key => allowed.includes(key) && !forbidden.has(key))); }
function text(value, max = 256, empty = true) { assert(typeof value === "string" && value.length <= max && (empty || value.length > 0) && !/[\x00-\x1f\x7f]/.test(value)); return value; }
function identifier(value) { text(value, 128, false); assert(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)); return value; }
function revision(value) { assert(Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER); return value; }
function baseUrl(value, provider) {
  text(value, 2048);
  if (provider.id === "dreamina") { assert(value === ""); return ""; }
  let url; try { url = new URL(value); } catch { fail(); }
  assert(!url.username && !url.password && !url.search && !url.hash && !/[?#]/.test(value));
  const host = url.hostname.toLowerCase();
  const ip = host.replace(/^\[|\]$/g, "");
  assert(!host.endsWith(".") && !host.includes("*") && !["metadata", "metadata.google.internal", "instance-data", "169.254.169.254", "100.100.100.200", "0.0.0.0", "::", "[::]"].includes(host));
  assert(!host.includes("metadata") && !host.startsWith("instance-data."));
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    assert(a !== 0 && a < 224 && !(a === 169 && b === 254));
  }
  if (isIP(ip) === 6) assert(ip !== "::" && ip !== "fd00:ec2::254" && !/^(?:fe[89ab]|ff|::ffff:)/.test(ip));
  const parts = ip.split(".").map(Number);
  const local = host === "localhost" || host.endsWith(".localhost") || ip === "::1" || (isIP(ip) === 4 && (parts[0] === 127 || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)));
  assert(["https:", "http:"].includes(url.protocol));
  if (url.protocol === "http:" && host === "example.com") fail("INVALID_ARGUMENT");
  if (["minimax", "xiaomi", "libtv"].includes(provider.id)) {
    const official = new URL(provider.defaultBaseUrl);
    assert(url.origin === official.origin);
  }
  return url.href.replace(/\/+$/, "");
}
function workflowTree(value, depth = 0) {
  assert(depth <= 24);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { assert(Number.isFinite(value)); return; }
  if (typeof value === "string") {
    assert(value.length <= 200000 && !/\x00/.test(value));
    assert(!/\b(?:bearer\s+\S+|sk-[a-z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=])/i.test(value));
    assert(!/https?:\/\/[^\s/]*@/i.test(value) && !/[?&](?:key|token|api[_-]?key|access_token|secret|password)=/i.test(value));
    return;
  }
  if (Array.isArray(value)) { assert(value.length <= 1000); value.forEach(item => workflowTree(item, depth + 1)); return; }
  assert(object(value) && Object.keys(value).length <= 1000);
  for (const [key, item] of Object.entries(value)) {
    text(key, 128, false);
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    assert(!forbidden.has(key) && !/(?:authorization|apikey|accesstoken|authtoken|password|credential|secret|cookie|headers)/.test(normalized) && normalized !== "token");
    workflowTree(item, depth + 1);
  }
}
function workflow(value) {
  if (value === null || value === undefined) return null;
  assert(object(value));
  workflowTree(value);
  assert(Buffer.byteLength(JSON.stringify(value)) <= 200 * 1024 && Object.keys(value).length <= 300);
  for (const [id, node] of Object.entries(value)) {
    identifier(id); keys(node, ["class_type", "inputs", "_meta"]); text(node.class_type, 128, false); assert(object(node.inputs));
    if (node._meta !== undefined) { keys(node._meta, ["title"]); text(node._meta.title, 256); }
  }
  return structuredClone(value);
}
function bindings(value, flow, unique = false) {
  const items = value === undefined ? [] : value;
  assert(Array.isArray(items) && items.length <= 12);
  const purposes = new Set(); const targets = new Set();
  return items.map(item => {
    keys(item, ["purpose", "nodeId", "input"]);
    assert(["prompt", "negativePrompt", "seed", "width", "height", "steps"].includes(item.purpose));
    identifier(item.nodeId); text(item.input, 128, false);
    assert(flow && Object.hasOwn(flow, item.nodeId) && Object.hasOwn(flow[item.nodeId].inputs, item.input));
    const target = JSON.stringify([item.nodeId, item.input]);
    if (unique) assert(!purposes.has(item.purpose) && !targets.has(target));
    purposes.add(item.purpose); targets.add(target);
    return { purpose: item.purpose, nodeId: item.nodeId, input: item.input };
  });
}
function workflows(value) {
  assert(Array.isArray(value) && value.length <= 64);
  const clean = value.map(item => {
    keys(item, ["id", "name", "kind", "connectionId", "definition", "bindings", "enabled"]);
    const id = identifier(item.id); const name = text(item.name, 128, false);
    assert(kinds.includes(item.kind) && typeof item.enabled === "boolean");
    const connectionId = item.connectionId === null ? null : identifier(item.connectionId);
    const definition = workflow(item.definition);
    assert(definition && Object.keys(definition).length > 0 && Array.isArray(item.bindings));
    return { id, name, kind: item.kind, connectionId, definition, bindings: bindings(item.bindings, definition, true), enabled: item.enabled };
  });
  assert(new Set(clean.map(item => item.id)).size === clean.length);
  return clean;
}
function workflowConnections(items, profiles) {
  for (const item of items) assert(item.connectionId === null || profiles.some(profile => profile.id === item.connectionId && profile.provider === "comfyui"), "INVALID_ARGUMENT", "Workflow connections must reference a saved ComfyUI profile or be explicitly unbound.");
}
function config(input, persisted = false) {
  keys(input, persisted ? ["revision", "profiles", "defaults", "workflows"] : ["expectedRevision", "profiles", "defaults", "workflows"]);
  const version = revision(persisted ? input.revision : input.expectedRevision);
  assert(Array.isArray(input.profiles) && input.profiles.length <= 32);
  const updates = new Map();
  const profiles = input.profiles.map(raw => {
    keys(raw, ["id", "name", "provider", "enabled", "baseUrl", "models", "modelId", "voice", "format", "cliPath", "comfyUser", "authKind", "headerName", "workflow", "bindings", ...(persisted ? [] : ["credentialUpdate", "credentialConfigured", "lastProbe"])]);
    const id = identifier(raw.id);
    const provider = getMediaProviderCatalog().find(item => item.id === raw.provider); assert(provider);
    const models = raw.models === undefined ? provider.defaultModels : raw.models;
    assert(Array.isArray(models) && models.length <= 100);
    const cleanModels = models.map(item => { keys(item, ["id", "name", "kind"]); assert(provider.kinds.includes(item.kind)); return { id: identifier(item.id), name: text(item.name === undefined ? item.id : item.name, 256, false), kind: item.kind }; });
    assert(new Set(cleanModels.map(item => item.id)).size === cleanModels.length);
    const modelId = text(raw.modelId === undefined ? "" : raw.modelId, 128);
    assert(!modelId || cleanModels.some(item => item.id === modelId));
    assert(raw.enabled === undefined || typeof raw.enabled === "boolean");
    const flow = workflow(raw.workflow);
    const cleanBindings = bindings(raw.bindings, flow);
    if (provider.id !== "comfyui") assert((!flow || Object.keys(flow).length === 0) && cleanBindings.length === 0);
    const update = raw.credentialUpdate === undefined ? { action: "preserve" } : raw.credentialUpdate;
    keys(update, ["action", "value"]); assert(["preserve", "replace", "clear"].includes(update.action));
    if (update.action === "replace") { text(update.value, 8192, false); assert(!["dreamina", "libtv"].includes(provider.id)); }
    else assert(update.value === undefined);
    if (provider.id !== "comfyui") assert(raw.authKind === undefined && raw.headerName === undefined);
    // Omission preserves the legacy optional-Bearer contract; new UI drafts
    // explicitly select none. Do not infer auth from a single save's key update.
    const authKind = raw.authKind;
    assert(authKind === undefined || ["none", "bearer", "header"].includes(authKind));
    assert(authKind !== "none" || update.action !== "replace");
    const headerName = text(raw.headerName === undefined ? "" : raw.headerName, 80);
    if (authKind === "header") assert(/^(?:x-[a-z0-9-]+|authorization)$/i.test(headerName));
    else assert(!headerName);
    updates.set(id, structuredClone(update));
    return { id, name: text(raw.name === undefined ? provider.name : raw.name, 128, false), provider: provider.id,
      enabled: raw.enabled === undefined ? true : raw.enabled, baseUrl: baseUrl(raw.baseUrl === undefined ? provider.defaultBaseUrl : raw.baseUrl, provider),
      models: cleanModels, modelId, voice: text(raw.voice === undefined ? (provider.id === "xiaomi" ? "mimo_default" : "") : raw.voice, 128),
      format: text(raw.format === undefined ? "" : raw.format, 64), cliPath: text(raw.cliPath === undefined ? "" : raw.cliPath, 2048),
      comfyUser: text(raw.comfyUser === undefined ? "" : raw.comfyUser, 128),
      ...(authKind !== undefined ? { authKind, headerName } : {}), workflow: flow, bindings: cleanBindings };
  });
  assert(new Set(profiles.map(item => item.id)).size === profiles.length);
  keys(input.defaults, kinds);
  const defaults = {};
  for (const kind of kinds) {
    const id = input.defaults[kind]; assert(id === null || typeof id === "string");
    if (id !== null) assert(profiles.some(item => item.id === id && item.enabled && getMediaProviderCatalog().find(provider => provider.id === item.provider).kinds.includes(kind)));
    defaults[kind] = id;
  }
  const cleanWorkflows = input.workflows === undefined ? (persisted ? [] : undefined) : workflows(input.workflows);
  if (cleanWorkflows) workflowConnections(cleanWorkflows, profiles);
  return { revision: version, profiles, defaults, updates, workflows: cleanWorkflows };
}
module.exports = { assert, fail, object, keys, identifier, revision, config, workflowConnections, workflow, workflowTree };
