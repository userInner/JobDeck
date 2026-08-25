import assert from "node:assert/strict";
import test from "node:test";
import { jobCompatibilityPrompt, recruiterGreetingPrompt, resumeOptimizationPrompt } from "../server/prompts.mjs";
import { normalizeRecruiterGreeting, recruiterGreetingIssues } from "../server/greeting.mjs";

test("resume optimization keeps employment, independent projects and open source separate", () => {
  const prompt = resumeOptimizationPrompt({ sections: ["个人优势"], text: "在线简历" }, { score: 64 }, {
    status: "已毕业",
    targetRoles: ["AI Agent 工程师"],
    locations: ["深圳"],
    salaryFloorK: 25,
    salaryUpperTargetK: 30,
    facts: ["独立开发示例 Agent 项目"],
    resumeText: ""
  });
  assert.match(prompt, /正式工作经历、独立项目和开源贡献必须明确分开/);
  assert.match(prompt, /不能改写成正式任职/);
  assert.match(prompt, /可直接粘贴/);
});

test("bulk compatibility mode uses a binary decision without score thresholds", () => {
  const prompt = jobCompatibilityPrompt({
    title: "Go + AI 后端工程师",
    company: "示例公司",
    description: "负责 Agent 工具调用与 Go 服务开发"
  }, {
    status: "已毕业",
    targetRoles: ["AI Agent 工程师"],
    locations: ["深圳"],
    salaryFloorK: 25,
    salaryUpperTargetK: 30,
    facts: ["独立开发示例 Agent 项目"],
    resumeText: ""
  });
  assert.match(prompt, /不要计算分数/);
  assert.match(prompt, /"matches": true \| false/);
  assert.match(prompt, /技术栈是否相符/);
  assert.match(prompt, /岗位和城市已经由用户在 BOSS 求职期望中确定/);
  assert.doesNotMatch(prompt, /目标岗位：AI Agent 工程师/);
  assert.doesNotMatch(prompt, /目标地点：深圳/);
  assert.doesNotMatch(prompt, /薪资底线：25K/);
  assert.match(prompt, /第一句必须点出这个 JD 独有的业务场景/);
  assert.match(prompt, /正式经历用“正式工作中”/);
  assert.match(prompt, /不要罗列完整技术栈/);
});

test("recruiter greeting rules reject generic BOSS copy and normalize visible noise", () => {
  const normalized = normalizeRecruiterGreeting("**老板你好！** 非常想加入你们 😊\n可以看下我的简历，期待回复");
  assert.equal(normalized, "您好，非常想加入你们 可以看下我的简历，期待回复");
  assert.ok(recruiterGreetingIssues(normalized, { matchedStack: ["Go", "MCP"] }).length >= 3);
});

test("a concise JD-specific greeting passes the local quality gate", () => {
  const greeting = "您好，看到岗位重点是将合同审查与知识库能力落到企业法务流程。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批；这些工程经验可迁移到法务 AI 产品建设。如果方向合适，方便进一步沟通吗？";
  assert.deepEqual(recruiterGreetingIssues(greeting, { matchedStack: ["Go", "MCP"] }), []);
});

test("greeting rewrite prompt carries the JD, evidence boundary and failed-quality reason", () => {
  const prompt = recruiterGreetingPrompt({
    title: "AI 全栈工程师",
    company: "示例法务科技",
    description: "负责合同审查和企业知识库"
  }, {
    facts: ["独立开发 OnPeople"]
  }, {
    matchedStack: ["Go", "MCP"]
  }, "老板你好", ["包含平台默认或空泛话术"]);
  assert.match(prompt, /合同审查和企业知识库/);
  assert.match(prompt, /独立开发 OnPeople/);
  assert.match(prompt, /包含平台默认或空泛话术/);
  assert.match(prompt, /90 到 150 字/);
});

test("greeting rules prefer verified OnPeople and Cherry Studio evidence when relevant", () => {
  const prompt = recruiterGreetingPrompt({
    title: "AI Agent 全栈工程师",
    company: "示例公司",
    description: "建设 Agent Runtime、工具调用与桌面工作台"
  }, {
    facts: [
      "独立开发基于 OpenAI Codex App Server 的 OnPeople Agent 工作台",
      "Cherry Studio GitHub 5 万+ Star、前 30 贡献者"
    ]
  }, { matches: true }, "原始招呼");

  assert.match(prompt, /OpenAI Codex App Server/);
  assert.match(prompt, /5 万\+ Star、前 30 贡献者/);
  assert.match(prompt, /不要把这些事实套用给其他候选人/);
});

test("cross-industry greetings bridge verified engineering evidence to the JD domain", () => {
  const prompt = recruiterGreetingPrompt({
    title: "法律 AI 全栈工程师",
    company: "示例法务科技",
    description: "建设合同审查、企业知识库和智能法务工作流"
  }, {
    facts: ["正式工作使用 Go 开发分布式后端", "独立开发 OnPeople Agent 工作台"]
  }, { matchedStack: ["Go", "Agent"] }, "原始招呼");

  assert.match(prompt, /这些工程经验可以迁移到法律 AI 产品建设/);
  assert.match(prompt, /从 JD 提取具体业务领域/);
  assert.match(prompt, /不得暗示候选人已有该行业经验/);
});
