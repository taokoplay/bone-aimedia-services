"use strict";

const { object } = require("./media-provider-schema.js");

const CONNECTION_TYPES = new Set([
  "AUDIO", "BBOX", "CLIP", "CLIP_VISION", "CLIP_VISION_OUTPUT", "CONDITIONING", "CONTROL_NET",
  "GUIDER", "IMAGE", "LATENT", "LORA", "MASK", "MODEL", "NOISE", "SAMPLER", "SEGS", "SIGMAS",
  "STYLE_MODEL", "UPSCALE_MODEL", "VAE",
]);
const MAX_ISSUES = 64;

function issue(code, message, nodeId, input) {
  return { code, message, ...(nodeId === undefined ? {} : { nodeId: String(nodeId) }), ...(input === undefined ? {} : { input: String(input) }) };
}
function safeName(value, fallback = "unknown") {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}
function objectInfoInputs(info) {
  if (!object(info) || !object(info.input)) return null;
  const result = [];
  for (const [section, required] of [["required", true], ["optional", false]]) {
    const fields = info.input[section];
    if (fields === undefined) continue;
    if (!object(fields)) return null;
    for (const [name, spec] of Object.entries(fields)) {
      if (!Array.isArray(spec) || spec.length === 0) return null;
      const config = object(spec[1]) ? spec[1] : {};
      result.push({ name, required, type: spec[0], config });
    }
  }
  return result;
}
function isWidgetInput(item) {
  if (item.config.forceInput === true || item.config.lazy === true) return false;
  if (Array.isArray(item.type)) return true;
  if (typeof item.type !== "string") return false;
  const type = item.type.toUpperCase();
  if (CONNECTION_TYPES.has(type) || type === "*") return false;
  return true;
}
function linkRecord(value) {
  if (Array.isArray(value) && value.length >= 5) return { id: value[0], originId: value[1], originSlot: value[2], targetId: value[3], targetSlot: value[4] };
  if (object(value)) return { id: value.id, originId: value.origin_id ?? value.originId, originSlot: value.origin_slot ?? value.originSlot, targetId: value.target_id ?? value.targetId, targetSlot: value.target_slot ?? value.targetSlot };
  return null;
}
function defaultValue(item) {
  return Object.hasOwn(item.config, "default") ? item.config.default : undefined;
}
function convertCanvasWorkflow(canvas, nodeInfo) {
  const issues = [];
  if (!object(canvas) || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.links)) {
    return { ok: false, issues: [issue("CANVAS_STRUCTURE_INVALID", "Canvas workflow nodes or links are invalid.")] };
  }
  const nodes = canvas.nodes;
  const nodeIds = new Set();
  const links = new Map();
  for (const rawLink of canvas.links) {
    const link = linkRecord(rawLink);
    if (!link || link.id === undefined || link.originId === undefined || !Number.isSafeInteger(Number(link.originSlot))) {
      issues.push(issue("CANVAS_LINK_INVALID", "A canvas link cannot be mapped safely."));
      continue;
    }
    links.set(String(link.id), link);
  }
  const definition = {};
  for (const node of nodes) {
    const nodeId = node?.id;
    const nodeKey = typeof nodeId === "number" && Number.isSafeInteger(nodeId) || typeof nodeId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(nodeId) ? String(nodeId) : null;
    const classType = safeName(node?.type, "");
    if (!nodeKey || !classType) {
      issues.push(issue("CANVAS_NODE_INVALID", "A canvas node has no safe id or class type."));
      continue;
    }
    if (nodeIds.has(nodeKey)) {
      issues.push(issue("CANVAS_NODE_DUPLICATE", "Canvas contains duplicate node ids.", nodeKey));
      continue;
    }
    nodeIds.add(nodeKey);
    if (node.mode !== undefined && node.mode !== 0) {
      issues.push(issue("CANVAS_NODE_MODE_UNSUPPORTED", "Disabled or bypassed canvas nodes are not converted.", nodeKey));
      continue;
    }
    const info = nodeInfo?.[classType];
    const inputItems = objectInfoInputs(info);
    if (!inputItems) {
      issues.push(issue("CANVAS_NODE_INFO_MISSING", `ComfyUI node metadata is unavailable for ${classType}.`, nodeKey));
      continue;
    }
    const canvasInputs = Array.isArray(node.inputs) ? node.inputs : [];
    const linked = new Map();
    for (const canvasInput of canvasInputs) {
      if (!canvasInput || typeof canvasInput.name !== "string") {
        issues.push(issue("CANVAS_INPUT_INVALID", "A canvas input has no safe name.", nodeKey));
        continue;
      }
      if (canvasInput.link === null || canvasInput.link === undefined) continue;
      const link = links.get(String(canvasInput.link));
      if (!link || String(link.targetId) !== nodeKey || String(link.targetSlot) !== String(canvasInputs.indexOf(canvasInput))) {
        issues.push(issue("CANVAS_LINK_TARGET_INVALID", "A canvas link target cannot be verified.", nodeKey, canvasInput.name));
        continue;
      }
      linked.set(canvasInput.name, [String(link.originId), Number(link.originSlot)]);
    }
    const inputs = {};
    for (const [name, value] of linked) inputs[name] = value;
    const widgetItems = inputItems.filter(isWidgetInput).filter(item => !linked.has(item.name));
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    let valueIndex = 0;
    for (const item of widgetItems) {
      if (valueIndex < values.length) {
        inputs[item.name] = values[valueIndex++];
        continue;
      }
      const fallback = defaultValue(item);
      if (fallback !== undefined) {
        inputs[item.name] = structuredClone(fallback);
      } else if (item.required) {
        issues.push(issue("CANVAS_WIDGET_MISSING", `A required widget value is missing for ${classType}.`, nodeKey, item.name));
      }
    }
    if (valueIndex < values.length) issues.push(issue("CANVAS_WIDGET_UNMAPPED", `Canvas contains ${values.length - valueIndex} widget value(s) that cannot be mapped for ${classType}.`, nodeKey));
    for (const item of inputItems) {
      if (!isWidgetInput(item) && item.required && !linked.has(item.name)) issues.push(issue("CANVAS_INPUT_UNLINKED", `A required connection is not linked for ${classType}.`, nodeKey, item.name));
    }
    const title = safeName(node.title || node.properties?.["Node name for S&R"], "");
    definition[nodeKey] = { class_type: classType, inputs, ...(title ? { _meta: { title } } : {}) };
  }
  if (issues.length) return { ok: false, issues: issues.slice(0, MAX_ISSUES) };
  return { ok: true, definition, issues: [] };
}

module.exports = { convertCanvasWorkflow, objectInfoInputs, isWidgetInput };
