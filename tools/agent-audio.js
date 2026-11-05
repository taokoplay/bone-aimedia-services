"use strict";
const { agentExecute, schema } = require("./agent-execute.js");
function createAgentAudioTools({ access }) {
  const execute = agentExecute(access);
  return [
    { name: "generate_audio", risk: "high",
      description: "按用户授权用已配置 MiniMax 语音模型将 text 朗读为一段 MP3，可能收费。仅 operation=speech；不支持脚步、环境音效或音乐，不得将音效描述当作朗读文本。必须明确 voiceId，可先查询 audio_voices。稳定 requestKey 防止重复提交。新请求保持调用至网络/保存结束（网络上限90秒）；unknown 不得新建重试。成功后导出音频。",
      schema: schema({ operation: { type: "string", enum: ["speech"] }, text: { type: "string", minLength: 1, maxLength: 1000, description: "需要逐字朗读的文本，不是音效描述" }, voiceId: { type: "string", minLength: 1, maxLength: 128, description: "明确指定的 MiniMax 音色 ID，可通过 audio_voices 查询" }, requestKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$", description: "相同请求重试保持原值，不因超时换名" }, modelRef: { type: "string" }, speed: { type: "number", minimum: 0.5, maximum: 2 }, waitMs: { type: "integer", minimum: 0, maximum: 10000 } }, ["operation", "text", "voiceId", "requestKey"]), execute: execute("generate") },
    { name: "audio_job", risk: "low", planSafeActions: ["get", "wait", "list", "result"],
      description: "只读当前会话语音任务；wait 最多15秒，result 核对已保存 MP3 后返回元数据和导出入口，list 不含朗读文本。不联网、不生成、不返回 Base64。unknown 不代表失败或退款。",
      schema: schema({ action: { type: "string", enum: ["get", "wait", "list", "result"] }, jobId: { type: "string" }, waitMs: { type: "integer", minimum: 0, maximum: 15000 } }, ["action"]), execute: execute("query") },
    { name: "export_audio_result", risk: "medium",
      description: "导出当前会话已生成 MP3 到授权工作区 bone-media/exports。返回唯一交接文件和固定解码命令，Agent 用获准执行工具生成原始音频并核对哈希。无生成费用，不返回 Base64，不接受任意目标路径或覆盖已有文件。",
      schema: schema({ jobId: { type: "string" } }, ["jobId"]), execute: execute("exportResult") },
    { name: "audio_voices", risk: "medium",
      description: "按已配置 MiniMax 语音 modelRef 显式联网查询可用音色 ID 和名称；不生成、不修改默认音色、不返回密钥。供用户选择 generate_audio 的 voiceId。",
      schema: schema({ modelRef: { type: "string", description: "media_catalog 返回的 MiniMax 语音模型引用" } }, ["modelRef"]), execute: execute("voices") },
  ];
}
module.exports = { createAgentAudioTools };
