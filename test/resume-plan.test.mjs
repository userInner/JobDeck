import assert from "node:assert/strict";
import test from "node:test";
import { buildResumeWritePlan } from "../server/resume-plan.mjs";

test("resume write plan separates employment, projects, open source and verified skills", () => {
  const plan = buildResumeWritePlan({ fields: [
    { key: "targetRoles", replacement: "AI Agent 工程师" },
    { key: "personalAdvantage", replacement: "Go 后端与 AI Agent。" },
    { key: "workExperience", replacement: "Example Inc｜全栈工程师｜2025.03-至今\n负责示例产品研发。\n\nExample Tech｜后端工程师｜2024.05-2025.02\n负责分布式服务。" },
    { key: "projectExperience", replacement: "ExampleAgent｜独立项目｜跨平台 AI Agent\n独立开发 Agent 工作平台。\n项目证据：完整工具调用链路。\n技术栈：Electron、Rust" },
    { key: "openSource", replacement: "Example OSS｜个人开源贡献\n参与跨平台 AI 客户端开发。\n技术栈：TypeScript、Electron" }
  ] }, { facts: ["具备 Telegram Bot 与交易行情机器人经验"] });
  assert.equal(plan.personalAdvantage.replacement, "Go 后端与 AI Agent。");
  assert.equal(plan.workExperience[0].match, "Example Inc");
  assert.match(plan.workExperience[1].content, /负责分布式服务/);
  assert.equal(plan.projectExperience[0].role, "个人开源贡献");
  assert.equal(plan.projectExperience[1].role, "独立项目");
  assert.match(plan.skills.appendLines[0], /Telegram Bot/);
  assert.equal(plan.requiresConfirmation.length, 3);
});

test("resume write plan keeps blank-line project subsections inside their parent record", () => {
  const plan = buildResumeWritePlan({ fields: [
    { key: "projectExperience", replacement: "ExampleAgent｜独立项目\nAgent 工作平台。\n\n核心实现：\n- 工具调用\n- 权限审批\n\n技术栈：Electron、Rust\n\nResearchHelper｜个人工具项目\n文献研究工具。" },
    { key: "openSource", replacement: "Example OSS｜个人开源贡献\n跨平台客户端贡献。\n\n代表性贡献：\n- 代理适配\n- 自动化测试\n\n技术栈：TypeScript\n项目链接：https://github.com/example/project" }
  ] }, {});
  assert.deepEqual(plan.projectExperience.map((entry) => entry.match), ["Example OSS", "ExampleAgent", "ResearchHelper"]);
  assert.match(plan.projectExperience[0].description, /代表性贡献/);
  assert.match(plan.projectExperience[1].description, /核心实现/);
  assert.equal(plan.projectExperience[0].sourceKey, "openSource");
  assert.equal(plan.projectExperience[1].sourceKey, "projectExperience");
});
