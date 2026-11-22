"use strict";
const { assert, keys } = require("./media-provider-schema.js");
function createGenerationRecords({ images, audio, workflows }) {
  const engines = { image: images, audio, workflow: workflows };
  const prefixes = { image: "img-", audio: "aud-", workflow: "wf-" };
  function select(input, allowed) {
    keys(input, allowed);
    assert(["image", "audio", "workflow"].includes(input.kind) && typeof input.jobId === "string" && input.jobId.startsWith(prefixes[input.kind]));
    assert(engines[input.kind]); return engines[input.kind];
  }
  async function withProject(job, kind) {
    const project = await engines[kind].projectSnapshot?.(job.id);
    return { ...job, kind, project: project ?? job.project ?? { status: "unknown" } };
  }
  async function list(input = {}) {
    keys(input, []);
    const results = await Promise.all([images.list({}), audio.list({}), workflows?.list?.() || { jobs: [], limit: 0 }]);
    const jobs = await Promise.all(results.flatMap((result, index) => result.jobs.map(job => withProject(job, ["image", "audio", "workflow"][index]))));
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { jobs, limit: null };
  }
  async function get(input) {
    const engine = select(input, ["kind", "jobId"]);
    return withProject(await engine.get({ jobId: input.jobId }), input.kind);
  }
  async function read(input) {
    const engine = select(input, ["kind", "jobId", "expectedSha256", "offset"]);
    if (input.kind !== "workflow") return engine.readResult({ jobId: input.jobId, expectedSha256: input.expectedSha256, offset: input.offset });
    const result = await engine.readResult({ jobId: input.jobId, expectedSha256: input.expectedSha256 });
    const offset = input.offset || 0; assert(Number.isSafeInteger(offset) && offset >= 0 && offset < result.bytes.length);
    const nextOffset = Math.min(offset + 64 * 1024, result.bytes.length);
    return { jobId: input.jobId, mimeType: result.job.result.mimeType, sha256: result.job.result.sha256, totalBytes: result.bytes.length, offset, nextOffset, eof: nextOffset === result.bytes.length, base64: result.bytes.subarray(offset, nextOffset).toString("base64") };
  }
  async function deleteMany(input) {
    keys(input, ["records", "confirm"]);
    assert(input.confirm === true, "INVALID_ARGUMENT", "Confirm local record deletion.");
    assert(Array.isArray(input.records) && input.records.length > 0);
    const seen = new Set(), items = input.records.map(item => {
      const engine = select(item, ["kind", "jobId"]), identity = `${item.kind}:${item.jobId}`;
      assert(!seen.has(identity), "INVALID_ARGUMENT"); seen.add(identity);
      return { kind: item.kind, jobId: item.jobId, engine };
    });
    const jobs = await Promise.all(items.map(item => item.engine.get({ jobId: item.jobId })));
    for (let index = 0; index < items.length; index += 1) {
      const allowed = items[index].kind === "workflow" ? ["succeeded", "failed"] : ["prepared", "succeeded", "failed"];
      assert(allowed.includes(jobs[index].state), "GENERATION_UNRESOLVED", "Review the task before deleting its record.");
    }
    const groups = new Map();
    for (const item of items) groups.set(item.engine, [...(groups.get(item.engine) || []), item.jobId]);
    for (const [engine, jobIds] of groups) await engine.deleteMany({ jobIds, confirm: true });
    return { deleted: items.map(({ kind, jobId }) => ({ kind, jobId })), count: items.length };
  }
  return { list, get, read, delete: deleteMany };
}
module.exports = { createGenerationRecords };
