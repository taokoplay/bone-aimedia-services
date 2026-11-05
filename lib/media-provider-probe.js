"use strict";

const { assert, object } = require("./media-provider-schema.js");
const { requestJson, safeCodes, requestErrorDetails } = require("./media-provider-request.js");
function result(status, message, models = [], extra = {}) { return { status, message, models, checkedAt: new Date().toISOString(), ...extra }; }
const { safeId, entries } = require("./provider-catalog-data.js");
const { discoverMiniMax } = require("./minimax-discovery.js");
function isImageModel(id) {
  if (typeof id !== "string") return false;
  const lower = id.toLowerCase();
  if (/(?:image|dall[-_.]?e|flare|sunburst|flux|midjourney|mj[-_]|sd[-_]|stable[-_]?diffusion|cogview|kolors|wanx|recraft|ideogram|kling|hailuo|luma|seedance)/i.test(lower)) {
    return true;
  }
  const isChatOrText = /^(?:gpt-(?:3|4|3\.5)|claude|chatgpt|deepseek|qwen|glm|baichuan|llama|mistral|yi-|moonshot|text-|babbage|davinci|curie|embedding|whisper|tts|rerank|moderation|o1-|o3-)/i.test(lower);
  if (isChatOrText) return false;
  if (/[-_](?:chat|instruct|completion|embedding|search)$/i.test(lower)) return false;
  return true;
}
async function discover(profile, secret, request, checkCurrent, catalog) {
  if (profile.provider === "dreamina") return result("unsupported", "Configure the Dreamina CLI path and authenticate in its own CLI. CLI execution and runtime model verification are not supported here.");
  if (profile.provider === "libtv") return result("unsupported", "Configure https://mcp.liblib.tv/mcp as an external MCP server in the host. No built-in HTTP discovery adapter is available.");
  if (profile.provider === "minimax") return discoverMiniMax(profile, secret, request, checkCurrent, catalog);
  if (profile.provider !== "comfyui" && !secret) return result("unavailable", "A session API credential is required for catalog discovery.");
  let endpoint = "system_stats", systemVerified = false;
  async function json(suffix, body) {
    const parsed = await requestJson(profile, secret, request, checkCurrent, suffix, body);
    assert(object(parsed), "INVALID_RESPONSE", "Provider discovery response was invalid.");
    return parsed;
  }
  try {
    if (profile.provider === "comfyui") {
      const stats = await json("/system_stats");
      // Device details are optional, but an arbitrary JSON/error object must
      // never be accepted as a ComfyUI system response.
      assert(object(stats.system) && (stats.devices === undefined || Array.isArray(stats.devices) && stats.devices.length <= 100 && stats.devices.every(object)), "INVALID_RESPONSE");
      systemVerified = true;
      if (!profile.workflow) {
        return result("connected", "ComfyUI system status is accessible. No workflow compatibility check was requested.", [], { nodeTypes: [], connectionStatus: "connected", workflowCompatible: null });
      }
      endpoint = "object_info";
      const nodes = await json("/object_info");
      const names = Object.keys(nodes);
      assert(names.length > 0 && names.length <= 20000 && names.every(name => object(nodes[name]) && object(nodes[name].input)), "INVALID_RESPONSE");
      const missing = Object.values(profile.workflow).some(node => !Object.hasOwn(nodes, node.class_type));
      const nodeTypes = names.filter(name => safeId(name, secret)).slice(0, 300);
      return result(missing ? "unavailable" : "connected", missing ? "Workflow requires node types that are missing from this ComfyUI server." : "ComfyUI system and node metadata are accessible. No workflow was executed.", [], { nodeTypes, connectionStatus: "connected", workflowCompatible: !missing });
    }
    const data = await json("/models");
    const rawItems = data.data === undefined ? data.models : data.data;
    const isOp = profile.provider === "openai";
    return result("connected", "Model catalog is accessible only; this does not verify generation capability.", entries(rawItems, secret, isOp ? "image" : (profile.provider === "xiaomi" ? "audio" : undefined), isOp ? isImageModel : undefined));
  } catch (error) {
    checkCurrent();
    const details = profile.provider === "comfyui" ? { ...requestErrorDetails(error), endpoint,
      ...(systemVerified ? { connectionStatus: "connected", workflowCompatible: null } : {}) } : {};
    if (safeCodes.has(error?.code)) return result("unavailable", "Host permission denied the discovery request. Review the plugin network permission.", [], { ...details, code: error.code });
    return result("unavailable", "Provider discovery failed or returned an invalid response. Check configuration and host network permissions.", [], details);
  }
}
module.exports = { discover };
