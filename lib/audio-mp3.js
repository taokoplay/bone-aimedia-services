"use strict";
const { createHash } = require("node:crypto");
const { assert } = require("./media-provider-schema.js");
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_DURATION_MS = 600000;
const MAX_ID3_BYTES = 256 * 1024;
const SAMPLE_RATES = Object.freeze([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000]);
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
function valid(value) { assert(value, "RESULT_INVALID", "Audio frame verification failed."); }
function metadataEnd(bytes) {
  if (bytes.toString("latin1", 0, 3) !== "ID3") return 0;
  valid(bytes.length >= 10);
  const version = bytes[3], flags = bytes[5];
  valid([2, 3, 4].includes(version) && bytes[4] !== 255);
  valid((flags & (version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f)) === 0);
  let size = 0;
  for (let i = 6; i < 10; i++) { valid(bytes[i] < 128); size = size * 128 + bytes[i]; }
  const footer = version === 4 && (flags & 0x10) !== 0;
  const end = 10 + size + (footer ? 10 : 0);
  valid(end <= MAX_ID3_BYTES && end <= bytes.length);
  if (footer) {
    valid(bytes.toString("latin1", end - 10, end - 7) === "3DI");
    valid(bytes.subarray(end - 7, end).equals(bytes.subarray(3, 10)));
  }
  return end;
}
/** Structural validation only: checks every Layer III header and frame extent,
 * not Huffman data, CRC integrity, gapless playback, decoded sound or quality.
 * Duration counts encoded frame samples (including encoder delay/padding).
 */
function validateMp3(bytes) {
  valid(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_AUDIO_BYTES);
  let offset = metadataEnd(bytes), end = bytes.length;
  if (end - offset >= 128 && bytes.toString("latin1", end - 128, end - 125) === "TAG") end -= 128;
  let sampleRate, channels, version, samples = 0, frames = 0;
  while (offset < end) {
    valid(offset + 4 <= end);
    const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2], d = bytes[offset + 3];
    const frameVersion = (b >> 3) & 3, layer = (b >> 1) & 3;
    const bitrateIndex = c >> 4, rateIndex = (c >> 2) & 3;
    valid(a === 255 && (b & 0xe0) === 0xe0 && frameVersion !== 1 && layer === 1);
    // Free-format bitrate cannot be bounded from a header; reject it explicitly.
    valid(bitrateIndex > 0 && bitrateIndex < 15 && rateIndex < 3 && (d & 3) !== 2);
    const rate = [44100, 48000, 32000][rateIndex] / (frameVersion === 3 ? 1 : frameVersion === 2 ? 2 : 4);
    const count = (d >> 6) === 3 ? 1 : 2;
    if (!frames) { sampleRate = rate; channels = count; version = frameVersion; }
    valid(rate === sampleRate && count === channels && frameVersion === version);
    const bitrate = (frameVersion === 3 ? MPEG1_BITRATES : MPEG2_BITRATES)[bitrateIndex] * 1000;
    const length = Math.floor((frameVersion === 3 ? 144 : 72) * bitrate / rate) + ((c >> 1) & 1);
    const crcBytes = (b & 1) === 0 ? 2 : 0;
    const sideBytes = frameVersion === 3 ? (count === 1 ? 17 : 32) : (count === 1 ? 9 : 17);
    valid(length >= 4 + crcBytes + sideBytes && offset + length <= end);
    samples += frameVersion === 3 ? 1152 : 576;
    valid(samples * 1000 <= MAX_DURATION_MS * sampleRate);
    offset += length; frames += 1;
  }
  valid(frames > 0 && offset === end);
  return { mimeType: "audio/mpeg", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    durationMs: Math.ceil(samples * 1000 / sampleRate), sampleRate, channels,
    verification: "mp3-frames-validated", quality: "not-reviewed" };
}
module.exports = { validateMp3, MAX_AUDIO_BYTES, MAX_DURATION_MS, MAX_ID3_BYTES, SAMPLE_RATES };
