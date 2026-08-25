const DEFAULT_PHRASES = [
  /老板你?好/i,
  /非常想加入你们/,
  /可以看下我的简历/,
  /期待回复/,
  /岗位与我(?:的)?(?:经历|能力)(?:非常|很)?匹配/
];

const VERIFIED_EVIDENCE_TERMS = [
  "OnPeople", "Cherry Studio", "Go", "MCP", "Agent", "React", "TypeScript",
  "Electron", "Rust", "Python", "分布式", "模型接入", "工具调用", "权限审批",
  "任务调度", "失败恢复", "开源贡献", "正式工作"
];

export function normalizeRecruiterGreeting(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/^\s*["“”']+|["“”']+\s*$/g, "")
    .replace(/老板你?好[！!，,：:\s]*/i, "您好，")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function recruiterGreetingIssues(value, analysis = {}) {
  const greeting = normalizeRecruiterGreeting(value);
  const issues = [];
  const length = Array.from(greeting).length;
  if (length < 70) issues.push("内容过短，缺少岗位锚点或有效证据");
  if (length > 180) issues.push("内容过长，招聘者难以快速阅读");
  if (DEFAULT_PHRASES.some((pattern) => pattern.test(greeting))) issues.push("包含平台默认或空泛话术");
  if (!/方便.*沟通|可以.*聊|愿意.*沟通|期待.*交流/.test(greeting)) issues.push("缺少自然的下一步沟通邀请");

  const businessDomain = String(analysis?.businessDomain || "").trim();
  if (analysis?.needsDomainBridge === true && businessDomain) {
    const hasDomain = greeting.toLowerCase().includes(businessDomain.toLowerCase());
    const hasMigration = /可迁移|迁移到|应用到|应用于|用于.{0,12}建设|支撑.{0,12}建设/.test(greeting);
    if (!hasDomain || !hasMigration) issues.push(`缺少“${businessDomain}”跨行业业务迁移桥接`);
  }

  const matchedTerms = Array.isArray(analysis?.matchedStack) ? analysis.matchedStack.map(String) : [];
  const evidenceTerms = [...new Set([...matchedTerms, ...VERIFIED_EVIDENCE_TERMS])]
    .filter((term) => term.length > 1 && greeting.toLowerCase().includes(term.toLowerCase()));
  if (evidenceTerms.length < 2) issues.push("没有使用足够的已核实匹配证据");
  return issues;
}
