"use strict";

const SCALAR_PURPOSES = new Set(["prompt", "negativePrompt", "seed", "width", "height", "steps", "duration", "fps"]);
const IMAGE_PURPOSE_PATTERN = /^(?:inputImage|firstFrame|lastFrame|referenceImage[1-8])$/;
const IMAGE_MIME_FIELD = "images";
const VIDEO_MIME_FIELD = "videos";
const AUDIO_MIME_FIELD = "audio";

function normalized(value) {
  return typeof value === "string"
    ? value.toLocaleLowerCase().replace(/[_.:/-]+/g, " ").replace(/\s+/g, " ").trim()
    : "";
}

function compact(value) { return normalized(value).replace(/\s+/g, ""); }
function titleOf(node) { return node?._meta?.title || node?.title || node?.class_type || ""; }
function valueKind(value) {
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isSafeInteger(value[1])) return "linked";
  return "complex";
}
function isLinked(value) { return valueKind(value) === "linked"; }
function hasAny(text, values) { return values.some(value => text.includes(value)); }

function imagePurpose(title, classType, input, imageIndex) {
  const text = normalized(`${title} ${classType} ${input}`);
  const key = compact(input);
  if (hasAny(text, ["last frame", "end frame", "尾帧", "结束帧", "最后一帧"]) || ["lastframe", "endframe", "endimage"].includes(key)) return "lastFrame";
  if (hasAny(text, ["first frame", "start frame", "首帧", "起始帧", "第一帧"]) || ["firstframe", "startframe", "startimage"].includes(key)) return "firstFrame";
  if (hasAny(text, ["reference", "ref image", "参考图", "参考图片"]) || /^(?:ref|reference)(?:image|img)?\d*$/.test(key)) {
    return `referenceImage${Math.min(imageIndex, 8)}`;
  }
  if (hasAny(text, ["input image", "input frame", "输入图", "输入图片"]) || ["inputimage", "inputframe", "initimage", "sourceimage"].includes(key)) return "inputImage";
  return imageIndex === 1 ? "inputImage" : `referenceImage${Math.min(imageIndex - 1, 8)}`;
}

function imageInputMatch(node, input, kind) {
  if (!["image", "video"].includes(kind)) return null;
  const classType = compact(node?.class_type);
  const title = normalized(titleOf(node));
  const key = compact(input);
  const imageLoader = /(?:loadimage|imageinput|imageloader|referenceimage|firstlastframe|imageupload)/.test(classType);
  const imageKey = ["image", "inputimage", "imagepath", "imagefile", "startimage", "endimage", "firstframe", "lastframe", "referenceimage", "refimage", "initimage", "sourceimage"].includes(key);
  const fileKey = key === "file" && imageLoader;
  const imageText = hasAny(`${title} ${classType}`, ["image", "frame", "参考", "首帧", "尾帧", "输入图"]);
  if (!(imageKey || fileKey || input === "image" && imageText)) return null;
  return { purpose: imagePurpose(title, node?.class_type, input, 1), score: imageKey ? 100 : fileKey ? 85 : 70 };
}

