"use strict";
const { agentExecute, schema } = require("./agent-execute.js");
function createAgentImageTools({ access }) {
  const execute = agentExecute(access);
  return [
    { name: "media_catalog", risk: "low", planSafeActions: ["list"],
      description: "查询本插件已配置的媒体模型、稳定 modelRef、默认项、参数范围与不可用原因。Agent 生图或语音生成先调用此工具。只读、不联网、不返回密钥；配置可用不等于供应商实测通过。",
      schema: schema({ action: { type: "string", enum: ["list"] }, kind: { type: "string", enum: ["image", "video", "audio"] } }, ["action"]), execute: execute("catalog") },
    { name: "generate_image", risk: "high",
      description: "按用户已授权的要求，用已配置 GPT 模型生成一张 PNG。可能收费；无需面板。modelRef 可指定模型，省略按会话选择、默认、唯一候选解析。相同 requestKey 重试不重复生成。新提交保持调用直到请求结束（网络上限90秒）并保存结果；waitMs 仅用于已有任务的本地等待。完成返回图片，否则返回原任务状态，unknown 不得盲目新建重试。",
      schema: schema({ prompt: { type: "string", minLength: 1, maxLength: 8000 }, requestKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$", description: "稳定请求名，如 blue-cup-1；相同请求重试不变，不能因超时更换" }, modelRef: { type: "string", description: "media_catalog 返回的完整 modelRef；用户指定模型时必须提供" }, size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"] }, quality: { type: "string", enum: ["low", "medium", "high"] }, waitMs: { type: "integer", minimum: 0, maximum: 10000, description: "已有任务的本地等待；不截断本次新提交的网络请求" } }, ["prompt", "requestKey"]), execute: execute("generate") },
    { name: "image_job", risk: "low", planSafeActions: ["get", "wait", "list", "result"],
      description: "读取当前会话的既有生图任务；wait 有限等待最多15秒，result 返回已验证图片内容块（大图提示导出），list 不含提示词。全部为本地只读，不重新提交。unknown 不代表失败或退款，不能盲目新建重试。",
      schema: schema({ action: { type: "string", enum: ["get", "wait", "list", "result"] }, jobId: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 15000 } }, ["action"]), execute: execute("query") },
    { name: "export_image_result", risk: "medium",
      description: "将当前会话已生成图片写入授权工作区 bone-media/exports 下的唯一交接文件，返回解码命令和哈希；Agent 用自身获准的执行工具生成原始 PNG。无生成费用，不返回 Base64 文本，不允许任意目标路径或覆盖现有 PNG。缺少工作区或权限时导出单独报错。",
      schema: schema({ jobId: { type: "string" } }, ["jobId"]), execute: execute("exportResult") },
  ];
}
module.exports = { createAgentImageTools };
