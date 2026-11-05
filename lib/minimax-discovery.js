"use strict";

const { assert, object } = require("./media-provider-schema.js");
const { requestJson, requestErrorDetails } = require("./media-provider-request.js");
const { entries } = require("./provider-catalog-data.js");
const { mediaKind } = require("./minimax-models.js");
function checkStatus(value) {
  if (object(value) && value.base_resp !== undefined) assert(object(value.base_resp) && value.base_resp.status_code === 0, "INVALID_RESPONSE");
}
function models(value, secret) {
  checkStatus(value);
  const raw = Array.isArray(value) ? value : object(value) ? value.data ?? value.models : null;
  assert(Array.isArray(raw), "INVALID_RESPONSE");
  const normalized = raw.map(item => {
    const id = typeof item === "string" ? item : typeof item?.id === "string" ? item.id : item?.name;
    return { id: typeof id === "string" ? id.trim() : id, name: item?.name };
  });
  return entries(normalized, secret, undefined, id => mediaKind(id) !== null).map(item => ({ ...item, kind: mediaKind(item.id) }));
}
function voices(value, secret) {
  assert(object(value), "INVALID_RESPONSE"); checkStatus(value);
  const groups = ["system_voice", "voice_cloning", "voice_generation"];
  assert(groups.some(key => value[key] !== undefined), "INVALID_RESPONSE");
  const candidates = groups.flatMap(key => {
    if (value[key] === undefined) return [];
    const items = Array.isArray(value[key]) ? value[key] : value[key]?.items;
    assert(Array.isArray(items), "INVALID_RESPONSE");
    return items.filter(object).map(item => ({ id: item.voice_id, name: item.voice_name || item.name }));
  });
  return entries(candidates, secret);
}
async function discoverMiniMax(profile, secret, request, checkCurrent, catalog) {
  assert(catalog === undefined || ["models", "voices"].includes(catalog), "INVALID_ARGUMENT");
  const selected = catalog === undefined ? ["models", "voices"] : [catalog];
  const failure = code => ({ status: "unavailable", code });
  if (!secret) return { status: "unavailable", code: "CREDENTIAL_REQUIRED", message: "A session API credential is required for catalog discovery.", models: [], voices: [], catalogs: Object.fromEntries(selected.map(kind => [kind, failure("CREDENTIAL_REQUIRED")])), checkedAt: new Date().toISOString() };
  async function collect(suffix, body, parse) {
    try {
      const value = await requestJson(profile, secret, request, checkCurrent, suffix, body);
      return { status: "connected", items: parse(value, secret) };
    } catch (error) {
      return { status: "unavailable", items: [], ...requestErrorDetails(error) };
    }
  }
  // Omitted selection preserves older combined calls. Selected calls never
  // contact the other endpoint; the per-profile pending guard still applies.
  const results = await Promise.all(selected.map(async kind => [kind, await (kind === "models"
    ? collect("/models", undefined, models)
    : collect("/get_voice", { voice_type: "all" }, voices))]));
  checkCurrent();
  const catalogs = Object.fromEntries(results.map(([kind, { items, ...status }]) => [kind, status]));
  const data = Object.fromEntries(results.map(([kind, result]) => [kind, result.items]));
  const connected = results.some(([, result]) => result.status === "connected");
  return { status: connected ? "connected" : "unavailable", message: "MiniMax catalogs are read-only; generation was not executed.",
    models: data.models || [], voices: data.voices || [], catalogs, checkedAt: new Date().toISOString(),
    ...(!connected ? { code: results[0][1].code } : {}) };
}
module.exports = { discoverMiniMax };
