import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("dashboard workflow exposes exactly the two primary automatic actions", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = source.indexOf("const actions = `");
  const end = source.indexOf('$("#workflowActions").innerHTML = actions;', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const actions = source.slice(start, end);
  assert.equal((actions.match(/<button/g) || []).length, 2);
  assert.match(source, /const resumeLabel = resumeBusy \? "正在自动修改简历…" : "自动修改简历"/);
  assert.match(source, /const jobLabel = jobsBusy \? "停止自动找工作" : "自动找工作"/);
  assert.doesNotMatch(actions, /分析当前候选|手动检查候选|继续扫描列表/);
});

test("masthead exposes a compact companion extension download", () => {
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../web/styles.css", import.meta.url), "utf8");
  assert.match(html, /class="companion-download"/);
  assert.match(html, />安装配套插件<\/a>/);
  assert.match(html, /href="\/downloads\/JobDeck-Chrome-Extension-v0\.17\.0\.zip"/);
  assert.match(html, /download="JobDeck-Chrome-Extension-v0\.17\.0\.zip"/);
  assert.match(css, /\.companion-download\s*\{/);
});

test("automatic resume action uses the single composite endpoint", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /action === "auto-resume"/);
  assert.match(source, /\/api\/workflow\/resume\/auto/);
});

test("settings no longer duplicate BOSS job expectations", () => {
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="targetForm"/);
  assert.doesNotMatch(html, /目标岗位（/);
  assert.doesNotMatch(html, /月薪底线 K/);
  assert.doesNotMatch(html, /boss-source-panel/);
  assert.doesNotMatch(source, /targetForm/);
});

test("automatic job search asks for and shows the sixty-application goal", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /targetApplications: 60/);
  assert.match(source, /至少验证沟通 60 个匹配岗位/);
  assert.match(source, /已发送 \$\{autopilot\.sent \|\| 0\}\/\$\{autopilot\.targetApplications \|\| 60\}/);
});

test("automatic job search endpoint starts the goal agent instead of a monolithic background loop", () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf('app.post("/api/workflow/autopilot/run"');
  const end = source.indexOf('app.post("/api/workflow/autopilot/apply-selected"', start);
  assert.ok(start >= 0 && end > start, "automatic job search endpoint source range is present");
  const endpoint = source.slice(start, end);
  assert.match(endpoint, /agentRuntime\(\)/);
  assert.match(endpoint, /\.start\(\{/);
  assert.match(endpoint, /jobs:apply/);
  assert.doesNotMatch(endpoint, /startAutomaticJobSearch/);
  assert.doesNotMatch(source, /async function runAutomaticJobSearch/);
});

test("a server restart checkpoints an active goal as recoverable instead of discarding it", () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const start = source.indexOf("tenantRuntime.setTenantInitializer");
  const end = source.indexOf('app.get("/api/health"', start);
  assert.ok(start >= 0 && end > start, "tenant initializer source range is present");
  const initializer = source.slice(start, end);
  assert.match(initializer, /status: "recoverable"/);
  assert.match(initializer, /recoveryReason: "server-restart"/);
  assert.match(initializer, /recovery-pending-verification/);
  assert.match(initializer, /原求职目标和外部操作检查点已经保留/);
});

test("automatic job search resumes the same durable run and keeps external-send checkpoints", () => {
  const source = fs.readFileSync(new URL("../server/index.mjs", import.meta.url), "utf8");
  const helperStart = source.indexOf("function resumeOrInitializeAutomaticJobSearchGoal");
  const helperEnd = source.indexOf("function activeAutopilotGoal", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "recovery helper source range is present");
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /runId: previous\.runId/);
  assert.match(helper, /context\.pendingSendEvidence\?\.jobId/);
  assert.match(helper, /externalCheckpointPhases/);
  assert.doesNotMatch(helper, /sent: 0/);
  assert.doesNotMatch(helper, /plans: \[\]/);
  assert.doesNotMatch(helper, /pendingSendEvidence: null/);

  const endpointStart = source.indexOf('app.post("/api/workflow/autopilot/run"');
  const endpointEnd = source.indexOf('app.post("/api/workflow/autopilot/apply-selected"', endpointStart);
  const endpoint = source.slice(endpointStart, endpointEnd);
  assert.match(endpoint, /resumeOrInitializeAutomaticJobSearchGoal\(targetApplications\)/);
  assert.match(endpoint, /goalResult\.resumed/);
  assert.doesNotMatch(endpoint, /initializeAutomaticJobSearchGoal\(targetApplications\)/);
});
