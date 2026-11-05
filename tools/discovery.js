"use strict";

const PLUGIN_ID = "bone.aimedia.services";
const kinds = ["image", "video", "audio"];
function input(value) {
  const args = value === undefined ? {} : value;
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => k !== "kind") || (args.kind !== undefined && !kinds.includes(args.kind))) {
    throw Object.assign(new Error("kind must be image, video or audio when supplied"), { code: "INVALID_ARGUMENT" });
  }
  return args;
}
function profileSummary(profile) {
  const probe = profile.lastProbe;
  return { id: profile.id, name: profile.name, provider: profile.provider, enabled: profile.enabled,
    baseUrl: profile.baseUrl, models: structuredClone(profile.models), modelId: profile.modelId,
    voice: profile.voice, format: profile.format, credentialConfigured: profile.credentialConfigured,
    connection: probe ? { status: probe.connectionStatus || probe.status, checkedAt: probe.checkedAt, scope: structuredClone(probe.scope) } : { status: "not-checked" },
    ...(probe?.scope?.kind === "workflow" ? { workflowCheck: { workflowId: probe.scope.workflowId, compatible: probe.workflowCompatible ?? null, status: probe.status } } : {}) };
}
function workflowSummary(workflow) {
  return { id: workflow.id, name: workflow.name, kind: workflow.kind, enabled: workflow.enabled,
    connectionId: workflow.connectionId, nodeCount: Object.keys(workflow.definition || {}).length,
    bindingCount: (workflow.bindings || []).length };
}
function capabilities(snapshot, version, toolReachable = true) {
  const configured = snapshot.profiles.filter(p => p.enabled);
  const operations = [
    ["image.generate", "image"], ["image.edit", "image"], ["video.text", "video"],
    ["video.image", "video"], ["video.first-last", "video"], ["audio.speech", "audio"],
    ["audio.effects", "audio"], ["audio.music", "audio"], ["workflow.run", null],
  ].map(([id, kind]) => ({ id, kind, execution: "configuration-only", ready: false,
    blockedBy: ["generation-adapter-not-implemented"],
    configuredProfiles: configured.filter(p => id === "workflow.run" ? p.provider === "comfyui" : snapshot.catalog.find(c => c.id === p.provider)?.kinds.includes(kind)).map(p => p.id) }));
  const imageProfiles = configured.filter(profile => profile.provider === "openai" && profile.credentialConfigured && profile.models.some(model => model.kind === "image" && /^gpt-image-/.test(model.id)));
  Object.assign(operations[0], { execution: "native", ready: imageProfiles.length > 0,
    blockedBy: imageProfiles.length ? [] : ["enabled-gpt-model-and-credential-required"],
    configuredProfiles: imageProfiles.map(profile => profile.id),
    constraints: { maxOutputs: 1, format: "png", sizes: ["1024x1024", "1536x1024", "1024x1536"], qualities: ["low", "medium", "high"], maxImageBytes: 16777216, resultTransport: "base64-only", requiresExplicitSubmit: true, price: "unknown" } });
  return { pluginId: PLUGIN_ID, pluginVersion: version, contractVersion: 1,
    stage: "gpt-image-generation-and-discovery", toolReachable, configRevision: snapshot.revision,
    generationImplemented: true, operations, defaults: { ...snapshot.defaults },
    agentWorkflow: { catalogTool: "media_catalog", generationTool: "generate_image", jobTool: "image_job", exportTool: "export_image_result", submissionWait: "until-request-settles", requestTimeoutMs: 90000, maxGenerateWaitMs: 100000, maxExistingJobWaitMs: 10000, maxJobWaitMs: 15000, maxInlineBytes: 4194304, jobScope: "calling-session", exportScope: "bone-media/exports/**" },
    credentialStorage: "macos-keychain-encrypted-plugin-private",
    credentialStorageStatus: structuredClone(snapshot.credentialStorageStatus || { backend: "macos-keychain", supported: false, access: "unchecked" }), automaticNetwork: false,
    singletonProviders: ["dreamina", "libtv"],
    singletonConflicts: structuredClone(snapshot.singletonConflicts || []),
    remoteInspection: { provider: "comfyui", transport: "panel-explicit-read-only", resources: ["model-folders", "models", "workflows", "workflow", "history", "queue"],
      taskOwnership: "server-wide-unknown", generationImplemented: false },
    observation: "Provider discovery verifies only catalog/node access; actual media review belongs to Agent and requires observation evidence.",
    limitations: ["Only GPT text-to-image PNG generation is implemented; image editing, video, audio and workflow execution remain unavailable.",
      "Prepared jobs are local. Submission can incur provider charges; uncertain outcomes are never automatically retried.",
      "URL-only image replies remain unavailable. Typed image results are bounded; original-file export requires the declared workspace scope and an Agent-authorized decoder.",
      "Dreamina CLI and LibTV MCP sign-in remain external; this plugin does not execute them.",
      "This response establishes this tool's reachability, not installation/enabled status of other plugins."] };
}
function createDiscoveryTools({ read, getVersion }) {
  const filters = { type: "object", properties: { kind: { type: "string", enum: kinds, description: "可选媒体类型；省略返回全部" } }, required: [], additionalProperties: false };
  return [
    { name: "get_capabilities", risk: "low", description: "读取媒体服务的实际执行能力、GPT 文生图约束和配置状态；不联网、不返回密钥、不生成。已配置不等于供应商实测通过。",
      schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      execute: async args => { input(args); if (args?.kind !== undefined) throw Object.assign(new Error("No arguments accepted"), { code: "INVALID_ARGUMENT" }); return capabilities(await read(), getVersion()); } },
    { name: "list_profiles", risk: "low", description: "只读列出媒体服务与模型配置、默认项和加密凭据是否已设置。不返回密钥，不探测网络；配置或目录可达不等于生成可用。",
      schema: filters, execute: async args => { const { kind } = input(args); const snapshot = await read(); return { pluginId: PLUGIN_ID, revision: snapshot.revision,
        defaults: { ...snapshot.defaults }, singletonConflicts: structuredClone(snapshot.singletonConflicts || []), profiles: snapshot.profiles.filter(p => !kind || snapshot.catalog.find(c => c.id === p.provider)?.kinds.includes(kind)).map(profileSummary) }; } },
    { name: "list_workflows", risk: "low", description: "只读列出本地 ComfyUI 工作流摘要与连接引用，不返回工作流正文，不执行或验证远端工作流。",
      schema: filters, execute: async args => { const { kind } = input(args); const snapshot = await read(); return { pluginId: PLUGIN_ID, revision: snapshot.revision,
        workflows: (snapshot.workflows || []).filter(w => !kind || w.kind === kind).map(workflowSummary) }; } },
  ];
}
module.exports = { PLUGIN_ID, capabilities, createDiscoveryTools };
