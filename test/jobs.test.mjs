import assert from "node:assert/strict";
import test from "node:test";
import { decodeBossPrivateText, inferCompanyName, jobCandidatesFromPage, jobFromPage, mergeJobInput } from "../server/jobs.mjs";

test("BOSS private-font digits are decoded", () => {
  assert.equal(decodeBossPrivateText("\uE033\uE031-\uE034\uE036K·\uE032\uE034薪"), "20-35K·13薪");
});

test("structured BOSS salaries are normalized before storage", () => {
  const job = jobFromPage({
    adapter: "boss-zhipin",
    boss: { job: { title: "AI 工程师", salary: "\uE033\uE031-\uE035\uE031K" } }
  });
  assert.equal(job.salary, "20-40K");
});

test("jobFromPage extracts common job fields", () => {
  const job = jobFromPage({
    title: "AI Agent 工程师 - 示例科技",
    url: "https://jobs.example.com/42",
    text: "深圳\n25-40K·14薪\n负责 Agent、RAG 与 Go 服务开发"
  });
  assert.equal(job.title, "AI Agent 工程师");
  assert.equal(job.company, "示例科技");
  assert.equal(job.location, "深圳");
  assert.match(job.salary, /25-40K/);
  assert.equal(job.status, "captured");
});

test("jobFromPage prefers structured BOSS job data", () => {
  const job = jobFromPage({
    adapter: "boss-zhipin",
    url: "https://www.zhipin.com/job_detail/abc.html",
    boss: { job: { title: "AI 全栈工程师", company: "盘古数魔", salary: "22-40K", location: "深圳", description: "负责 AI 与区块链应用", recruiter: "蒋女士" } }
  });
  assert.equal(job.title, "AI 全栈工程师");
  assert.equal(job.company, "盘古数魔");
  assert.equal(job.source, "boss-zhipin");
  assert.equal(job.recruiter, "蒋女士");
});

test("mergeJobInput rejects non-web URLs", () => {
  const job = mergeJobInput({ title: "测试", url: "javascript:alert(1)" });
  assert.equal(job.url, "");
});

test("jobCandidatesFromPage keeps job-like links and deduplicates URLs", () => {
  const jobs = jobCandidatesFromPage({ links: [
    { href: "https://jobs.example.com/ai", label: "AI Agent 工程师", context: "AI Agent 工程师 25-40K 深圳 示例科技" },
    { href: "https://jobs.example.com/ai", label: "重复链接", context: "AI 开发 25-40K" },
    { href: "https://jobs.example.com/about", label: "关于我们", context: "公司介绍" }
  ] });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "AI Agent 工程师");
  assert.equal(jobs[0].location, "深圳");
});

test("jobCandidatesFromPage prefers BOSS job cards", () => {
  const jobs = jobCandidatesFromPage({
    adapter: "boss-zhipin",
    boss: { jobCards: [{ url: "https://www.zhipin.com/job_detail/1.html", title: "Go + AI 工程师", company: "示例公司", salary: "25-35K", location: "北京", context: "负责 Agent 平台" }] }
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, "示例公司");
  assert.equal(jobs[0].source, "boss-zhipin");
});

test("company name falls back to BOSS card context", () => {
  assert.equal(inferCompanyName({
    title: "Agent Harness 研发工程师",
    salary: "20-25K",
    location: "深圳·龙华区·民治",
    description: "Agent Harness 研发工程师 20-25K 3-5年 本科 Java LangGraph 分布式训练 深圳计算科学研究院 深圳·龙华区·民治"
  }), "深圳计算科学研究院");
});

test("company name falls back to recruiter identity on a full detail page", () => {
  assert.equal(inferCompanyName({
    recruiter: "慧择 · HRBP",
    description: "职位描述 很长的完整 JD"
  }), "慧择");
});

test("mergeJobInput preserves a known company over a placeholder", () => {
  const job = mergeJobInput({ company: "待识别公司", title: "AI 工程师" }, { company: "示例科技" });
  assert.equal(job.company, "示例科技");
});
