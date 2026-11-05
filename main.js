"use strict";

const { createMediaProviderSettings } = require("./lib/media-provider-settings.js");
const { createKeychainSecrets } = require("./lib/keychain-secrets.js");
const dreaminaCli = require("./lib/dreamina-cli.js");
const { createDiscoveryTools, capabilities, PLUGIN_ID } = require("./tools/discovery.js");
const { createImageGeneration } = require("./lib/image-generation.js");
const { createImageTools } = require("./tools/image-generation.js");
const { createAgentImageService } = require("./lib/agent-image-service.js");
const { createAgentImageTools } = require("./tools/agent-images.js");
const { createImageResultExporter } = require("./lib/image-result-export.js");
const { keys, assert } = require("./lib/media-provider-schema.js");
const { resourceErrorDetails } = require("./lib/comfy-resource-errors.js");
const { createAudioGeneration } = require("./lib/audio-generation.js");
const { createGenerationBudget } = require("./lib/media-generation.js");
const { createAgentAudioService } = require("./lib/agent-audio-service.js");
const { createAgentAudioTools } = require("./tools/agent-audio.js");
const { createAudioResultExporter } = require("./lib/audio-result-export.js");
const { createGenerationRecords } = require("./lib/generation-records.js");
const COMMAND_ID = "bone.aimedia.services.open";
const VIEW_ID = "settings";
function error(code, message) { return Object.assign(new Error(message), { code }); }
function createPlugin(pi, createSecrets = createKeychainSecrets) {
let settings = null, images = null, agentImages = null, audio = null, agentAudio = null, records = null;
let version = "0.5.0";
let registered = [];
let registrationErrors = [];
function safeFailure(failure) {
  const messages = {
    INVALID_ARGUMENT: "配置无效，请核对地址、模型、工作流绑定和必填项。",
    CONFLICT: "配置已变化，请重新读取后核对；未覆盖当前输入。",
    STORAGE_ERROR: "配置无法安全读写。请检查插件数据目录，勿删除原文件或盲目重试。",
    NOT_FOUND: "配置或工作流不存在，请重新读取。",
    DISABLED: "请先保存并启用所选服务和工作流。",
    DISPOSED: "插件已重载，请重新读取配置；尚未完成的保存结果需核对。",
    PROBE_PENDING: "该服务正在检查，请等待当前请求完成。",
    PERMISSION_DENIED: "宿主未允许此操作，请检查插件权限。",
    SYNC_FAILED: "资源同步未完成，已保留上次成功的本地快照。",
    SYNC_UNSUPPORTED: "服务不支持此资源接口，已保留上次成功的本地快照。",
    CREDENTIAL_UNAVAILABLE: "当前系统无法使用插件密钥存储；此版本支持 macOS 钥匙串，原配置已保留。",
    CREDENTIAL_ERROR: "密钥无法安全保存或恢复，请检查登录钥匙串是否解锁、允许访问；原配置已保留。",
    CREDENTIAL_LEGACY: "配置使用旧版宿主加密格式，需要原加密环境才能恢复；原文件已保留。",
    GENERATION_UNSUPPORTED: "请选择已配置的 GPT 图片或 MiniMax 语音模型；当前不支持环境音效。",
    GENERATION_BUSY: "已有生成任务占用并发名额，请等待后再提交。",
    GENERATION_LIMIT: "本地生成记录已达到容量上限，未提交新的生成请求。",
    GENERATION_UNKNOWN: "生成结果尚不确定，请先检查供应商记录，勿直接重复生成。",
    GENERATION_REQUEST_CONFLICT: "任务参数与已准备请求不一致，请重新核对。",
    RESULT_INVALID: "媒体文件校验未通过，未作为成功结果保存。",
    RESULT_UNAVAILABLE: "当前没有可读取的媒体结果。",
    CREDENTIAL_REQUIRED: "请先保存所选服务的 API Key。",
  };
  if (!Object.hasOwn(messages, failure?.code) && resourceErrorDetails(failure).code === failure?.code) {
    return error(failure.code, "资源读取未完成，请检查具体错误后重试。");
  }
  const code = Object.hasOwn(messages, failure?.code) ? failure.code : "UNAVAILABLE";
  return error(code, messages[code] || "媒体服务操作未完成，请核对配置和宿主权限。");
}
async function access(method, payload) {
  const current = settings;
  if (!current) throw error("UNAVAILABLE", "媒体配置服务尚未加载。");
  try { return await current[method](payload); } catch (failure) { throw safeFailure(failure); }
}
async function imageAccess(method, payload) {
  const current = images;
  if (!current) throw error("UNAVAILABLE", "生图服务尚未加载。");
  try { return await current[method](payload); } catch (failure) { throw safeFailure(failure); }
}
async function audioAccess(method, payload) {
  const current = audio;
  if (!current) throw error("UNAVAILABLE", "语音服务尚未加载。");
  try { return await current[method](payload); } catch (failure) { throw safeFailure(failure); }
}
async function recordsAccess(method, payload) {
  const current = records;
  if (!current) throw error("UNAVAILABLE", "生成记录尚未加载。");
  try { return await current[method](payload); } catch (failure) { throw safeFailure(failure); }
}
async function agentAudioAccess(method, payload, ctx) {
  const current = agentAudio;
  if (!current) throw error("DISPOSED", "Agent audio service is not loaded.");
  return current[method](payload, ctx);
}
async function agentAccess(method, payload, ctx) {
  const current = agentImages;
  if (!current) throw error("DISPOSED", "Agent image service is not loaded.");
  return current[method](payload, ctx);
}
const tools = [...createDiscoveryTools({ read: () => access("read"), getVersion: () => version }), ...createImageTools({ access: imageAccess }), ...createAgentImageTools({ access: agentAccess }), ...createAgentAudioTools({ access: agentAudioAccess })];
async function clearRuntime() {
  const old = settings, oldImages = images, oldAgent = agentImages, oldAudio = audio, oldAgentAudio = agentAudio;
  settings = null; images = null; agentImages = null; audio = null; agentAudio = null; records = null;
  oldAgent?.dispose(); oldAgentAudio?.dispose();
  try { await Promise.all([oldImages?.dispose(), oldAudio?.dispose()]); } finally { await old?.dispose(); }
  if (typeof pi.agent?.unregisterTool === "function") {
    for (const name of registered) {
      try { await pi.agent.unregisterTool(name); } catch { registrationErrors.push(`无法注销工具：${name}`); }
    }
  }
  registered = [];
}
async function onLoad() {
  await clearRuntime(); registrationErrors = [];
  const dataPath = await pi.plugin.getDataPath();
  const manifest = await pi.plugin.getManifest();
  version = String(manifest.version);
  const request = input => {
    if (typeof pi.net?.fetch !== "function") throw error("PERMISSION_DENIED", "Host network API unavailable");
    return pi.net.fetch(input);
  };
  settings = createMediaProviderSettings({ getDataPath: () => dataPath, secrets: createSecrets({ getDataPath: () => dataPath }), request });
  const budget = createGenerationBudget(2);
  images = createImageGeneration({ getDataPath: () => dataPath, settings, request, budget });
  audio = createAudioGeneration({ getDataPath: () => dataPath, settings, request, budget });
  agentImages = createAgentImageService({ settings, images, exporter: createImageResultExporter({ host: pi, readResult: images.resultBytes }) });
  agentAudio = createAgentAudioService({ settings, audio, exporter: createAudioResultExporter({ host: pi, readResult: audio.resultBytes }) });
  records = createGenerationRecords({ images, audio });
  await pi.commands.register({ id: COMMAND_ID, title: "Bone AI 媒体服务: 打开配置", keywords: ["bone", "aimedia", "媒体", "图片", "视频", "配音"],
    run: async () => pi.ui.revealView({ viewId: VIEW_ID }) });
  if (typeof pi.agent?.registerTool !== "function") registrationErrors.push("宿主未提供 Agent 工具注册能力。");
  else for (const tool of tools) {
    try { await pi.agent.registerTool(tool); registered.push(tool.name); }
    catch { registrationErrors.push(`工具注册失败：${tool.name}`); }
  }
}
async function onUnload() {
  await clearRuntime();
  try { await pi.commands.unregister(COMMAND_ID); } catch { registrationErrors.push("打开配置命令未能注销。"); }
}
async function dispatchPanel(channel, payload) {
  switch (channel) {
    case "aimedia.audio.prepare": return audioAccess("prepare", payload);
    case "aimedia.audio.submit": return audioAccess("submit", payload);
    case "aimedia.audio.get": return audioAccess("get", payload);
    case "aimedia.audio.list": return audioAccess("list", payload);
    case "aimedia.audio.read": return audioAccess("readResult", payload);
    case "aimedia.records.list": return recordsAccess("list", payload);
    case "aimedia.records.get": return recordsAccess("get", payload);
    case "aimedia.records.read": return recordsAccess("read", payload);
    case "aimedia.image.prepare": return imageAccess("prepare", payload);
    case "aimedia.image.submit": return imageAccess("submit", payload);
    case "aimedia.image.get": return imageAccess("get", payload);
    case "aimedia.image.list": return imageAccess("list", payload);
    case "aimedia.image.read": return imageAccess("readResult", payload);
    case "aimedia.get": return access("read");
    case "aimedia.save": return access("save", payload);
    case "aimedia.probe": return access("probe", payload);
    case "aimedia.browse": return access("browse", payload);
    case "aimedia.resourceSnapshot": return access("resourceSnapshot", payload);
    case "aimedia.syncResources": return access("syncResources", payload);
    case "aimedia.readResourceWorkflow": return access("readResourceWorkflow", payload);
    case "aimedia.capabilities": return capabilities(await access("read"), version, registered.includes("get_capabilities"));
    case "aimedia.status": return { pluginId: PLUGIN_ID, version, panelProtocol: 1, tools: [...registered], errors: [...registrationErrors], generationImplemented: true };
    case "aimedia.dreamina.status": return dreaminaCli.getDreaminaStatus(payload?.cliPath);
    case "aimedia.dreamina.loginStart": return dreaminaCli.startDreaminaLogin(payload?.cliPath);
    case "aimedia.dreamina.loginPoll": return dreaminaCli.checkDreaminaLogin(payload?.cliPath, payload?.deviceCode);
    case "aimedia.dreamina.logout": return dreaminaCli.logoutDreamina(payload?.cliPath);
    case "aimedia.dreamina.models": return dreaminaCli.getDreaminaCloudModels();
    default: throw error("NOT_FOUND", "未知媒体配置接口。");
  }
}
async function onPanelInvoke(channel, payload) {
  if (channel !== "aimedia.invoke") return dispatchPanel(channel, payload);
  // Electron invoke/contextBridge may discard custom properties on Error.
  // Keep business failures in a JSON result, separate from transport failures.
  try {
    keys(payload, ["channel", "payload"]);
    assert(typeof payload.channel === "string" && payload.channel.startsWith("aimedia.") && payload.channel !== "aimedia.invoke");
    const result = await dispatchPanel(payload.channel, payload.payload);
    return { protocol: "aimedia.panel.v1", ok: true, result: result ?? null };
  } catch (failure) {
    return { protocol: "aimedia.panel.v1", ok: false, error: { code: safeFailure(failure).code } };
  }
}
return { onLoad, onUnload, onPanelInvoke };
}
let runtime;
module.exports = {
  createPlugin,
  async onLoad() { await runtime?.onUnload(); runtime = createPlugin(pi); return runtime.onLoad(); },
  async onUnload() { const previous = runtime; runtime = undefined; return previous?.onUnload(); },
  onPanelInvoke(channel, payload) { if (!runtime) throw error("UNAVAILABLE", "媒体配置服务尚未加载。"); return runtime.onPanelInvoke(channel, payload); },
};
