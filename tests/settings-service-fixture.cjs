"use strict";
// Isolated legacy-format test adapter. Production uses the OS Keychain adapter.
const { createCipheriv, createDecipheriv, randomBytes, createHash } = require("node:crypto");
const { createMediaProviderSettings: createSettings } = require("../lib/media-provider-settings.js");
function testSecrets(identity = "bone.aimedia.services", key = createHash("sha256").update("isolated-media-test-machine-key").digest()) {
  const aad = Buffer.from(`pi-desktop.plugin-secrets.v1\0${identity}`);
  return {
    async encrypt(value) {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return `v1:${Buffer.concat([nonce, encrypted, cipher.getAuthTag()]).toString("base64")}`;
    },
    async decrypt(value) {
      if (!value.startsWith("v1:")) throw Error("Unsupported test envelope");
      const bytes = Buffer.from(value.slice(3), "base64"), decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
    },
  };
}
const createMediaProviderSettings = options => createSettings({ secrets: testSecrets(), ...options });
module.exports = { testSecrets, createMediaProviderSettings };
