"use strict";
// Eight MPEG-1 Layer III silence frames: 128 kbit/s, 32 kHz, mono, 1152
// samples/frame, no bit reservoir or metadata. Zero side information encodes
// zero spectral coefficients. This fixture decodes with FFmpeg and browsers;
// it needs no encoder executable, account, network, or paid generation at runtime.
function validMp3() {
  const frame = Buffer.alloc(576);
  frame.set([0xff, 0xfb, 0x98, 0xc0]);
  return Buffer.concat(Array.from({ length: 8 }, () => frame));
}
module.exports = { validMp3 };
