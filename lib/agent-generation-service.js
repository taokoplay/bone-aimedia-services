"use strict";
const { setTimeout: delay } = require("node:timers/promises");
const { assert, keys } = require("./media-provider-schema.js");
const { digest, contextIdentity, agentJobIdentity } = require("./agent-image-request.js");
const { mediaModelCatalog } = require("./media-model-catalog.js");
const { toolReply } = require("./agent-image-result.js");

// Shared invocation ownership and session-scoped idempotency; media codecs and
// normalized requests stay in their domain adapters.
function createAgentGenerationService({ settings, engine, exporter, domain, clock = Date.now }) {
  const lifetime = new AbortController();
  const check = ctx => { assert(!lifetime.signal.aborted, "DISPOSED"); contextIdentity(ctx); };
  async function owned(id, ctx) {
    const identity = contextIdentity(ctx);
    const record = await engine.agentRecord(domain.jobId(id)); check(ctx);
    assert(record.source?.sessionHash === identity.sessionHash, "NOT_FOUND", "No job belongs to this session.");
    return record;
  }
  async function wait(job, waitMs, ctx) {
    const deadline = clock() + waitMs;
    const signal = AbortSignal.any([lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    while (job.state === "submitting" && clock() < deadline) {
      try { await delay(Math.min(250, Math.max(1, deadline - clock())), undefined, { signal }); }
      catch { check(ctx); assert(false, "TOOL_ABORTED"); }
      check(ctx); job = (await owned(job.id, ctx)).job;
    }
    return job;
  }
  async function catalog(input, ctx) {
    check(ctx); keys(input, ["action", "kind"]); assert(input.action === "list");
    const snapshot = await settings.read(); check(ctx);
    return toolReply({ ok: true, ...mediaModelCatalog(snapshot, input.kind) });
  }
  async function generate(input, ctx) {
    const identity = contextIdentity(ctx, true); check(ctx);
    const parsed = domain.input(input);
    const requestId = agentJobIdentity(identity.sessionHash, parsed.requestKey), id = `${domain.prefix}-${requestId}`;
    let previous;
    try { previous = await engine.agentRecord(id); } catch (error) { if (error.code !== "NOT_FOUND") throw error; }
    check(ctx);
    let job;
    if (previous) {
      assert(previous.source?.sessionHash === identity.sessionHash && previous.source.inputHash === parsed.inputHash, "GENERATION_REQUEST_CONFLICT", "Reuse this request key only for the original request.");
      job = previous.job;
    } else {
      const snapshot = await settings.read(); check(ctx);
      const models = mediaModelCatalog(snapshot, domain.kind);
      const records = await engine.agentRecords(); check(ctx);
      const remembered = records.find(record => record.source?.sessionHash === identity.sessionHash && record.source.explicitModel)?.source.modelRef;
      const selection = domain.resolveModel(models, parsed.modelRef ?? undefined, remembered);
      if (selection.status !== "selected") return toolReply({ ok: false, selection, nextAction: "Choose an offered modelRef; do not change the user's requested provider silently." });
      const model = selection.model;
      job = await engine.prepare({ requestId, profileId: model.profileId, expectedRevision: snapshot.revision, modelId: model.modelId, ...domain.request(parsed) },
        { version: 1, ...identity, requestKeyHash: digest(parsed.requestKey), inputHash: parsed.inputHash, modelRef: model.modelRef, explicitModel: selection.source === "explicit" });
      check(ctx);
    }
    if (job.state === "prepared") {
      check(ctx); job = await engine.submitAndWait({ jobId: job.id, requestHash: job.requestHash, confirm: true }, () => check(ctx)); check(ctx);
    }
    job = await wait(job, parsed.waitMs, ctx); check(ctx);
    return domain.reply(job, engine.resultBytes, () => check(ctx));
  }
  async function query(input, ctx) {
    check(ctx); keys(input, ["action", "jobId", "waitMs"]);
    assert(["get", "wait", "list", "result"].includes(input.action));
    if (input.action === "list") {
      assert(input.jobId === undefined && input.waitMs === undefined);
      const identity = contextIdentity(ctx), records = await engine.agentRecords(); check(ctx);
      const ids = new Set(records.filter(record => record.source?.sessionHash === identity.sessionHash).map(record => record.id));
      const result = await engine.list({}); check(ctx);
      return toolReply({ ok: true, jobs: result.jobs.filter(job => ids.has(job.id)), scope: "calling-session", limit: result.limit });
    }
    assert(input.action === "wait" || input.waitMs === undefined);
    const waitMs = input.action === "wait" ? input.waitMs ?? 15000 : 0;
    assert(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 15000);
    let { job } = await owned(input.jobId, ctx);
    job = await wait(job, waitMs, ctx); check(ctx);
    if (input.action === "result") return domain.reply(job, engine.resultBytes, () => check(ctx));
    return toolReply({ ok: true, job, nextAction: job.state === "succeeded" ? `${domain.kind}_job.result` : job.state === "submitting" ? `${domain.kind}_job.wait` : "Do not automatically resubmit this task." });
  }
  async function exportResult(input, ctx) {
    contextIdentity(ctx, true); check(ctx); keys(input, ["jobId"]);
    await owned(input.jobId, ctx); check(ctx);
    assert(exporter, "EXPORT_UNAVAILABLE");
    const signal = AbortSignal.any([lifetime.signal, ...(ctx.signal ? [ctx.signal] : [])]);
    const output = await exporter.exportResult(input, { ...ctx, signal }); check(ctx);
    return toolReply({ ok: true, ...output });
  }
  return { catalog, generate, query, exportResult, check, dispose() { lifetime.abort(); } };
}
module.exports = { createAgentGenerationService };