function scalarMatch(node, input, value) {
  const classType = normalized(node?.class_type);
  const title = normalized(titleOf(node));
  const text = `${classType} ${title} ${normalized(input)}`;
  const key = compact(input);

  if (typeof value === "string") {
    if (hasAny(text, ["negative prompt", "negative", "uncond", "avoid", "负面提示", "反向提示", "禁止内容"])) return { purpose: "negativePrompt", score: 120 };
    if (["prompt", "positiveprompt", "prompttext", "textg", "textl", "positive"].includes(key)) return { purpose: "prompt", score: 115 };
    if (key === "text" || text.includes("clip text encode") || text.includes("text encode") || text.includes("positive prompt") || text.includes("提示词")) return { purpose: "prompt", score: key === "text" ? 85 : 75 };
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (key === "seed" || key === "noiseseed" || text.includes("noise seed") || text.includes("random seed") || text.includes("随机种子")) return { purpose: "seed", score: key === "seed" ? 120 : 100 };
  if (key === "width" || text.includes("image width") || text.endsWith(" width") || text.includes("图像宽度")) return { purpose: "width", score: key === "width" ? 120 : 100 };
  if (key === "height" || text.includes("image height") || text.endsWith(" height") || text.includes("图像高度")) return { purpose: "height", score: key === "height" ? 120 : 100 };
  if (key === "steps" || text.includes("sampling steps") || /\bsteps\b/.test(text) || text.includes("采样步数")) return { purpose: "steps", score: key === "steps" ? 120 : 100 };
  if (["duration", "seconds", "length", "frames", "numframes", "framecount", "numberofframes"].includes(key) || hasAny(text, ["duration", "frame count", "num frames", "video length", "时长", "帧数"])) return { purpose: "duration", score: 110 };
  if (["fps", "framerate", "framespersecond"].includes(key) || hasAny(text, ["frame rate", "frames per second", "帧率"])) return { purpose: "fps", score: 120 };
  return null;
}

function inputCandidates(definition, kind) {
  const candidates = [];
  let imageIndex = 1;
  let order = 0;
  for (const [nodeId, node] of Object.entries(definition || {})) {
    if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") continue;
    for (const [input, value] of Object.entries(node.inputs)) {
      order += 1;
      if (isLinked(value)) continue;
      const image = imageInputMatch(node, input, kind);
      const match = image ? { ...image, purpose: image.purpose.replace(/referenceImage\d+$/, () => `referenceImage${Math.min(imageIndex, 8)}`) } : scalarMatch(node, input, value);
      if (!match) continue;
      if (image) {
        match.purpose = imagePurpose(titleOf(node), node.class_type, input, imageIndex);
        imageIndex += 1;
      }
      if (!SCALAR_PURPOSES.has(match.purpose) && !IMAGE_PURPOSE_PATTERN.test(match.purpose)) continue;
      candidates.push({ nodeId, input, classType: node.class_type, title: titleOf(node), valueKind: valueKind(value), purpose: match.purpose, score: match.score, order });
    }
  }
  const selected = new Map();
  for (const candidate of candidates) {
    const previous = selected.get(candidate.purpose);
    if (!previous || candidate.score > previous.score || candidate.score === previous.score && candidate.order < previous.order) selected.set(candidate.purpose, candidate);
  }
  return [...selected.values()].sort((left, right) => left.order - right.order).map(({ order, score, ...candidate }) => ({ ...candidate, score }));
}

function outputCandidates(definition, kind) {
  const candidates = [];
  const field = kind === "image" ? IMAGE_MIME_FIELD : kind === "video" ? VIDEO_MIME_FIELD : AUDIO_MIME_FIELD;
  for (const [nodeId, node] of Object.entries(definition || {})) {
    const classType = typeof node?.class_type === "string" ? node.class_type : "";
    const text = normalized(`${classType} ${titleOf(node)}`);
    const compactText = compact(`${classType} ${titleOf(node)}`);
    let score = 0;
    if (kind === "image" && (hasAny(text, ["save image", "preview image", "image output"]) || hasAny(compactText, ["saveimage", "previewimage", "imageoutput"]))) score = 100;
    if (kind === "video" && (hasAny(text, ["save video", "video combine", "combine video", "video output"]) || hasAny(compactText, ["savevideo", "videocombine", "combinevideo", "videooutput"]))) score = 100;
    if (kind === "audio" && (hasAny(text, ["save audio", "audio save", "audio output", "save mp3", "save wav"]) || hasAny(compactText, ["saveaudio", "audiosave", "audiooutput", "savemp3", "savewav"]))) score = 100;
    if (score === 0) continue;
    candidates.push({ nodeId, classType, title: titleOf(node), kind, field, index: 0, score });
  }
  return candidates.sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
}

function matchWorkflow(definition, kind) {
  const inputs = inputCandidates(definition, kind);
  const outputs = outputCandidates(definition, kind);
  return {
    inputs,
    suggestedBindings: inputs.map(({ nodeId, input, purpose }) => ({ purpose, nodeId, input })),
    outputCandidates: outputs,
    suggestedOutput: outputs[0] ? { kind, nodeId: outputs[0].nodeId, field: outputs[0].field, index: 0 } : null,
    supportsReferenceImages: inputs.some(item => IMAGE_PURPOSE_PATTERN.test(item.purpose)),
  };
}

function isImageBindingPurpose(value) { return typeof value === "string" && IMAGE_PURPOSE_PATTERN.test(value); }
function isWorkflowBindingPurpose(value) { return typeof value === "string" && (SCALAR_PURPOSES.has(value) || isImageBindingPurpose(value)); }
function outputFieldForKind(kind) { return kind === "image" ? IMAGE_MIME_FIELD : kind === "video" ? VIDEO_MIME_FIELD : AUDIO_MIME_FIELD; }
module.exports = { matchWorkflow, inputCandidates, outputCandidates, isImageBindingPurpose, isWorkflowBindingPurpose, outputFieldForKind };
