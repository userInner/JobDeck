import assert from "node:assert/strict";
import test from "node:test";
import {
  bossConversationKey,
  bossConversationIdentity,
  bossMessageFingerprint,
  bossRecruiterMessageState,
  isBossRejectionOnly,
  normalizeBossText,
  resolveBossReplyJob
} from "../server/boss-replies.mjs";

const fullDescription = "负责 AI Agent 产品研发，覆盖需求分析、工作流设计、模型接入、工具调用、权限控制、任务调度、失败恢复、数据库与缓存设计、测试、部署和线上问题排查。要求熟悉 Go、TypeScript、React、Python、RAG、MCP 与分布式系统，并能够独立完成从需求到上线的工程闭环。";

function chatWith(messages, overrides = {}) {
  return {
    conversationId: "conversation-42",
    recruiter: "张女士",
    jobTitle: "AI Agent 工程师",
    company: "示例科技",
    jobUrl: "https://www.zhipin.com/job_detail/abc.html?securityId=secret",
    messages,
    composer: { valuePreview: "" },
    ...overrides
  };
}

test("normalizes BOSS private-font digits and whitespace", () => {
  assert.equal(normalizeBossText("  薪资 \uE033\uE031 - \uE034\uE031K  "), "薪资 20 - 30K");
});

test("conversation keys and recruiter fingerprints are stable", () => {
  const message = { id: "data-message-id:7", idSource: "attribute", from: "recruiter", text: "方便发一份简历吗？" };
  const left = chatWith([message]);
  const right = { ...left, recruiter: "页面偶发识别错误", jobTitle: "另一段标题" };
  assert.equal(bossConversationKey(left), bossConversationKey(right));
  assert.equal(bossMessageFingerprint(left), bossMessageFingerprint(right));
  assert.match(bossMessageFingerprint(left), /^boss-message:[a-f0-9]{64}$/);
});

test("a conversation without a durable or complete fallback identity is blocked", () => {
  const chat = chatWith([{ from: "recruiter", text: "方便介绍项目吗？" }], {
    conversationId: "",
    jobUrl: "",
    recruiter: "",
    company: "",
    jobTitle: ""
  });
  assert.equal(bossConversationIdentity(chat), "");
  assert.equal(bossConversationKey(chat), "");
  assert.equal(bossMessageFingerprint(chat), "");
  assert.equal(bossRecruiterMessageState(chat).status, "blocked");
});

test("fallback fingerprints distinguish identical repeated recruiter messages", () => {
  const first = { id: "selector:li:nth(1)", idSource: "selector", from: "recruiter", text: "方便发简历吗？" };
  const second = { id: "selector:li:nth(2)", idSource: "selector", from: "recruiter", text: "方便发简历吗？" };
  const one = chatWith([first]);
  const two = chatWith([first, second]);
  assert.notEqual(bossMessageFingerprint(one), bossMessageFingerprint(two));
});

test("last candidate message waits for a recruiter reply", () => {
  const state = bossRecruiterMessageState(chatWith([
    { from: "recruiter", text: "有 Agent 项目吗？" },
    { from: "candidate", text: "有，可以演示 OnPeople。" }
  ]));
  assert.equal(state.status, "waiting");
});

test("rejection-only notices are ignored but alternative-role questions are not", () => {
  assert.equal(isBossRejectionOnly("很遗憾，岗位暂不匹配，祝你求职顺利。"), true);
  assert.equal(isBossRejectionOnly("目前暂不考虑，感谢关注。"), true);
  assert.equal(isBossRejectionOnly("这个岗位暂不匹配，是否考虑另一个 Go 岗位？"), false);
  assert.equal(bossRecruiterMessageState(chatWith([
    { from: "recruiter", text: "很遗憾，岗位已关闭，祝你求职顺利。" }
  ])).status, "ignored");
});

test("a platform card or unknown final record blocks an earlier recruiter message", () => {
  const state = bossRecruiterMessageState(chatWith([
    { from: "recruiter", text: "可以介绍项目吗？" },
    { from: "system", text: "你与该职位竞争者 PK 情况" }
  ]));
  assert.equal(state.status, "blocked");
  assert.match(state.reason, /平台通知|来源不明/);
});

