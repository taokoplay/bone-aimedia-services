"use strict";

// Media candidates mirrored from DutyDeck's documented MiniMax catalogs.
// Built-ins are not evidence that an account's remote models endpoint lists them.
const builtinModels = [
  ...["image-01", "image-01-live"].map(id => ({ id, name: id, kind: "image" })),
  ...["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02", "T2V-01-Director", "T2V-01", "I2V-01-Director", "I2V-01-live", "I2V-01"].map(id => ({ id, name: id, kind: "video" })),
  ...["speech-2.8-hd", "speech-2.8-turbo", "speech-2.6-hd", "speech-2.6-turbo", "speech-02-hd", "speech-02-turbo", "speech-01-hd", "speech-01-turbo"].map(id => ({ id, name: id, kind: "audio" })),
];
function mediaKind(id) {
  if (/^image[-_]/i.test(id)) return "image";
  if (/^(?:(?:minimax[-_])?hailuo[-_]|[ti]2v[-_])/i.test(id)) return "video";
  if (/^speech[-_]/i.test(id)) return "audio";
  return null;
}
module.exports = { builtinModels, mediaKind };
