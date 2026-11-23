"use strict";
const { agentExecute, schema } = require("./agent-execute.js");
const { referenceImagesSchema } = require("../lib/image-reference-schema.js");
function createWorkflowMediaTools({ access }) {
  const execute = agentExecute(access);
  return [
    { name: "generate_workflow_media", risk: "high", description: "使用已同步的 ComfyUI API 工作流生成一项图片、视频或音频；本地模式使用 workflowId，远端模式使用 profileId 配合 remotePath、唯一 remoteName 或 list_remote_workflows 返回的 remoteWorkflowId。远端 Canvas 仅预览，图生视频会先将已暂存参考图上传到 ComfyUI，再把返回的安全文件引用填入克隆工作流。仅提交一次，稳定 requestKey 重试不会重复提交；结果未知时必须查询原任务。", schema: schema({ workflowId: { type: "string" }, profileId: { type: "string" }, remotePath: { type: "string", maxLength: 2048 }, remoteName: { type: "string", maxLength: 128 }, remoteWorkflowId: { type: "string", pattern: "^remote-[a-f0-9]{32}$" }, kind: { type: "string", enum: ["image", "video", "audio"] }, requestKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$" }, inputs: { type: "object" }, referenceImages: referenceImagesSchema, waitMs: { type: "integer", minimum: 0, maximum: 60000 } }, ["kind", "requestKey"]), execute: execute("generate") },
    { name: "list_remote_workflows", risk: "low", description: "只读列出已同步快照中的 ComfyUI 远端工作流名称、稳定 ID、路径、格式、内容哈希和字段匹配候选；唯一名称可用于 remoteName，重复名称必须使用路径或稳定 ID。API 格式可直接调用，Canvas 格式仅预览。不会联网读取未同步内容、返回凭据或暴露默认输入值。", schema: schema({ profileId: { type: "string" }, expectedRevision: { type: "integer", minimum: 0 }, kind: { type: "string", enum: ["image", "video", "audio"] } }, ["profileId", "expectedRevision"]), execute: execute("listRemote") },
    { name: "workflow_job", risk: "low", planSafeActions: ["get", "list", "result", "reconcile"], description: "查询当前会话的 ComfyUI 工作流任务、等待结果或读取已保存的媒体；不创建新任务。", schema: schema({ action: { type: "string", enum: ["get", "list", "result", "reconcile"] }, jobId: { type: "string" }, expectedSha256: { type: "string" } }, ["action"]), execute: execute("query") },
    { name: "cancel_workflow_job", risk: "high", description: "取消明确仍在 ComfyUI 队列中的工作流任务。运行中的任务不会被全局中断；取消后结果和扣费状态仍需核对。", schema: schema({ jobId: { type: "string" }, confirm: { type: "boolean", enum: [true] } }, ["jobId", "confirm"]), execute: execute("cancel") },
    { name: "export_workflow_result", risk: "medium", description: "将已完成的 ComfyUI 图片、视频或音频结果交接到授权工作区 bone-media/exports/**，不重新提交任务。", schema: schema({ jobId: { type: "string" } }, ["jobId"]), execute: execute("exportResult") },
  ];
}
module.exports = { createWorkflowMediaTools };
