"use strict";
const { agentExecute, schema } = require("./agent-execute.js");

function createAgentRecordTools({ access }) {
  const execute = agentExecute(access);
  return [{
    name: "delete_generation_records",
    risk: "high",
    description: "永久删除指定的本地图片、音频或 ComfyUI 生成记录及其私有结果文件；不会取消供应商任务。必须明确提供记录 kind、jobId 和 confirm=true。仍在提交、状态未知或结果待恢复的任务会被拒绝删除。",
    schema: schema({
      records: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["image", "audio", "workflow"] },
            jobId: { type: "string", minLength: 1 },
          },
          required: ["kind", "jobId"],
          additionalProperties: false,
        },
      },
      confirm: { type: "boolean", enum: [true] },
    }, ["records", "confirm"]),
    execute: execute("delete"),
  }];
}

module.exports = { createAgentRecordTools };
