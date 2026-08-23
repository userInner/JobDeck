import assert from "node:assert/strict";
import test from "node:test";
import { autopilotCandidateIds, findPageControl, rankAnalyzedJobs, verificationReason } from "../server/autopilot.mjs";

test("autopilot stops on verification pages", () => {
  assert.equal(verificationReason({ text: "请完成安全验证后继续访问" }), "安全验证");
  assert.equal(verificationReason({ text: "正常职位详情" }), "");
});

test("autopilot uses only an unambiguous enabled control", () => {
  const page = { interactives: [
    { tag: "button", label: "立即沟通", selector: "#contact", disabled: false },
    { tag: "button", label: "发送", selector: "#disabled", disabled: true }
  ] };
  assert.equal(findPageControl(page, /^立即沟通$/)?.selector, "#contact");
  assert.equal(findPageControl(page, /^发送$/), undefined);
});

test("autopilot excludes contacted jobs but lets the user reconsider skipped jobs", () => {
  const jobs = [
    { id: "a", status: "captured" },
    { id: "b", status: "sent" },
    { id: "c", status: "skipped" },
    { id: "d", status: "analyzed" }
  ];
  assert.deepEqual(autopilotCandidateIds(jobs, ["a", "b", "c", "d"]), ["a", "c", "d"]);
});

test("ranking keeps user-selectable low scores and sorts descending", () => {
  const jobs = [
    { id: "low", score: 42, analysis: { verdict: "跳过" }, greeting: "真实说明" },
    { id: "high", score: 88, analysis: { verdict: "推荐" }, greeting: "定制招呼" }
  ];
  assert.deepEqual(rankAnalyzedJobs(jobs, ["low", "high"]).map((job) => job.id), ["high", "low"]);
});
