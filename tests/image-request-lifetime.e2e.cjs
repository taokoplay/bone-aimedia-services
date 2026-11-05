#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createModel, createHost, prepareRealPlugin, poll, imageBytes, imageBase64 } = require("./agent-image-host-fixture.cjs");
const IMAGE_DELAY_MS = 12000;
const search = tool => ({ tool: "ToolSearch", args: { query: tool } });
const call = (tool, args) => [search(tool), { tool, args }];
const sanitize = text => text.replaceAll("fixture-media-only", "[REDACTED]")
  .replaceAll("fixture-only-no-provider-credentials", "[REDACTED]")
  .replace(/("authorization"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
function value(scenario, tool) {
  const result = scenario.results.find(result => result.name === tool || result.name.endsWith(`_${tool}`));
  assert.ok(result, `${tool} did not execute: ${scenario.missingTool || JSON.stringify(scenario.errors)}`);
  return JSON.parse(typeof result.content === "string" ? result.content : result.content.map(block => block.text || "").join(""));
}
function assertImage(scenario) {
  assert.equal(scenario.imageReceived, true, "The model must receive the exact PNG as an image_url block");
  assert.equal(scenario.flattenedBase64, false, "Typed PNG must not be flattened into text");
  assert.ok(scenario.events.some(({ event }) => event?.type === "tool_end" && event.result?.content?.some(block => block.type === "image" && block.data === imageBase64)), "This turn must emit its own typed image");
}
async function fingerprint(root) {
  const result = {};
  for (const name of ["main.js", "manifest.json", "lib/agent-image-service.js", "lib/image-generation.js", "lib/gpt-image-adapter.js", "tools/image-generation.js"]) {
    result[name] = createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex");
  }
  return result;
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log("PI_SCRATCH_DIR=/scratch PI_DESKTOP_SOURCE=/host/source PI_DESKTOP_APP=/Applications/PI-Desktop.app node tests/image-request-lifetime.e2e.cjs [--baseline --source-root=/scratch/baseline-plugin]");
    console.log("Normal mode requires success for waitMs=0, default 10000, and legacy submit; baseline mode requires lost results for waitMs=1000, default 10000, and legacy submit.");
    return;
  }
  assert.ok(process.env.PI_SCRATCH_DIR, "PI_SCRATCH_DIR is required");
  const baseline = process.argv.includes("--baseline");
  const sourceArgument = process.argv.find(arg => arg.startsWith("--source-root="));
  assert.ok(!baseline || sourceArgument, "Baseline requires an explicit pre-fix source snapshot");
  const sourceRoot = path.resolve(sourceArgument ? sourceArgument.slice("--source-root=".length) : path.join(__dirname, ".."));
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, "image-request-lifetime-"));
  console.log(`ARTIFACTS ${root}`);
  const host = await createHost(root), model = createModel({ imageDelayMs: IMAGE_DELAY_MS });
  const network = [];
  model.server.on("request", (req, res) => {
    if (req.url !== "/v1/images/generations") return;
    const entry = { receivedAt: Date.now() }; network.push(entry);
    res.on("finish", () => { entry.finishedAt = Date.now(); entry.status = res.statusCode; });
    res.on("close", () => { entry.closedAt = Date.now(); entry.responseComplete = res.writableFinished; });
  });
  const report = { mode: baseline ? "baseline" : "acceptance", root, sourceRoot, imageDelayMs: IMAGE_DELAY_MS,
    scenarios: [], cases: [], network, lifecycle: host.lifecycle, passed: false };
  let realPlugin;
  async function save() { await fs.writeFile(path.join(root, "evidence.json"), sanitize(JSON.stringify(report, null, 2))); }
  async function run(session, name, steps) {
    console.log(`TURN ${name}`);
    const startedAt = Date.now();
    const scenario = await host.turn(model, session, name, steps);
    scenario.startedAt = startedAt; scenario.finishedAt = Date.now();
    report.scenarios.push(scenario); await save();
    assert.equal(scenario.missingTool, undefined, `${name}: tools must be available to the actual Agent`);
    assert.deepEqual(scenario.errors, [], `${name}: unexpected Agent/host error`);
    return scenario;
  }
  try {
    const projectPath = path.join(root, "project"); await fs.mkdir(projectPath);
    await new Promise(resolve => model.server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${model.server.address().port}/v1`;
    realPlugin = await prepareRealPlugin(root, host.data, baseUrl, { sourceRoot, privateData: true });
    report.pluginSnapshot = realPlugin.pluginRoot;
    report.sourceHashes = await fingerprint(realPlugin.pluginRoot);
    report.host = await host.launch();
    assert.equal(report.host.version, "0.21.0", "Use the unchanged installed v0.21.0 app");
    const provider = await host.invoke("providersCreate", { name: "Isolated image lifetime fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
      baseUrl, authKind: "api_key_and_base_url", secretValue: "fixture-only-no-provider-credentials", apiStyle: "chat_completions", supportsReasoning: false,
      models: [{ id: "image-fixture", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"], defaultThinkingLevel: "off", supportsImages: true }] });
    await host.invoke("pluginLoadDevConfirm", { path: realPlugin.pluginRoot, grantedPermissions: realPlugin.manifest.permissions });
    async function session(title) {
      const result = (await host.invoke("sessionCreate", { title, mode: "agent", projectPath, providerId: provider.provider.id, modelId: "image-fixture", thinkingLevel: "off" })).session;
      await host.invoke("sessionConfigure", result.id, { mode: "agent", permissionMode: "auto" });
      return result;
    }
    async function response(index) {
      const entry = await poll(() => network[index]?.finishedAt && network[index], "Delayed localhost image response", 20000);
      assert.equal(entry.status, 200);
      assert.ok(entry.finishedAt - entry.receivedAt >= IMAGE_DELAY_MS, "The real response must exceed the old 10-second wait");
      return entry;
    }
    for (const waitMs of [baseline ? 1000 : 0, undefined]) {
      const name = waitMs === undefined ? "generate-default-10000" : `generate-wait-${waitMs}`;
      const target = await session(name), index = model.imageRequests.length;
      const args = { requestKey: name, prompt: "A deterministic gray square for request lifetime acceptance.", ...(waitMs === undefined ? {} : { waitMs }) };
      const first = await run(target, `${name}-submit`, [...call("media_catalog", { action: "list", kind: "image" }), ...call("generate_image", args)]);
      assert.equal(value(first, "media_catalog").models.find(item => item.isDefault)?.modelRef, "media:fixture:gpt-image-2");
      const submitted = value(first, "generate_image").job;
      assert.ok(submitted?.id, "Generation must supply the original job ID");
      const entry = await response(index);
      const later = await run(target, `${name}-later-query`, call("image_job", { action: "result", jobId: submitted.id }));
      const job = value(later, "image_job").job;
      const retry = await run(target, `${name}-same-request`, call("generate_image", args));
      const retried = value(retry, "generate_image").job;
      assert.equal(job?.id, submitted.id); assert.equal(retried?.id, submitted.id);
      assert.equal(model.imageRequests.length, index + 1, "Same request and later reads must never dispatch another generation");
      const evidence = { name, jobId: job.id, submittedState: submitted.state, laterState: job.state, laterError: job.error, repeatState: retried.state,
        turnMs: first.finishedAt - first.startedAt, responseMs: entry.finishedAt - entry.receivedAt, requests: model.imageRequests.length - index };
      report.cases.push(evidence); await save();
      if (baseline) {
        assert.equal(submitted.state, "submitting");
        assert.ok(first.finishedAt < entry.finishedAt, "Baseline tool must return while its network response is pending");
        assert.equal(job.state, "unknown"); assert.equal(job.error?.code, "NETWORK_ERROR");
        assert.equal(retried.state, "unknown"); assert.equal(retried.error?.code, "NETWORK_ERROR");
        assert.equal(later.imageReceived, false);
      } else {
        for (const result of [submitted, job, retried]) assert.equal(result.state, "succeeded", JSON.stringify(result));
        for (const result of [first, later, retry]) assertImage(result);
      }
      console.log(`${baseline ? "BASELINE_CONFIRMED" : "PASS"} ${JSON.stringify(evidence)}`);
    }
    const target = await session("legacy-submit"), index = model.imageRequests.length;
    const prepared = await run(target, "legacy-prepare", call("prepare_image", { requestId: randomUUID(), profileId: "fixture", expectedRevision: 1,
      modelId: "gpt-image-2", prompt: "A deterministic legacy request lifetime square.", size: "1024x1024", quality: "low" }));
    const job = value(prepared, "prepare_image");
    assert.equal(job.state, "prepared"); assert.equal(model.imageRequests.length, index);
    const args = { jobId: job.id, requestHash: job.requestHash, confirm: true };
    const first = await run(target, "legacy-submit", call("submit_image", args));
    const submitted = value(first, "submit_image");
    const entry = await response(index);
    const later = await run(target, "legacy-later-query", call("get_image_job", { jobId: job.id }));
    const observed = value(later, "get_image_job");
    const retry = await run(target, "legacy-same-job", call("submit_image", args));
    const retried = value(retry, "submit_image");
    assert.equal(observed.id, job.id); assert.equal(retried.id, job.id);
    if (baseline) {
      assert.equal(submitted.state, "submitting"); assert.ok(first.finishedAt < entry.finishedAt);
      for (const result of [observed, retried]) { assert.equal(result.state, "unknown"); assert.equal(result.error?.code, "NETWORK_ERROR"); }
    } else {
      for (const result of [submitted, observed, retried]) assert.equal(result.state, "succeeded", JSON.stringify(result));
      const read = await run(target, "legacy-read-result", call("read_image_result", { jobId: job.id, expectedSha256: observed.result.sha256, offset: 0 }));
      const bytes = value(read, "read_image_result");
      assert.equal(bytes.eof, true); assert.equal(bytes.mimeType, "image/png");
      assert.deepEqual(Buffer.from(bytes.base64, "base64"), imageBytes);
    }
    assert.equal(model.imageRequests.length, index + 1, "Repeated legacy submit must keep the original single request");
    const legacy = { name: "legacy-submit", jobId: job.id, submittedState: submitted.state, laterState: observed.state, laterError: observed.error,
      repeatState: retried.state, turnMs: first.finishedAt - first.startedAt, responseMs: entry.finishedAt - entry.receivedAt, requests: model.imageRequests.length - index };
    report.cases.push(legacy);
    console.log(`${baseline ? "BASELINE_CONFIRMED" : "PASS"} ${JSON.stringify(legacy)}`);
    assert.deepEqual(model.failures, []);
    assert.ok(!host.windowUrls.some(url => url.includes("/real-plugin/")), "No plugin panel may be opened");
    report.passed = true;
  } catch (error) {
    report.fatal = error.stack; throw error;
  } finally {
    try { await host.stop(); }
    finally {
      model.server.closeAllConnections(); await new Promise(resolve => model.server.close(resolve));
      if (realPlugin) await realPlugin.cleanup();
      report.modelFailures = model.failures; report.imageRequests = model.imageRequests;
      report.lifecycleCaveat = host.lifecycle.some(entry => !entry.graceful)
        ? "The isolated app needed SIGKILL after its 8-second quit grace period; graceful shutdown is not proven."
        : "The isolated app exited within the fixture's quit grace period; result assertions precede shutdown.";
      await fs.writeFile(path.join(root, "runtime.log"), sanitize(host.output.join("")));
      for (const name of ["plugin.log", "lifecycle.log", "runtime.log", "tool.log"]) {
        try { await fs.writeFile(path.join(root, `host-${name}`), sanitize(await fs.readFile(path.join(host.data, "logs/app", name), "utf8"))); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await save();
      console.log(`FINAL_GATE ${JSON.stringify({ mode: report.mode, passed: report.passed, cases: report.cases, lifecycle: host.lifecycle, lifecycleCaveat: report.lifecycleCaveat, evidence: path.join(root, "evidence.json") })}`);
    }
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