test("an existing composer draft blocks automatic handling", () => {
  const state = bossRecruiterMessageState(chatWith([
    { from: "recruiter", text: "可以介绍项目吗？" }
  ], { composer: { valuePreview: "这是我正在编辑的草稿" } }));
  assert.equal(state.status, "blocked");
});

test("processed and pending fingerprints are deduplicated", () => {
  const chat = chatWith([{ from: "recruiter", text: "可以介绍项目吗？" }]);
  const fingerprint = bossMessageFingerprint(chat);
  assert.equal(bossRecruiterMessageState(chat, { processed: { [fingerprint]: { sentAt: "now" } } }).status, "duplicate");
  const pending = bossRecruiterMessageState(chat, { pending: { fingerprint } });
  assert.equal(pending.status, "duplicate");
  assert.equal(pending.pending, true);
  assert.equal(bossRecruiterMessageState(chat).status, "eligible");
});

test("resolves a complete JD by canonical job URL first", () => {
  const result = resolveBossReplyJob(chatWith([]), [
    { id: "wrong", title: "AI Agent 工程师", company: "示例科技", url: "https://www.zhipin.com/job_detail/wrong.html", description: fullDescription },
    { id: "right", title: "另一个页面标题", company: "页面公司", url: "https://www.zhipin.com/job_detail/abc.html#top", description: fullDescription }
  ]);
  assert.equal(result.status, "resolved");
  assert.equal(result.matchedBy, "job-url");
  assert.equal(result.job.id, "right");
});

test("treats an explicit chat job URL as authoritative instead of reusing a stale same-name JD", () => {
  const result = resolveBossReplyJob(chatWith([]), [
    {
      id: "stale-same-identity",
      title: "AI Agent 工程师",
      company: "示例科技",
      url: "https://www.zhipin.com/job_detail/another-role.html",
      description: fullDescription
    }
  ]);

  assert.equal(result.status, "missing");
  assert.equal(result.matchedBy, "none");
  assert.match(result.reason, /完整 JD|当前对话/);
});

test("resolves by title and company before the unique-title fallback", () => {
  const result = resolveBossReplyJob(chatWith([], { jobUrl: "" }), [
    { id: "other", title: "AI Agent 工程师", company: "另一家公司", description: fullDescription },
    { id: "expected", title: "AI Agent 工程师（J12345）", company: "示例科技", description: fullDescription }
  ]);
  assert.equal(result.status, "resolved");
  assert.equal(result.matchedBy, "title-company");
  assert.equal(result.job.id, "expected");
});

test("refuses to bind a complete JD by title alone when company is unavailable", () => {
  const result = resolveBossReplyJob(chatWith([], { jobUrl: "", company: "待识别公司" }), [
    { id: "expected", title: "AI Agent 工程师", company: "示例科技", description: fullDescription },
    { id: "other", title: "Go 后端工程师", company: "示例科技", description: fullDescription }
  ]);
  assert.equal(result.status, "missing");
  assert.equal(result.matchedBy, "none");
});

test("never binds a title-only chat when the same role exists at multiple companies", () => {
  const result = resolveBossReplyJob(chatWith([], { jobUrl: "", company: "" }), [
    { id: "one", title: "AI Agent 工程师", company: "甲公司", description: fullDescription },
    { id: "two", title: "AI Agent 工程师", company: "乙公司", description: fullDescription }
  ]);
  assert.equal(result.status, "missing");
  assert.equal(result.candidates.length, 0);
});

test("requires at least 120 characters of JD content", () => {
  const result = resolveBossReplyJob(chatWith([]), [
    { id: "short", title: "AI Agent 工程师", company: "示例科技", url: "https://www.zhipin.com/job_detail/abc.html", description: "负责 Agent 开发" }
  ]);
  assert.equal(result.status, "missing");
  assert.match(result.reason, /120/);
});
