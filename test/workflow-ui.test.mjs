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

test("automatic resume action uses the single composite endpoint", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /action === "auto-resume"/);
  assert.match(source, /\/api\/workflow\/resume\/auto/);
});

test("automatic job search asks for and shows the sixty-application goal", () => {
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(source, /targetApplications: 60/);
  assert.match(source, /至少验证沟通 60 个匹配岗位/);
  assert.match(source, /已发送 \$\{autopilot\.sent \|\| 0\}\/\$\{autopilot\.targetApplications \|\| 60\}/);
});
