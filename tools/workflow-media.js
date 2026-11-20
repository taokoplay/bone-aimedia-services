"use strict";
const { agentExecute, schema } = require("./agent-execute.js");
function createWorkflowMediaTools({ access }) {
  const execute = agentExecute(access);
  return [
    { name: "generate_workflow_media", risk: "high", description: "使用已保存并显式启用的 ComfyUI API 工作流生成一项图片、视频或音频。仅提交一次，稳定 requestKey 重试不会重复提交；结果未知时必须查询原任务。", schema: schema({ workflowId: { type: "string" }, kind: { type: "string", enum: ["image", "video", "audio"] }, requestKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$" }, inputs: { type: "object" }, waitMs: { type: "integer", minimum: 0, maximum: 60000 } }, ["workflowId", "kind", "requestKey"]), execute: execute("generate") },
    { name: "workflow_job", risk: "low", planSafeActions: ["get", "list", "result", "reconcile"], description: "查询当前会话的 ComfyUI 工作流任务、等待结果或读取已保存的媒体；不创建新任务。", schema: schema({ action: { type: "string", enum: ["get", "list", "result", "reconcile"] }, jobId: { type: "string" }, expectedSha256: { type: "string" } }, ["action"]), execute: execute("query") },
    { name: "cancel_workflow_job", risk: "high", description: "取消明确仍在 ComfyUI 队列中的工作流任务。运行中的任务不会被全局中断；取消后结果和扣费状态仍需核对。", schema: schema({ jobId: { type: "string" }, confirm: { type: "boolean", enum: [true] } }, ["jobId", "confirm"]), execute: execute("cancel") },
    { name: "export_workflow_result", risk: "medium", description: "将已完成的 ComfyUI 图片、视频或音频结果交接到授权工作区 bone-media/exports/**，不重新提交任务。", schema: schema({ jobId: { type: "string" } }, ["jobId"]), execute: execute("exportResult") },
  ];
}
module.exports = { createWorkflowMediaTools };
