"use strict";

const { createHash } = require("node:crypto");
const { assert, fail, object, keys, identifier } = require("./media-provider-schema.js");
const { parseResourceItems, parseWorkflowDetail, relativePath, jsonPath } = require("./comfy-resources.js");
const { createPrivateJsonStorage } = require("./private-json-storage.js");
const emptySnapshot = () => ({ models: null, workflows: null, details: [] });

function strictKeys(value, allowed) {
  keys(value, allowed);
  assert(Reflect.ownKeys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key)));
}
function list(value, max) { assert(Array.isArray(value) && value.length <= max); return value; }
function unique(items, field) { assert(new Set(items.map(item => item[field])).size === items.length); return items; }
function checkedAt(value) {
  assert(typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value));
  const time = Date.parse(value);
  const normalized = value.includes(".") ? value.replace(/\.(\d+)Z$/, (_, fraction) => `.${fraction.padEnd(3, "0")}Z`) : value.replace(/Z$/, ".000Z");
  assert(Number.isFinite(time) && new Date(time).toISOString() === normalized);
  return value;
}
function profileIdentity(profile) {
  assert(object(profile));
  const id = identifier(profile.id); const provider = identifier(profile.provider);
  const { baseUrl } = profile; const comfyUser = profile.comfyUser ?? "";
  const authKind = profile.authKind ?? "legacy"; const headerName = profile.headerName ?? "";
  assert(typeof baseUrl === "string" && typeof comfyUser === "string" && typeof headerName === "string");
  assert(["legacy", "none", "bearer", "header"].includes(authKind));
  // Credentials are deliberately excluded: the settings owner invalidates before
  // replacing or clearing them, including when a later configuration save fails.
  return createHash("sha256").update(JSON.stringify([id, provider, baseUrl, comfyUser, authKind, headerName.toLowerCase()])).digest("hex");
}
function modelCatalog(value, secrets) {
  if (value === null) return null;
  strictKeys(value, ["checkedAt", "folders"]);
  const folders = list(value.folders, 256).map(folder => {
    strictKeys(folder, ["name", "items"]);
    const name = relativePath(folder.name, secrets, true);
    const names = list(folder.items, 10000).map(item => { strictKeys(item, ["name"]); return item.name; });
    return { name, items: unique(parseResourceItems("models", names, secrets), "name") };
  });
  return { checkedAt: checkedAt(value.checkedAt), folders: unique(folders, "name") };
}
function workflowCatalog(value, secrets) {
  if (value === null) return null;
  strictKeys(value, ["checkedAt", "items"]);
  list(value.items, 10000).forEach(item => {
    strictKeys(item, ["path", "size", "modified", "created"]);
    // The network parser filters non-JSON files; a persisted catalog must not
    // silently lose a record when read back.
    jsonPath(item.path, secrets);
  });
  return { checkedAt: checkedAt(value.checkedAt), items: unique(parseResourceItems("workflows", value.items, secrets), "path") };
}
function detailEntries(value, secrets) {
  return unique(list(value, 64).map(item => {
    strictKeys(item, ["path", "checkedAt", "definition", "format", "importable"]);
    const parsed = parseWorkflowDetail(item.definition, secrets);
    assert(item.format === parsed.format && item.importable === parsed.importable);
    return { path: jsonPath(item.path, secrets), checkedAt: checkedAt(item.checkedAt), ...structuredClone(parsed) };
  }), "path");
}
function snapshot(value, secrets) {
  const models = modelCatalog(value.models, secrets);
  const workflows = workflowCatalog(value.workflows, secrets);
  const details = detailEntries(value.details, secrets);
  const paths = new Set(workflows?.items.map(item => item.path));
  assert(details.every(item => paths.has(item.path)));
  return { models, workflows, details };
}
function document(value, secrets = []) {
  strictKeys(value, ["schemaVersion", "entries"]);
  assert(value.schemaVersion === 1);
  const entries = list(value.entries, 32).map(entry => {
    strictKeys(entry, ["profileId", "identity", "models", "workflows", "details"]);
    const profileId = identifier(entry.profileId);
    assert(secrets.every(secret => !profileId.includes(secret)));
    assert(typeof entry.identity === "string" && /^[a-f0-9]{64}$/.test(entry.identity));
    return { profileId, identity: entry.identity, ...snapshot(entry, secrets) };
  });
  return { schemaVersion: 1, entries: unique(entries, "profileId") };
}
function uniqueJsonKeys(raw) {
  // JSON.parse already checked syntax. Track only containers and decoded member
  // names so duplicate keys (including escaped spellings) cannot hide corruption.
  const stack = [];
  for (const match of raw.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],]/g)) {
    const token = match[0]; const current = stack.at(-1);
    if (token === "{") stack.push({ names: new Set(), key: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && current) current.key = true;
    else if (token.startsWith('"') && current?.key) {
      const name = JSON.parse(token); assert(!current.names.has(name));
      current.names.add(name); current.key = false;
    }
  }
}
function createResourceSnapshotStore(getDataPath) {
  const storage = createPrivateJsonStorage(getDataPath, {
    filename: "aimedia-resource-snapshots.json",
    maxBytes: 32 * 1024 * 1024,
    empty: () => ({ schemaVersion: 1, entries: [] }),
    parse(value, raw) { uniqueJsonKeys(raw); return document(value); },
  });
  async function read(profile, secrets = []) {
    const identity = profileIdentity(profile); const profileId = profile.id;
    const saved = await storage.read();
    const entry = saved.entries.find(item => item.profileId === profileId && item.identity === identity);
    if (!entry) return emptySnapshot();
    try { return snapshot(entry, secrets); }
    catch { fail("STORAGE_ERROR", "Resource snapshots could not be read safely. Invalidate or repair the cache before continuing."); }
  }
  async function write(profile, patch, checkCurrent, secrets = []) {
    const identity = profileIdentity(profile); const profileId = profile.id;
    keys(patch, ["models", "workflows", "details"]);
    assert(Object.keys(patch).length > 0 && Reflect.ownKeys(patch).length === Object.keys(patch).length);
    const clean = {};
    if (Object.hasOwn(patch, "models")) clean.models = modelCatalog(patch.models, secrets);
    if (Object.hasOwn(patch, "workflows")) clean.workflows = workflowCatalog(patch.workflows, secrets);
    if (Object.hasOwn(patch, "details")) clean.details = detailEntries(patch.details, secrets);
    let saved = await storage.read();
    try { saved = document(saved, secrets); }
    catch { fail("STORAGE_ERROR", "Resource snapshots contain unsafe data. Invalidate or repair the cache before continuing."); }
    const current = saved.entries.find(item => item.profileId === profileId && item.identity === identity);
    const merged = { ...(current || emptySnapshot()), ...clean };
    if (Object.hasOwn(clean, "workflows") && !Object.hasOwn(clean, "details")) merged.details = [];
    const next = snapshot(merged, secrets);
    const entry = { profileId, identity, ...next };
    const index = saved.entries.findIndex(item => item.profileId === profileId);
    const entries = saved.entries.slice();
    if (index === -1) entries.push(entry); else entries[index] = entry;
    await storage.write(document({ schemaVersion: 1, entries }, secrets), checkCurrent);
    return structuredClone(next);
  }
  async function invalidate(profileIds, checkCurrent) {
    assert(Array.isArray(profileIds));
    const ids = new Set(profileIds.map(identifier));
    const saved = await storage.read();
    checkCurrent();
    const entries = saved.entries.filter(entry => !ids.has(entry.profileId));
    if (entries.length !== saved.entries.length) await storage.write({ schemaVersion: 1, entries }, checkCurrent);
  }
  return { read, write, invalidate };
}
module.exports = { createResourceSnapshotStore, profileIdentity };
