"use strict";
function createImageTools({ access }) {
  const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  const string = description => ({ type: "string", description });
  return [
    { name: "prepare_image", risk: "medium", description: "准备一张 GPT 文生图请求并持久化参数；不联网、不收费。必须指定已保存服务、配置版本和该服务的 GPT 图片模型。返回任务 ID 和请求哈希供确认。",
      schema: object({ requestId: string("每次新请求生成 UUID v4；相同请求重试使用原 UUID"), profileId: string("已启用的 OpenAI 服务 ID"), expectedRevision: { type: "integer", minimum: 0 }, modelId: string("已配置的 gpt-image-* 模型 ID"), prompt: { type: "string", minLength: 1, maxLength: 8000 }, size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"] }, quality: { type: "string", enum: ["low", "medium", "high"] } }),
      execute: input => access("prepare", input) },
    { name: "submit_image", risk: "high", description: "按准备好的任务提交一次 GPT 生图，可能收费；须已有用户授权并传 confirm=true。保持调用直至本次请求结束并保存结果，网络上限90秒。同一任务不会重复生成。超时或 unknown 不得盲目新建重试。",
      schema: object({ jobId: string("prepare_image 返回的任务 ID"), requestHash: string("准备阶段返回的精确请求哈希"), confirm: { type: "boolean", enum: [true] } }),
      execute: input => access("submitAndWait", input) },
    { name: "get_image_job", risk: "low", description: "只读本地 GPT 生图任务状态与结果元数据；不联网、不重新提交。unknown 表示结果与扣费尚不确定，不代表失败或退款。",
      schema: object({ jobId: string("任务 ID") }), execute: input => access("get", input) },
    { name: "list_image_jobs", risk: "low", description: "只读列出本插件的 GPT 生图记录，不读取 ComfyUI 服务端任务、不返回凭据或私有路径。",
      schema: object({}), execute: input => access("list", input) },
    { name: "read_image_result", risk: "low", description: "分块读取已成功生成并验证的 PNG，每次最多 64 KiB 的 Base64；校验结果哈希，无网络请求。Agent 用自身获准的文件工具保存，不读取插件私有目录。",
      schema: object({ jobId: string("成功任务 ID"), expectedSha256: string("任务结果的 SHA-256"), offset: { type: "integer", minimum: 0, description: "字节偏移，从 0 开始，后续使用 nextOffset" } }), execute: input => access("readResult", input) },
  ];
}
module.exports = { createImageTools };
