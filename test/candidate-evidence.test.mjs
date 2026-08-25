import assert from "node:assert/strict";
import test from "node:test";
import { bossResumeEvidence, hasCandidateEvidence } from "../server/candidate-evidence.mjs";

test("candidate matching evidence prefers relevant BOSS resume sections", () => {
  const page = {
    boss: {
      resume: {
        sections: ["个人信息 18000000000", "工作经历 Go 后端"],
        sectionDetails: [
          { key: "other", text: "个人信息 18000000000" },
          { key: "workExperience", text: "工作经历\nGo 分布式后端与消息队列" },
          { key: "projectExperience", text: "项目经历\nAI Agent、MCP、工具调用" }
        ]
      }
    }
  };
  const evidence = bossResumeEvidence(page);
  assert.match(evidence, /Go 分布式后端/);
  assert.match(evidence, /AI Agent/);
  assert.doesNotMatch(evidence, /18000000000/);
});

test("candidate evidence requires facts or a meaningful resume body", () => {
  assert.equal(hasCandidateEvidence({ facts: [], resumeText: "很短" }), false);
  assert.equal(hasCandidateEvidence({ facts: ["具备 Go 后端经验"], resumeText: "" }), true);
  assert.equal(hasCandidateEvidence({ facts: [], resumeText: "A".repeat(300) }), true);
});
