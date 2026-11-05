"use strict";
const { createHash } = require("node:crypto");
const { assert, keys } = require("./media-provider-schema.js");
const { profileIdentity } = require("./comfy-resource-snapshots.js");
/** A process-local shared limit. reserve() synchronously returns an idempotent
 * release() function, or throws GENERATION_BUSY without reserving a slot.
 * Hold the reservation through dispatch AND persistence; release on every exit.
 */
function createGenerationBudget(limit = 2) {
  assert(Number.isSafeInteger(limit) && limit > 0);
  let active = 0;
  return Object.freeze({
    reserve() {
      assert(active < limit, "GENERATION_BUSY", "Wait for an active generation job to finish.");
      active += 1;
      let released = false;
      return () => { if (!released) { released = true; active -= 1; } };
    },
  });
}
// The adapters own schemas, profile selection and media verification; this
// engine owns claims, request lifetime, persistence, recovery and disposal.
function createMediaGeneration({ store, schema, withProfile, generate, validateResult, kind, mimeType, request, now = () => new Date().toISOString(), budget = createGenerationBudget() }) {
  const { prepareInput, jobId, hash, requestHash, parseJob, publicJob, ERROR_CODES, parseAgentRequest } = schema;
  assert(typeof budget?.reserve === "function");
  const label = kind[0].toUpperCase() + kind.slice(1);
  const active = new Map(), writes = new Set();
  let disposed = false, closing = false, queue = Promise.resolve();
  const writable = () => assert(!disposed, "DISPOSED", `${label} generation service was reloaded.`);
  const alive = () => assert(!closing && !disposed, "DISPOSED", `${label} generation service was reloaded.`);
  function enqueue(work) { const result = queue.then(() => { alive(); return work(); }); queue = result.catch(() => {}); return result; }
  function writing(operation) {
    const pending = Promise.resolve(operation); writes.add(pending);
    void pending.finally(() => writes.delete(pending)).catch(() => {}); return pending;
  }
  async function recoverResult(job) {
    if (active.has(job.id) || !["submitting", "unknown", "result-pending"].includes(job.state) || !await store.hasClaim(job.id)) return job;
    let bytes;
    try { bytes = await store.readResult(job.id); }
    catch (error) { if (error.code === "NOT_FOUND") return job; throw error; }
    const result = { resultId: job.id, ...validateResult(bytes) };
    const { error, ...saved } = job;
    // Result bytes can be committed before the final JSON record. Recover from
    // verified immutable bytes without another provider call or disk mutation.
    return { ...saved, state: "succeeded", revision: 3, result };
  }
  async function observed(job, summary = false) {
    job = await recoverResult(job);
    const value = publicJob(job, summary);
    // Never retry a claim owned by a former process or another live instance.
    if (!active.has(job.id) && (job.state === "submitting" || job.state === "prepared" && await store.hasClaim(job.id))) {
      value.state = "unknown"; value.charging = "unknown"; value.error = { code: "GENERATION_UNKNOWN" };
    }
    return value;
  }
  async function prepare(input, agentRequest) {
    alive(); const parsed = prepareInput(input);
    if (agentRequest !== undefined) agentRequest = parseAgentRequest(agentRequest);
    return enqueue(() => withProfile(parsed.request, async ({ profile, checkCurrent }) => {
      const identity = profileIdentity(profile), digest = requestHash(parsed.request, identity);
      const timestamp = now();
      const job = { version: agentRequest ? 2 : 1, ...(agentRequest ? { agentRequest } : {}), id: parsed.id, revision: 1, state: "prepared", requestHash: digest, profileIdentity: identity,
        request: parsed.request, profileName: profile.name, estimatedCost: { status: "unknown", currency: null }, createdAt: timestamp, updatedAt: timestamp, charging: "not-submitted" };
      checkCurrent(); alive();
      const created = await writing(store.create(parseJob(job))); alive();
      const saved = created ? job : await store.read(job.id);
      assert(saved.requestHash === digest, "GENERATION_REQUEST_CONFLICT", "This request ID already belongs to different parameters.");
      assert((saved.agentRequest?.inputHash ?? null) === (agentRequest?.inputHash ?? null) && (saved.agentRequest?.sessionHash ?? null) === (agentRequest?.sessionHash ?? null), "GENERATION_REQUEST_CONFLICT", "Agent request identity does not match.");
      return observed(saved);
    }));
  }
  async function submit(input, beforeDispatch = () => {}) {
    alive(); keys(input, ["jobId", "requestHash", "confirm"]); const id = jobId(input.jobId), digest = hash(input.requestHash);
    assert(input.confirm === true, "INVALID_ARGUMENT", "Confirm one potentially billable output before submission.");
    assert(typeof beforeDispatch === "function"); beforeDispatch();
    return enqueue(async () => {
      const job = await store.read(id); alive(); beforeDispatch();
      assert(job.requestHash === digest, "GENERATION_REQUEST_CONFLICT", "Prepared request does not match.");
      if (job.state !== "prepared" || await store.hasClaim(id)) return observed(job);
      const release = budget.reserve();
      let executing = false;
      try {
        return await withProfile(job.request, async ({ profile, secret, checkCurrent }) => {
          assert(profileIdentity(profile) === job.profileIdentity, "CONFLICT", "The saved service changed.");
          checkCurrent(); alive(); beforeDispatch();
          if (!await writing(store.claim(id))) return observed(await store.read(id));
          alive();
          const submitting = { ...job, revision: 2, state: "submitting", updatedAt: now(), charging: "unknown" };
          // If this commit fails the durable claim still prevents another dispatch.
          await writing(store.write(submitting, alive)); alive();
          const work = Promise.resolve().then(() => execute(submitting, { profile, secret, checkCurrent, beforeDispatch }));
          active.set(id, work); executing = true;
          void work.finally(() => { active.delete(id); release(); }).catch(() => {});
          return publicJob(submitting);
        });
      } finally { if (!executing) release(); }
    });
  }
  async function submitAndWait(input, beforeDispatch) {
    const job = await submit(input, beforeDispatch);
    // Host API promises belong to the originating Agent invocation. Returning
    // while its net.fetch is pending causes the host to reject that promise.
    // Panel callers keep using submit(); both paths share one durable claim.
    const execution = active.get(job.id);
    if (execution) await execution;
    return get({ jobId: job.id });
  }
  async function execute(job, captured) {
    let outcome;
    try {
      alive(); captured.checkCurrent(); captured.beforeDispatch();
      outcome = await generate({ ...captured, input: job.request, request, checkCurrent: () => { alive(); captured.checkCurrent(); captured.beforeDispatch(); } });
    } catch (error) {
      outcome = { state: "failed", charging: "not-submitted", error: { code: ERROR_CODES.has(error?.code) ? error.code : "GENERATION_UNKNOWN" } };
    }
    // A graceful disposal drains paid responses before destroying this instance.
    // A forced process exit still leaves the durable claim for crash recovery.
    if (disposed) return;
    let result;
    if (outcome.state === "succeeded") {
      try {
        await writing(store.writeResult(job.id, outcome.bytes, writable)); writable();
        result = { resultId: job.id, ...outcome.descriptor };
      } catch { outcome = { state: "result-pending", charging: "unknown", error: { code: "STORAGE_ERROR" } }; }
    }
    if (disposed) return;
    const final = { ...job, revision: 3, state: outcome.state, updatedAt: now(), charging: outcome.charging,
      ...(result ? { result } : {}), ...(outcome.error ? { error: outcome.error } : {}) };
    // A storage failure leaves a claimed submitting record visible as unknown.
    // Keep the error observable to callers through get/list, never retry dispatch.
    await writing(store.write(parseJob(final), writable));
  }
  async function get(input) { alive(); keys(input, ["jobId"]); const job = await store.read(jobId(input.jobId)); alive(); return observed(job); }
  async function list(input = {}) {
    alive(); keys(input, []); const jobs = await store.list(); alive();
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { jobs: await Promise.all(jobs.map(job => observed(job, true))), limit: 200 };
  }
  async function readResult(input) {
    alive(); keys(input, ["jobId", "expectedSha256", "offset"]);
    const id = jobId(input.jobId), expected = hash(input.expectedSha256), offset = input.offset;
    assert(Number.isSafeInteger(offset) && offset >= 0);
    const job = await recoverResult(await store.read(id)); alive();
    assert(job.state === "succeeded" && job.result?.sha256 === expected, "RESULT_UNAVAILABLE", "No matching successful result.");
    const bytes = await store.readResult(id); alive();
    assert(bytes.length === job.result.byteLength && createHash("sha256").update(bytes).digest("hex") === expected, "RESULT_INVALID", `Stored ${kind} verification failed.`);
    assert(offset < bytes.length, "INVALID_ARGUMENT");
    const nextOffset = Math.min(offset + 64 * 1024, bytes.length);
    return { jobId: id, mimeType, sha256: expected, totalBytes: bytes.length, offset, nextOffset, eof: nextOffset === bytes.length, base64: bytes.subarray(offset, nextOffset).toString("base64") };
  }
  // Entry-only data access for Agent orchestration; never dispatched by the panel.
  async function agentRecord(id) {
    alive(); const record = await store.read(jobId(id)); alive();
    return { job: await observed(record), source: record.agentRequest };
  }
  async function agentRecords() {
    alive(); const records = await store.list(); alive();
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return records.map(record => ({ id: record.id, source: record.agentRequest }));
  }
  async function resultBytes(id) {
    alive(); const job = await recoverResult(await store.read(jobId(id))); alive();
    assert(job.state === "succeeded" && job.result, "RESULT_UNAVAILABLE");
    const bytes = await store.readResult(id); alive();
    assert(bytes.length === job.result.byteLength && createHash("sha256").update(bytes).digest("hex") === job.result.sha256, "RESULT_INVALID");
    return { job: publicJob(job), bytes };
  }
  async function dispose() {
    closing = true;
    await queue;
    await Promise.allSettled([...active.values()]);
    await Promise.allSettled([...writes]);
    disposed = true;
  }
  return { prepare, submit, submitAndWait, get, list, readResult, agentRecord, agentRecords, resultBytes, dispose };
}
module.exports = { createGenerationBudget, createMediaGeneration };
