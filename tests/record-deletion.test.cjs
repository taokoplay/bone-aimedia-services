"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createMediaJobStorage } = require("../lib/media-job-storage.js");
const { createComfyJobStorage } = require("../lib/comfy-job-storage.js");
const { createGenerationRecords } = require("../lib/generation-records.js");

const imageStore = root => createMediaJobStorage(() => root, value => value, {
  kind: "image",
  idPattern: /^img-[a-f0-9]{32}$/,
  resultExtension: "png",
  maxResultBytes: 16 * 1024 * 1024,
});
const jobId = prefix => `${prefix}-${randomUUID().replaceAll("-", "")}`;
const mediaJob = id => ({ id, state: "prepared" });
const comfyJob = id => ({ id, version: 1, state: "failed", requestHash: "0".repeat(64) });

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("media storage has no fixed capacity and batch deletion removes private artifacts", async t => {
  const root = await tempRoot(t, "records-delete-media-");
  const store = imageStore(root), jobs = [];
  for (let index = 0; index < 205; index += 1) {
    const job = mediaJob(jobId("img"));
    await store.create(job);
    jobs.push(job);
  }
  const claimed = jobs[0];
  await store.claim(claimed.id);
  await store.writeResult(claimed.id, Buffer.from("png-fixture"));
  await store.write({ ...claimed, state: "succeeded" });
  assert.equal((await store.list()).length, 205);

  const deleted = await store.removeMany([jobs[0].id, jobs[1].id, jobs[2].id]);
  assert.deepEqual(deleted, [jobs[0].id, jobs[1].id, jobs[2].id]);
  assert.equal((await store.list()).length, 202);
  await assert.rejects(store.read(jobs[0].id), { code: "NOT_FOUND" });
  await assert.rejects(store.readResult(jobs[0].id), { code: "NOT_FOUND" });
});

test("ComfyUI storage has no fixed capacity and batch deletion removes results", async t => {
  const root = await tempRoot(t, "records-delete-comfy-");
  const store = createComfyJobStorage(() => root), jobs = [];
  for (let index = 0; index < 205; index += 1) {
    const job = comfyJob(jobId("wf"));
    await store.create(job);
    jobs.push(job);
  }
  await store.writeResult(jobs[0].id, Buffer.from("comfy-result"));
  assert.equal((await store.list()).length, 205);

  const deleted = await store.removeMany([jobs[0].id, jobs[1].id]);
  assert.deepEqual(deleted, [jobs[0].id, jobs[1].id]);
  assert.equal((await store.list()).length, 203);
  await assert.rejects(store.read(jobs[0].id), { code: "NOT_FOUND" });
  await assert.rejects(store.readResult(jobs[0].id), { code: "NOT_FOUND" });
});

test("unified records delete image, audio and workflow records only after state validation", async () => {
  const deleted = [];
  const makeEngine = (kind, states) => ({
    async list() { return { jobs: [] }; },
    async get({ jobId: id }) { return { id, state: states[id], kind }; },
    async readResult() { throw new Error("not used"); },
    async deleteMany({ jobIds }) { deleted.push(...jobIds.map(id => `${kind}:${id}`)); return { deleted: jobIds, count: jobIds.length }; },
  });
  const imageId = jobId("img"), audioId = jobId("aud"), workflowId = jobId("wf");
  const images = makeEngine("image", { [imageId]: "succeeded" });
  const audio = makeEngine("audio", { [audioId]: "failed" });
  const workflows = makeEngine("workflow", { [workflowId]: "succeeded" });
  const records = createGenerationRecords({ images, audio, workflows });

  const result = await records.delete({ records: [
    { kind: "image", jobId: imageId },
    { kind: "audio", jobId: audioId },
    { kind: "workflow", jobId: workflowId },
  ], confirm: true });
  assert.equal(result.count, 3);
  assert.deepEqual(deleted.sort(), [`audio:${audioId}`, `image:${imageId}`, `workflow:${workflowId}`].sort());

  const unknown = jobId("img");
  const guarded = createGenerationRecords({ images: makeEngine("image", { [unknown]: "unknown" }), audio, workflows });
  await assert.rejects(guarded.delete({ records: [{ kind: "image", jobId: unknown }], confirm: true }), { code: "GENERATION_UNRESOLVED" });
});
