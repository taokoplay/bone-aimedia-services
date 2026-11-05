"use strict";

const { createHash } = require("node:crypto");
const { inflateSync } = require("node:zlib");

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function requireValid(condition) {
  if (!condition) throw new Error("Invalid PNG");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Structural validation only: no pixel reconstruction or artistic quality review.
function validatePng(buffer) {
  try {
    requireValid(Buffer.isBuffer(buffer) && buffer.length <= MAX_IMAGE_BYTES && buffer.length >= 57);
    requireValid(buffer.subarray(0, 8).equals(SIGNATURE));
    let offset = 8;
    let width, height, depth, color;
    let palette = false;
    let dataState = 0; // 0: before IDAT, 1: contiguous IDAT sequence, 2: after IDAT.
    let ended = false;
    let compressedLength = 0;
    const compressed = Buffer.allocUnsafe(buffer.length);
    while (offset < buffer.length) {
      requireValid(buffer.length - offset >= 12);
      const length = buffer.readUInt32BE(offset);
      requireValid(length <= buffer.length - offset - 12);
      const typeBytes = buffer.subarray(offset + 4, offset + 8);
      requireValid(typeBytes.every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)));
      requireValid((typeBytes[2] & 32) === 0);
      const type = typeBytes.toString("ascii");
      const end = offset + 8 + length;
      requireValid(crc32(buffer.subarray(offset + 4, end)) === buffer.readUInt32BE(end));
      requireValid(offset !== 8 || type === "IHDR");
      requireValid(!["acTL", "fcTL", "fdAT"].includes(type));
      if (type !== "IDAT" && dataState === 1) dataState = 2;
      const data = buffer.subarray(offset + 8, end);
      if (type === "IHDR") {
        requireValid(offset === 8 && length === 13);
        width = data.readUInt32BE(0); height = data.readUInt32BE(4);
        depth = data[8]; color = data[9];
        requireValid(width >= 1 && width <= 4096 && height >= 1 && height <= 4096 && width * height <= 16777216);
        requireValid(DEPTHS[color]?.includes(depth));
        requireValid(data[10] === 0 && data[11] === 0 && data[12] === 0);
      } else if (type === "PLTE") {
        requireValid(!palette && dataState === 0 && color !== 0 && color !== 4);
        requireValid(length > 0 && length <= 768 && length % 3 === 0);
        requireValid(color !== 3 || length / 3 <= 2 ** depth);
        palette = true;
      } else if (type === "IDAT") {
        requireValid(dataState !== 2 && (color !== 3 || palette));
        dataState = 1;
        compressedLength += length;
        requireValid(compressedLength <= MAX_IMAGE_BYTES);
        data.copy(compressed, compressedLength - length);
      } else if (type === "IEND") {
        requireValid(length === 0 && compressedLength > 0 && end + 4 === buffer.length);
        ended = true;
      } else {
        requireValid((typeBytes[0] & 32) !== 0); // Unknown critical chunks cannot be ignored.
      }
      offset = end + 4;
    }
    requireValid(ended);
    const rowBytes = Math.ceil(width * CHANNELS[color] * depth / 8) + 1;
    const expected = rowBytes * height;
    const inflated = inflateSync(compressed.subarray(0, compressedLength), { maxOutputLength: expected, info: true });
    requireValid(inflated.buffer.length === expected && inflated.engine.bytesWritten === compressedLength);
    for (let row = 0; row < height; row++) requireValid(inflated.buffer[row * rowBytes] <= 4);
    return {
      mimeType: "image/png", byteLength: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"), width, height,
      verification: "png-validated", quality: "not-reviewed",
    };
  } catch {
    throw Object.assign(new Error("The image result is not a supported valid PNG."), { code: "RESULT_INVALID" });
  }
}

module.exports = { MAX_IMAGE_BYTES, validatePng };
