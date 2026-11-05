"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { validMp3 } = require("./audio-fixture.cjs");
const { validateMp3, MAX_AUDIO_BYTES, MAX_ID3_BYTES } = require("../lib/audio-mp3.js");
function frame(version = 3, rateIndex = 2, stereo = false, padding = 0, crc = false) {
  const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bytes = Buffer.alloc(Math.floor((version === 3 ? 144 : 72) * 32000 / rate) + padding);
  bytes.set([0xff, 0xe0 | (version << 3) | 2 | (crc ? 0 : 1), (version === 3 ? 0x10 : 0x40) | (rateIndex << 2) | (padding << 1), stereo ? 0 : 0xc0]);
  return bytes;
}
function tag(version = 4, size = 0, footer = false) {
  const bytes = Buffer.alloc(10 + size + (footer ? 10 : 0)); bytes.write("ID3"); bytes[3] = version; bytes[5] = footer ? 0x10 : 0;
  for (let i = 9, remaining = size; i >= 6; i--, remaining = Math.floor(remaining / 128)) bytes[i] = remaining % 128;
  if (footer) { bytes.copy(bytes, bytes.length - 10, 0, 10); bytes.write("3DI", bytes.length - 10); }
  return bytes;
}
test("synthetic MP3 reports byte-derived framing metadata without claiming decoding or review", () => {
  const bytes = validMp3();
  assert.deepEqual(validateMp3(bytes), { mimeType: "audio/mpeg", byteLength: 4608, sha256: createHash("sha256").update(bytes).digest("hex"),
    durationMs: 288, sampleRate: 32000, channels: 1, verification: "mp3-frames-validated", quality: "not-reviewed" });
  const copy = validMp3(); copy[0] = 0; assert.equal(validMp3()[0], 255);
});
test("Layer III versions, all sample rates, stereo, CRC headers, padding and variable bitrate are structurally supported", () => {
  for (const version of [3, 2, 0]) for (const index of [0, 1, 2]) for (const stereo of [false, true]) {
    const bytes = Buffer.concat([frame(version, index, stereo), frame(version, index, stereo, 1, true)]);
    const result = validateMp3(bytes);
    assert.equal(result.sampleRate, [44100, 48000, 32000][index] / (version === 3 ? 1 : version === 2 ? 2 : 4));
    assert.equal(result.channels, stereo ? 2 : 1);
    assert.equal(result.durationMs, Math.ceil(2 * (version === 3 ? 1152 : 576) * 1000 / result.sampleRate));
  }
  assert.equal(validateMp3(Buffer.concat([frame(), validMp3()])).durationMs, 324);
});
test("bounded ID3v2 metadata and optional ID3v1 trailer preserve frame duration", () => {
  const trailer = Buffer.alloc(128); trailer.write("TAG");
  for (const version of [2, 3, 4]) assert.equal(validateMp3(Buffer.concat([tag(version, 37), validMp3(), trailer])).durationMs, 288);
  assert.equal(validateMp3(Buffer.concat([tag(4, 22, true), validMp3()])).sampleRate, 32000);
  assert.equal(validateMp3(Buffer.concat([tag(4, MAX_ID3_BYTES - 10), validMp3()])).durationMs, 288);
});
test("truncated frames, junk, invalid headers, inconsistent streams and malformed metadata reject", () => {
  const bad = [Buffer.alloc(0), Buffer.from("ID3"), validMp3().subarray(0, -1), Buffer.concat([validMp3(), Buffer.from([0])]),
    Buffer.concat([Buffer.from("junk"), validMp3()]), Buffer.concat([tag(), tag(), validMp3()]), tag(),
    Buffer.concat([tag(4, MAX_ID3_BYTES - 9), validMp3()]), Buffer.concat([validMp3(), frame(2)]),
    Buffer.concat([validMp3(), frame(3, 1)]), Buffer.concat([validMp3(), frame(3, 2, true)])];
  for (const [index, byte] of [[0, 0xfe], [1, 0xeb], [1, 0xfd], [2, 0x08], [2, 0xf8], [2, 0x9c], [3, 0xc2]]) {
    const bytes = validMp3(); bytes[576 + index] = byte; bad.push(bytes);
  }
  for (const [index, byte] of [[0, 0xc9], [3, 5], [4, 255], [5, 1], [6, 128], [9, 127]]) {
    const bytes = tag(); bytes[index] = byte; bad.push(Buffer.concat([bytes, validMp3()]));
  }
  const footer = tag(4, 0, true); footer[10] = 0; bad.push(Buffer.concat([footer, validMp3()]));
  const trailer = Buffer.alloc(128); trailer.write("TAG"); trailer[0] |= 128; bad.push(Buffer.concat([validMp3(), trailer]));
  for (const bytes of bad) assert.throws(() => validateMp3(bytes), { code: "RESULT_INVALID" });
});
test("duration accepts 600 seconds and rejects the next frame; byte cap rejects before parsing", () => {
  const one = frame(3, 1), exact = Buffer.concat(Array.from({ length: 25000 }, () => one));
  assert.equal(validateMp3(exact).durationMs, 600000);
  assert.throws(() => validateMp3(Buffer.concat([exact, one])), { code: "RESULT_INVALID" });
  assert.throws(() => validateMp3(Buffer.alloc(MAX_AUDIO_BYTES + 1)), { code: "RESULT_INVALID" });
});
