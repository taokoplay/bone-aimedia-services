"use strict";

const { assert } = require("./media-provider-schema.js");
function safeId(value, secret) { return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) && (!secret || !value.includes(secret)) && !/^(?:https?|bearer):/i.test(value); }
function safeName(value, fallback, secret) { return typeof value === "string" && value.length <= 256 && !/[\x00-\x1f\x7f]|https?:\/\/|bearer\s/i.test(value) && (!secret || !value.includes(secret)) ? value : fallback; }
function entries(items, secret, kind, filterFn) {
  assert(Array.isArray(items), "INVALID_RESPONSE", "Provider discovery response was invalid.");
  const seen = new Set(); const output = [];
  for (const item of items) {
    if (output.length >= 100) break;
    const id = typeof item === "string" ? item : item?.id;
    if (!safeId(id, secret) || seen.has(id)) continue;
    if (filterFn && !filterFn(id)) continue;
    seen.add(id); output.push({ id, name: safeName(item?.name, id, secret), ...(kind ? { kind } : {}) });
  }
  return output;
}
module.exports = { safeId, entries };
