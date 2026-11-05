"use strict";
const { assert, keys } = require("./media-provider-schema.js");
function createGenerationRecords({ images, audio }) {
  const engines = { image: images, audio };
  const prefixes = { image: "img-", audio: "aud-" };
  function select(input, allowed) {
    keys(input, allowed);
    assert(["image", "audio"].includes(input.kind) && typeof input.jobId === "string" && input.jobId.startsWith(prefixes[input.kind]));
    return engines[input.kind];
  }
  async function list(input = {}) {
    keys(input, []);
    const [imageJobs, audioJobs] = await Promise.all([images.list({}), audio.list({})]);
    const jobs = [...imageJobs.jobs.map(job => ({ ...job, kind: "image" })), ...audioJobs.jobs.map(job => ({ ...job, kind: "audio" }))];
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { jobs, limit: imageJobs.limit + audioJobs.limit };
  }
  async function get(input) {
    const engine = select(input, ["kind", "jobId"]);
    const job = await engine.get({ jobId: input.jobId });
    return { ...job, kind: input.kind };
  }
  async function read(input) {
    const engine = select(input, ["kind", "jobId", "expectedSha256", "offset"]);
    return engine.readResult({ jobId: input.jobId, expectedSha256: input.expectedSha256, offset: input.offset });
  }
  return { list, get, read };
}
module.exports = { createGenerationRecords };
