#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PROBE_ID, imageBytes, imageBase64, writeProbe, createModel, createHost, prepareRealPlugin } = require("./agent-image-host-fixture.cjs");

async function main() {
  if (process.argv.includes("--help")) {
    console.log("PI_SCRATCH_DIR=/isolated/scratch PI_DESKTOP_SOURCE=/host/source PI_DESKTOP_APP=/Applications/PI-Desktop.app node tests/agent-image.e2e.cjs [--probe-only] [--existing-private-data]");
    return;
  }
  assert.ok(process.env.PI_SCRATCH_DIR, "PI_SCRATCH_DIR is required; every temporary artifact stays under it");
  const root = await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR, "agent-image-"));
  console.log(`ARTIFACTS ${root}`);
  const host = await createHost(root), model = createModel();
  const report = { root, app: process.env.PI_DESKTOP_APP, checks: [], expectedLimitations: [], scenarios: [], lifecycle: host.lifecycle };
  const probeRoot = path.join(root, "probe");
  const projectA = path.join(root, "project-a"), projectB = path.join(root, "project-b");
  const check = (name, fn, limitation) => {
    try { fn(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) {
      const result = { name, passed: false, error: error.message };
      if (limitation) {
        try {
          limitation.observe();
          result.expectedLimitation = true;
          report.expectedLimitations.push({ name, reason: limitation.reason, observed: true });
        } catch (observationError) { result.observationError = observationError.message; }
      }
      report.checks.push(result);
      console.log(`${result.expectedLimitation ? "EXPECTED_LIMITATION" : "FAIL"} ${name}: ${error.message}`);
    }
  };
  const search = tool => ({ tool: "ToolSearch", args: { query: tool } });
  const catalogSteps = () => [search("probe_catalog"), { tool: "probe_catalog", args: { action: "list" } }];
  const imageSteps = () => [...catalogSteps(), search("probe_image"), { tool: "probe_image", args: {} }, { tool: "Skill", args: { id: `${PROBE_ID}/image-probe` } }];
  function metadata(scenario) {
    const result = scenario.results.find(result => result.name.endsWith("probe_catalog"));
    return result ? JSON.parse(typeof result.content === "string" ? result.content : result.content.map(block => block.text || "").join("")) : null;
  }
  const discovered = scenario => scenario.results.some(result => result.name.endsWith("probe_catalog"));
  const descriptor = scenario => scenario.requests.flatMap(request => request.tools || []).find(tool => tool.function?.name.endsWith("probe_catalog"))?.function;
  let providerId, realPlugin;
  async function session(title, projectPath = projectA, mode = "agent") {
    const created = (await host.invoke("sessionCreate", { title, mode, projectPath, providerId, modelId: "image-fixture", thinkingLevel: "off" })).session;
    await host.invoke("sessionConfigure", created.id, { mode, permissionMode: "auto" });
    return created;
  }
  async function run(target, name, steps = catalogSteps(), finalText) {
    console.log(`TURN ${name}`);
    const scenario = await host.turn(model, target, name, steps, finalText);
    report.scenarios.push(scenario);
    await fs.writeFile(path.join(root, "evidence.json"), JSON.stringify(report, null, 2));
    return scenario;
  }
  function assertCatalog(scenario, target, revision) {
    assert.ok(discovered(scenario), `Catalog unavailable: ${scenario.missingTool || JSON.stringify(scenario.errors)}`);
    const meta = metadata(scenario);
    assert.equal(meta.sessionId, target.id, "Plugin ctx.sessionId must match real session");
    assert.ok(typeof meta.turnId === "string" && meta.turnId.length > 0, "Plugin ctx.turnId must be present");
    assert.equal(meta.revision, revision);
    assert.deepEqual(scenario.errors, []);
  }
  function assertImage(scenario) {
    assert.equal(scenario.imageReceived, true, "Fake provider must receive the exact PNG as an image_url block");
    assert.equal(scenario.flattenedBase64, false, "No PNG Base64 may appear in text blocks");
    assert.ok(scenario.events.some(envelope => envelope.event?.type === "tool_end" && envelope.event.result?.content?.some(block => block.type === "image" && block.data === imageBase64)), "This turn must emit its own image block");
    assert.deepEqual(scenario.errors, []);
  }
  const imageCardLimitation = scenario => ({
    reason: "Installed v0.21.0 renders automatic image cards only for GenerateImages; typed plugin image blocks still reach the model.",
    observe() { assertImage(scenario); assert.deepEqual(scenario.transcript.images, []); },
  });
  const planLimitation = (scenario, tool) => ({
    reason: "Installed v0.21.0 plugin-host-process drops planSafeActions during registration, leaving this plugin tool absent in Plan mode.",
    observe() {
      assert.equal(scenario.missingTool, tool); assert.deepEqual(scenario.errors, []);
      assert.ok(scenario.requests.length > 0);
      assert.ok(scenario.requests.every(request => !(request.tools || []).some(item => item.function?.name.endsWith(`_${tool}`))));
    },
  });
  try {
    await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB)]);
    const manifest = await writeProbe(probeRoot);
    await new Promise(resolve => model.server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${model.server.address().port}/v1`;
    report.host = await host.launch();
    assert.equal(report.host.version, "0.21.0", "Compatibility gate must target the installed v0.21.0 artifact");
    const provider = await host.invoke("providersCreate", { name: "Isolated Agent image fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
      baseUrl, authKind: "api_key_and_base_url", secretValue: "fixture-only-no-provider-credentials", apiStyle: "chat_completions", supportsReasoning: false,
      models: [{ id: "image-fixture", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"], defaultThinkingLevel: "off", supportsImages: true }] });
    providerId = provider.provider.id;
    const existing = await session("Pre-install session");
    const before = await run(existing, "before-install");
    check("uninstalled probe is not discoverable", () => assert.equal(discovered(before), false));
    await host.invoke("pluginLoadDevConfirm", { path: probeRoot, grantedPermissions: manifest.permissions });
    const next = await run(existing, "existing-session-next-turn");
    check("install into existing session next turn", () => assertCatalog(next, existing, 1));
    const fresh = await session("Fresh image session");
    const image = await run(fresh, "new-session-image", imageSteps());
    check("new session catalog and execution context", () => assertCatalog(image, fresh, 1));
    check("typed image roundtrip without Base64 flattening", () => assertImage(image));
    check("plugin skill discovered without panel", () => assert.ok(JSON.stringify(image.requests[0]?.messages).includes(`${PROBE_ID}/image-probe`)));
    check("user-visible decoded transcript PNG", () => assert.ok(image.transcript.images.some(item => item.src === `data:image/png;base64,${imageBase64}` && item.width === 32 && item.height === 32 && item.visible), JSON.stringify(image.transcript.images)), imageCardLimitation(image));
    console.log(`FIRST_GATE ${JSON.stringify({ version: report.host.version, checks: report.checks, evidence: path.join(root, "evidence.json") })}`);
    await writeProbe(probeRoot, 2);
    await host.invoke("pluginReload", PROBE_ID);
    const updated = await run(fresh, "descriptor-update-existing-session");
    check("updated implementation in existing session", () => assertCatalog(updated, fresh, 2));
    check("updated tool descriptor in existing session", () => assert.match(descriptor(updated)?.description || "", /revision 2/));
    const updatedFresh = await session("Updated descriptor fresh session");
    const updateNew = await run(updatedFresh, "descriptor-update-new-session");
    check("updated tool descriptor in new session", () => { assertCatalog(updateNew, updatedFresh, 2); assert.match(descriptor(updateNew)?.description || "", /revision 2/); });
    const plan = await session("Plan-safe catalog session", projectA, "plan");
    const planResult = await run(plan, "plan-safe-catalog", [{ tool: "probe_catalog", args: { action: "list" } }]);
    check("planSafeActions read executes in plan mode", () => { assertCatalog(planResult, plan, 2); assert.equal(metadata(planResult).mode, "plan"); }, planLimitation(planResult, "probe_catalog"));
    check("unsafe image tool hidden in plan mode", () => assert.ok(!planResult.requests.flatMap(request => request.tools || []).some(tool => tool.function?.name.endsWith("probe_image"))));
    await host.invoke("pluginDisable", PROBE_ID);
    const disabled = await run(fresh, "disabled-existing-session");
    check("disabled plugin removed from existing session", () => assert.equal(discovered(disabled), false));
    const disabledNew = await run(await session("Disabled plugin fresh session"), "disabled-new-session");
    check("disabled plugin hidden from new session", () => assert.equal(discovered(disabledNew), false));
    await host.invoke("pluginEnable", PROBE_ID);
    const enabled = await run(fresh, "enabled-existing-session");
    check("re-enabled plugin available next turn", () => assertCatalog(enabled, fresh, 2));
    await host.invoke("pluginSetScope", { id: PROBE_ID, scope: { mode: "projects", projects: [projectA] } });
    const scoped = await run(fresh, "scope-allowed-existing-session");
    check("project scope allows matching session", () => assertCatalog(scoped, fresh, 2));
    const outside = await session("Outside project scope", projectB);
    const scopedOut = await run(outside, "scope-denied-new-session");
    check("project scope hides plugin outside scope", () => assert.equal(discovered(scopedOut), false));
    await host.invoke("pluginSetScope", { id: PROBE_ID, scope: { mode: "projects", projects: [projectB] } });
    const scopeChanged = await run(fresh, "scope-denied-existing-session");
    check("scope change removes existing session access", () => assert.equal(discovered(scopeChanged), false));
    await host.invoke("pluginSetScope", { id: PROBE_ID, scope: { mode: "global", projects: [] } });
    await host.stop(); report.restartedHost = await host.launch();
    const restart = await run(fresh, "restart-existing-session", imageSteps());
    check("restart restores plugin and session execution", () => assertCatalog(restart, fresh, 2));
    check("restart image remains typed", () => assertImage(restart));
    const restartedFresh = await session("Restart fresh session");
    const restartNew = await run(restartedFresh, "restart-new-session");
    check("restart fresh session discovery", () => assertCatalog(restartNew, restartedFresh, 2));
    report.completedProbe = true;
    if (!process.argv.includes("--probe-only")) {
      realPlugin = await prepareRealPlugin(root, host.data, baseUrl, { privateData: process.argv.includes("--existing-private-data") });
      report.initialRealPluginDataMode = realPlugin.initialDataMode.toString(8);
      report.realPluginVersion = realPlugin.manifest.version;
      console.log(`REAL_PLUGIN_DATA_MODE ${report.initialRealPluginDataMode}`);
      await host.invoke("pluginLoadDevConfirm", { path: realPlugin.pluginRoot, grantedPermissions: realPlugin.manifest.permissions });
      const value = (scenario, name) => {
        const result = scenario.results.find(result => result.name.endsWith(`_${name}`));
        assert.ok(result, `${name} did not execute`);
        return JSON.parse(typeof result.content === "string" ? result.content : result.content.map(block => block.text || "").join(""));
      };
      const generateArgs = { prompt: "A deterministic gray square for isolated acceptance.", requestKey: "packaged-agent-image-1", waitMs: 10000 };
      const realSteps = [search("media_catalog"), { tool: "media_catalog", args: { action: "list", kind: "image" } },
        search("generate_image"), { tool: "generate_image", args: generateArgs }, search("image_job"),
        { tool: "image_job", args: scenario => ({ action: "result", jobId: value(scenario, "generate_image").job?.id }) }];
      const real = await run(fresh, "real-plugin-generate-existing-session", realSteps);
      report.afterGenerationDataMode = ((await fs.stat(path.join(host.data, "plugins/data", realPlugin.manifest.id))).mode & 0o777).toString(8);
      check("all twelve real plugin tools registered without panel", () => {
        const prompt = real.requests[0].messages.filter(message => message.role === "system").map(message => message.content).join("\n");
        const names = [...new Set(prompt.match(/^- (plugin_bone_aimedia_services_[A-Za-z0-9_]+):/gm)?.map(line => line.slice(2, -1)) || [])];
        assert.deepEqual(names.sort(), realPlugin.manifest.contributes.agentTools.map(tool => `plugin_bone_aimedia_services_${tool.name}`).sort());
        assert.equal(names.length, 12);
      });
      check("real plugin catalog selected configured default", () => {
        const catalog = value(real, "media_catalog");
        assert.equal(catalog.ok, true); assert.equal(catalog.models.find(model => model.isDefault)?.modelRef, "media:fixture:gpt-image-2");
      });
      check("real plugin generate_image succeeds without panel", () => {
        assert.equal(value(real, "generate_image").job?.state, "succeeded"); assert.equal(model.imageRequests.length, 1); assertImage(real);
        assert.equal(report.initialRealPluginDataMode, process.argv.includes("--existing-private-data") ? "700" : "755");
        assert.equal(report.afterGenerationDataMode, "700", "First generation hardens the fresh plugin data directory");
      });
      check("real plugin image_job returns typed image", () => { assert.equal(value(real, "image_job").delivery?.status, "image-content"); assertImage(real); });
      check("real plugin user-visible transcript image", () => assert.ok(real.transcript.images.some(image => image.width === 32 && image.height === 32 && image.visible)), imageCardLimitation(real));
      const jobId = value(real, "generate_image").job?.id;
      assert.ok(jobId, "Real generation must supply a job for lifecycle verification");
      const retry = await run(fresh, "real-plugin-idempotent-retry", [search("generate_image"), { tool: "generate_image", args: generateArgs }]);
      check("same requestKey does not issue a second supplier request", () => { assert.equal(value(retry, "generate_image").job?.id, jobId); assert.equal(model.imageRequests.length, 1); assertImage(retry); });
      const exported = await run(fresh, "real-plugin-export", [search("export_image_result"), { tool: "export_image_result", args: { jobId } }]);
      const exportValue = value(exported, "export_image_result");
      check("real plugin narrow workspace export", () => {
        assert.equal(exportValue.ok, true, JSON.stringify(exportValue)); assert.equal(exportValue.status, "handoff-ready");
        assert.match(exportValue.outputPath, /^bone-media\/exports\/image-[a-f0-9-]+\.png$/);
        assert.ok(!JSON.stringify(exportValue).includes(imageBase64));
      });
      if (exportValue.ok) {
        assert.match(exportValue.command, /^node 'bone-media\/exports\/image-[a-f0-9-]+\.decode\.cjs'$/);
        const decoded = await run(fresh, "real-plugin-export-decode", [{ tool: "Bash", args: { command: exportValue.command } }]);
        check("Agent decodes exported PNG through its authorized Bash tool", () => assert.deepEqual(decoded.errors, []));
        const bytes = await fs.readFile(path.join(projectA, exportValue.outputPath));
        check("exported PNG exactly matches supplier result", () => assert.deepEqual(bytes, imageBytes));
        const preview = await run(fresh, "real-plugin-export-preview", [], `![Exported fixture PNG](${path.join(projectA, exportValue.outputPath)})`);
        check("exported image Markdown displays in actual transcript", () => assert.ok(preview.transcript.images.some(image => image.width === 32 && image.height === 32 && image.visible), preview.imageRenderError));
      }
      const unrelated = await session("Another real plugin session");
      const ownership = await run(unrelated, "real-plugin-session-isolation", [search("image_job"), { tool: "image_job", args: { action: "get", jobId } }]);
      check("real plugin prevents cross-session image access", () => assert.equal(value(ownership, "image_job").error?.code, "NOT_FOUND"));
      const realPlan = await session("Real plugin plan catalog", projectA, "plan");
      const realPlanResult = await run(realPlan, "real-plugin-plan-catalog", [{ tool: "media_catalog", args: { action: "list", kind: "image" } }]);
      check("real plugin plan-safe catalog visibility", () => assert.equal(value(realPlanResult, "media_catalog").ok, true), planLimitation(realPlanResult, "media_catalog"));
      await host.stop(); await host.launch();
      const restored = await run(fresh, "real-plugin-restart-result", [search("image_job"), { tool: "image_job", args: { action: "result", jobId } }]);
      check("real plugin result persists across app restart", () => { assert.equal(value(restored, "image_job").job?.id, jobId); assertImage(restored); assert.equal(model.imageRequests.length, 1); });
      check("no plugin panel opened", () => assert.ok(!host.windowUrls.some(url => url.includes("/real-plugin/") || url.includes("/probe/")), JSON.stringify(host.windowUrls)));
      report.completedReal = true;
    }
  } catch (error) {
    report.fatal = error.stack;
    throw error;
  } finally {
    await host.stop(); model.server.closeAllConnections();
    await new Promise(resolve => model.server.close(resolve));
    if (realPlugin) await realPlugin.cleanup();
    report.modelFailures = model.failures; report.imageRequests = model.imageRequests; report.windowUrls = host.windowUrls;
    const completed = !report.fatal && report.completedProbe === true && (process.argv.includes("--probe-only") || report.completedReal === true) && model.failures.length === 0;
    report.corePassed = completed && report.checks.every(check => check.passed || check.expectedLimitation);
    report.passed = completed && report.checks.every(check => check.passed);
    report.counts = { total: report.checks.length, passed: report.checks.filter(check => check.passed).length,
      expectedLimitations: report.expectedLimitations.length, unexpectedFailures: report.checks.filter(check => !check.passed && !check.expectedLimitation).length };
    await fs.writeFile(path.join(root, "evidence.json"), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(root, "runtime.log"), host.output.join("").replaceAll("fixture-only-no-provider-credentials", "[REDACTED]"));
    console.log(`FINAL_GATE ${JSON.stringify({ passed: report.passed, corePassed: report.corePassed, counts: report.counts, expectedLimitations: report.expectedLimitations, realPluginVersion: report.realPluginVersion, initialDataMode: report.initialRealPluginDataMode, afterGenerationDataMode: report.afterGenerationDataMode, imageRequests: model.imageRequests.length, lifecycle: host.lifecycle, evidence: path.join(root, "evidence.json") })}`);
  }
  assert.equal(report.passed, true, "Compatibility gate has failures; inspect evidence.json");
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
