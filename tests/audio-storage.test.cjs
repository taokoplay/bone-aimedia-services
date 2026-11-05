"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createMediaJobStorage } = require("../lib/media-job-storage.js");
const { createImageJobStorage } = require("../lib/image-job-storage.js");
const { createAudioGeneration } = require("../lib/audio-generation.js");
const { createGenerationBudget } = require("../lib/media-generation.js");
const schema = require("../lib/audio-generation-schema.js"), imageSchema = require("../lib/image-generation-schema.js");
const { profileIdentity } = require("../lib/comfy-resource-snapshots.js");
const { validateMp3, MAX_AUDIO_BYTES } = require("../lib/audio-mp3.js");
const { validMp3 } = require("./audio-fixture.cjs");
const profile = { id: "speech", provider: "minimax", name: "Synthetic audio", baseUrl: "https://api.minimax.cn/v1" };
const storeAt = root => createMediaJobStorage(() => root, schema.parseJob, { kind: "audio", idPattern: schema.AUDIO_JOB_ID, resultExtension: "mp3", maxResultBytes: MAX_AUDIO_BYTES });
function prepared(parser = schema) {
  const input = parser === schema ? { modelId: "speech-2.8-hd", operation: "speech", text: "Synthetic audio.", voiceId: "fixture-voice" } : { modelId: "gpt-image-2", prompt: "Synthetic image." };
  const { id, request } = parser.prepareInput({ requestId: randomUUID(), profileId: "speech", expectedRevision: 1, ...input });
  const identity = profileIdentity(profile);
  return parser.parseJob({ version: 1, id, revision: 1, state: "prepared", request, profileIdentity: identity, requestHash: parser.requestHash(request, identity), profileName: profile.name,
    estimatedCost: { status: "unknown", currency: null }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", charging: "not-submitted" });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR || os.tmpdir(), "audio-storage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: storeAt(root), directory: path.join(root, "audio-jobs") };
}
function serviceAt(root, budget, transport) {
  return createAudioGeneration({ getDataPath: () => root, budget,
    settings: { async withAudioProfile(input, work) { return work({ profile, secret: "synthetic-storage-secret", checkCurrent() {} }); } },
    request: transport || (async () => { throw Error("Local reads must never dispatch"); }) });
}
test("audio storage preserves private modes, permanent claims, immutable bytes and restart", async t => {
  const f = await fixture(t), job = prepared();
  assert.equal(await f.store.create(job), true); assert.equal(await f.store.create(job), false);
  await assert.rejects(f.store.writeResult(job.id, validMp3()), { code: "STORAGE_ERROR" });
  assert.deepEqual(await Promise.all([f.store.claim(job.id), storeAt(f.root).claim(job.id)]), [true, false]);
  await f.store.writeResult(job.id, validMp3()); await f.store.writeResult(job.id, validMp3());
  await assert.rejects(f.store.writeResult(job.id, Buffer.from("changed")), { code: "STORAGE_ERROR" });
  await assert.rejects(f.store.writeResult(job.id, Buffer.alloc(MAX_AUDIO_BYTES + 1)), { code: "STORAGE_ERROR" });
  const final = { ...job, revision: 3, state: "succeeded", charging: "unknown", result: { resultId: job.id, ...validateMp3(validMp3()) } }; await f.store.write(final);
  assert.deepEqual(await storeAt(f.root).read(job.id), final); assert.deepEqual(await storeAt(f.root).readResult(job.id), validMp3());
  for (const dir of [f.root, f.directory]) assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  for (const file of await fs.readdir(f.directory)) assert.equal((await fs.stat(path.join(f.directory, file))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(f.directory, job.id + ".submitted"), "utf8"), "audio-job-submitted-v1\n");
  assert.equal(await fs.readFile(path.join(f.directory, ".slot-0"), "utf8"), job.id + "\n");
});
test("audio has 200 permanent slots independent of image slots", async t => {
  const f = await fixture(t), job = prepared(); await f.store.create(job);
  for (let i = 1; i < 200; i++) await fs.writeFile(path.join(f.directory, `.slot-${i}`), `aud-${randomUUID()}\n`, { mode: 0o600 });
  await assert.rejects(storeAt(f.root).create(prepared()), { code: "GENERATION_LIMIT" });
  const image = createImageJobStorage(() => f.root, imageSchema.parseJob), imageJob = prepared(imageSchema);
  assert.equal(await image.create(imageJob), true); assert.equal((await image.list()).length, 1); assert.equal((await f.store.list()).length, 1);
  assert.equal(await fs.readFile(path.join(f.root, "image-jobs", ".slot-0"), "utf8"), imageJob.id + "\n");
});
test("audio IDs, corrupt records, untrusted provenance and descriptor bounds fail closed", async t => {
  const f = await fixture(t);
  for (const id of ["../escape", `img-${randomUUID()}`, "aud-invalid", "aud-" + randomUUID().toUpperCase()]) {
    await assert.rejects(f.store.read(id), { code: "STORAGE_ERROR" }); await assert.rejects(f.store.claim(id), { code: "STORAGE_ERROR" });
  }
  assert.deepEqual(await fs.readdir(f.root), []);
  const job = prepared(); await f.store.create(job); const file = path.join(f.directory, job.id + ".json");
  for (const bytes of [Buffer.from("{"), Buffer.from([255]), Buffer.alloc(65537), Buffer.from(JSON.stringify({ ...job, id: "aud-" + randomUUID() })),
    Buffer.from(JSON.stringify({ ...job, version: 2, agentRequest: { version: 1 } }))]) {
    await fs.writeFile(file, bytes); await assert.rejects(f.store.read(job.id), { code: "STORAGE_ERROR" }); assert.deepEqual(await fs.readFile(file), bytes);
  }
  const result = { resultId: job.id, ...validateMp3(validMp3()) };
  for (const patch of [{ durationMs: 600001 }, { sampleRate: 1 }, { channels: 3 }, { byteLength: MAX_AUDIO_BYTES + 1 }, { verification: "decoded" }, { sha256: "invalid" }]) assert.throws(() => schema.parseJob({ ...job, state: "succeeded", result: { ...result, ...patch } }), { code: "INVALID_ARGUMENT" });
});
for (const link of ["symlink", "link"]) test(`audio job, claim and result ${link}s cannot be followed`, async t => {
  for (const suffix of ["json", "submitted", "mp3"]) {
    const f = await fixture(t), job = prepared(); await f.store.create(job); await f.store.claim(job.id); await f.store.writeResult(job.id, validMp3());
    const file = path.join(f.directory, job.id + "." + suffix), target = path.join(f.root, "outside");
    await fs.rename(file, target); await fs[link](target, file);
    const before = await fs.readFile(target);
    const read = suffix === "json" ? () => f.store.read(job.id) : suffix === "submitted" ? () => f.store.hasClaim(job.id) : () => f.store.readResult(job.id);
    await assert.rejects(read(), { code: "STORAGE_ERROR" }); assert.deepEqual(await fs.readFile(target), before);
  }
});
test("audio store pins root and job directory inodes and reads never repair unsafe permissions", async t => {
  const f = await fixture(t), job = prepared(); await f.store.create(job);
  await fs.chmod(f.directory, 0o755); await assert.rejects(f.store.list(), { code: "STORAGE_ERROR" }); assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o755);
  await fs.chmod(f.directory, 0o700); await fs.rename(f.directory, f.directory + "-original"); await fs.mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(f.store.read(job.id), { code: "STORAGE_ERROR" });
});
test("committed MP3 recovery is read-only and an interrupted claim cannot resubmit", async t => {
  const f = await fixture(t), job = prepared(); await f.store.create(job); await f.store.claim(job.id);
  const interrupted = { ...job, revision: 2, state: "submitting", charging: "unknown" }; await f.store.write(interrupted);
  const service = serviceAt(f.root); t.after(() => service.dispose());
  assert.equal((await service.get({ jobId: job.id })).state, "unknown");
  assert.equal((await service.submitAndWait({ jobId: job.id, requestHash: job.requestHash, confirm: true })).state, "unknown");
  await f.store.writeResult(job.id, validMp3());
  const json = await fs.readFile(path.join(f.directory, job.id + ".json")), names = await fs.readdir(f.directory);
  const recovered = await service.get({ jobId: job.id }); assert.equal(recovered.state, "succeeded"); assert.equal(recovered.result.durationMs, 288);
  assert.equal((await service.list()).jobs[0].state, "succeeded");
  assert.deepEqual((await service.resultBytes(job.id)).bytes, validMp3());
  const part = await service.readResult({ jobId: job.id, expectedSha256: recovered.result.sha256, offset: 0 }); assert.equal(part.eof, true);
  assert.deepEqual(await fs.readFile(path.join(f.directory, job.id + ".json")), json); assert.deepEqual(await fs.readdir(f.directory), names);
  const abandoned = prepared(); await f.store.create(abandoned); await f.store.claim(abandoned.id);
  assert.equal((await service.get({ jobId: abandoned.id })).state, "unknown");
});
test("publication failures release budget; committed results recover and no failure retries dispatch", async t => {
  for (const stage of ["claim", "submitting", "result", "final"]) {
    const f = await fixture(t), job = prepared(); await f.store.create(job); const budget = createGenerationBudget(1); let calls = 0;
    const service = serviceAt(f.root, budget, async () => { calls++; return { status: 200, bodyText: JSON.stringify({ base_resp: { status_code: 0 }, data: { status: 2, audio: validMp3().toString("hex") } }) }; });
    const originalLink = fs.link, originalRename = fs.rename;
    const link = t.mock.method(fs, "link", async (from, to) => {
      if (to.startsWith(f.directory) && (stage === "result" && to.endsWith(".mp3") || stage === "claim" && to.endsWith(".submitted"))) throw Object.assign(Error("fixture disk full"), { code: "ENOSPC" });
      return originalLink(from, to);
    });
    const rename = t.mock.method(fs, "rename", async (from, to) => {
      if (to === path.join(f.directory, job.id + ".json")) {
        const record = JSON.parse(await fs.readFile(from, "utf8"));
        if (stage === "submitting" && record.state === "submitting" || stage === "final" && record.state === "succeeded") throw Object.assign(Error("fixture disk full"), { code: "ENOSPC" });
      }
      return originalRename(from, to);
    });
    const pending = service.submitAndWait({ jobId: job.id, requestHash: job.requestHash, confirm: true });
    if (stage === "result") { const final = await pending; assert.equal(final.state, "result-pending"); assert.equal(final.error.code, "STORAGE_ERROR"); }
    else await assert.rejects(pending, { code: "STORAGE_ERROR" });
    link.mock.restore(); rename.mock.restore();
    const release = budget.reserve(); release(); await service.dispose();
    const restarted = serviceAt(f.root); const value = await restarted.get({ jobId: job.id });
    assert.equal(value.state, { claim: "prepared", submitting: "unknown", result: "result-pending", final: "succeeded" }[stage]);
    if (stage !== "claim") await restarted.submitAndWait({ jobId: job.id, requestHash: job.requestHash, confirm: true });
    assert.equal(calls, ["result", "final"].includes(stage) ? 1 : 0); await restarted.dispose();
  }
});
test("readResult rejects mismatched hashes, invalid offsets and changed bytes", async t => {
  const f = await fixture(t), job = prepared(), result = { resultId: job.id, ...validateMp3(validMp3()) };
  await f.store.create(job); await f.store.claim(job.id); await f.store.writeResult(job.id, validMp3()); await f.store.write({ ...job, state: "succeeded", revision: 3, result });
  const service = serviceAt(f.root); t.after(() => service.dispose()); const args = { jobId: job.id, expectedSha256: result.sha256, offset: 0 };
  await assert.rejects(service.readResult({ ...args, expectedSha256: "0".repeat(64) }), { code: "RESULT_UNAVAILABLE" });
  for (const offset of [-1, 0.1, validMp3().length]) await assert.rejects(service.readResult({ ...args, offset }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(service.get({ jobId: "img-" + randomUUID() }), { code: "INVALID_ARGUMENT" });
  await fs.writeFile(path.join(f.directory, job.id + ".mp3"), Buffer.from("tampered"));
  await assert.rejects(service.readResult(args), { code: "RESULT_INVALID" }); await assert.rejects(service.resultBytes(job.id), { code: "RESULT_INVALID" });
});
