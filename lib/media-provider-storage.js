"use strict";

const { config, fail } = require("./media-provider-schema.js");
const { createPrivateJsonStorage } = require("./private-json-storage.js");
const { envelope } = require("./credential-persistence.js");

function createStorage(getDataPath) {
  const storage = createPrivateJsonStorage(getDataPath, {
    filename: "aimedia-settings.json",
    maxBytes: 8 * 1024 * 1024,
    empty: () => ({ revision: 0, profiles: [], defaults: { image: null, video: null, audio: null }, workflows: [] }),
    parse(value) {
      const { encryptedCredentials, ...publicConfig } = value;
      const parsed = config(publicConfig, true);
      return { revision: parsed.revision, profiles: parsed.profiles, defaults: parsed.defaults, workflows: parsed.workflows,
        ...(encryptedCredentials === undefined ? {} : { encryptedCredentials: envelope(encryptedCredentials) }) };
    },
  });
  async function read() {
    try { return await storage.read(); }
    catch { fail("STORAGE_ERROR", "Provider configuration could not be read safely. Repair the configuration file before continuing."); }
  }
  async function write(value, checkCurrent) {
    try { await storage.write(value, checkCurrent); }
    catch (error) {
      if (error.code === "CONFLICT" || error.code === "DISPOSED") throw error;
      fail("STORAGE_ERROR", "Provider configuration could not be saved safely. Existing session state was preserved.");
    }
  }
  return { read, write };
}
module.exports = { createStorage };
