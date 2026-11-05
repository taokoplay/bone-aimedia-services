"use strict";

const { builtinModels: minimaxBuiltinModels } = require("./minimax-models.js");
const model = (id, kind) => ({ id, name: id, kind });
const catalog = [
  { id: "dreamina", name: "即梦 Dreamina", kinds: ["image", "video"], transport: "cli", defaultBaseUrl: "", defaultModels: [model("5.0", "image"), model("seedance2.0", "video")], description: "配置本机 CLI 与图片／视频模型。模型名称仅供配置参考，实际支持范围以当前 CLI 为准。", probeLabel: "查看 CLI 接入说明" },
  { id: "openai", name: "OpenAI 图片生成", kinds: ["image"], transport: "http", defaultBaseUrl: "https://api.openai.com/v1", defaultModels: [{ id: "gpt-image-2", name: "GPT Image 2", kind: "image" }, { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", kind: "image" }, { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", kind: "image" }, { id: "gpt-image-2.5", name: "GPT Image 2.5", kind: "image" }, { id: "gpt-image-1", name: "GPT Image 1", kind: "image" }, { id: "gpt-image-1-mini", name: "GPT Image 1 mini", kind: "image" }, { id: "dall-e-3", name: "DALL·E 3", kind: "image" }, { id: "dall-e-2", name: "DALL·E 2", kind: "image" }], description: "仅用于图片和媒体生成，不提供聊天或通用文本对话能力。模型目录可访问不代表生成能力已验证。", probeLabel: "检查图片模型目录" },
  { id: "minimax", name: "MiniMax", kinds: ["image", "video", "audio"], transport: "http", defaultBaseUrl: "https://api.minimax.cn/v1", defaultModels: [model("image-01", "image"), model("MiniMax-Hailuo-2.3", "video"), model("speech-2.6-hd", "audio")], builtinModels: minimaxBuiltinModels, description: "查询云端媒体模型和账号音色，内置目录作为补充；查询结果不代表生成能力已验证。", probeLabel: "获取模型与音色目录" },
  { id: "xiaomi", name: "小米 MiMo", kinds: ["audio"], transport: "http", defaultBaseUrl: "https://api.xiaomimimo.com/v1", defaultModels: [model("mimo-v2.5-tts", "audio")], description: "配置小米语音合成模型与音色，默认音色 mimo_default。连接检查只读取模型目录。", probeLabel: "检查模型目录" },
  { id: "comfyui", name: "ComfyUI", kinds: ["image", "video", "audio"], transport: "http", defaultBaseUrl: "http://127.0.0.1:8188", defaultModels: [], description: "连接自托管 ComfyUI，读取系统与节点信息，核对 API 工作流的节点类型。媒体能力取决于实际工作流。", probeLabel: "检查系统与工作流节点" },
  { id: "libtv", name: "LibTV", kinds: ["image", "video"], transport: "mcp", defaultBaseUrl: "https://mcp.liblib.tv/mcp", defaultModels: [], description: "通过宿主 MCP/OAuth 连接。当前页面保存服务入口，实际远程工具由已授权的 MCP 服务提供。", probeLabel: "查看 MCP 接入说明" },
];
function getMediaProviderCatalog() { return structuredClone(catalog); }
module.exports = { getMediaProviderCatalog };
