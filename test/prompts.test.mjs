import assert from "node:assert/strict";
import test from "node:test";
import { jobCompatibilityPrompt, resumeOptimizationPrompt } from "../server/prompts.mjs";

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
});
