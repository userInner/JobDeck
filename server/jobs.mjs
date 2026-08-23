import crypto from "node:crypto";

export function decodeBossPrivateText(value) {
  return String(value || "").replace(/[\uE031-\uE03A]/g, (character) => (
    String(character.codePointAt(0) - 0xE031)
  ));
}

function clean(value, limit = 300) {
  return decodeBossPrivateText(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href.slice(0, 1200) : "";
  } catch {
    return "";
  }
}

function meaningfulCompany(value) {
  const normalized = clean(value, 120);
  return normalized && !/^(?:待识别公司|未知公司|公司待识别|-)$/.test(normalized) ? normalized : "";
}

export function inferCompanyName(input = {}) {
  const direct = meaningfulCompany(input.company);
  if (direct) return direct;

  const recruiter = clean(input.recruiter, 160);
  const recruiterCompany = meaningfulCompany(recruiter.split(/\s*[·|｜]\s*/)[0]);
  if (recruiterCompany && /(?:HR|招聘|人事|猎头|经理|主管|BP|顾问)/i.test(recruiter)) return recruiterCompany;

  const rawContext = clean(input.context || input.description || "", 3200);
  if (!rawContext || rawContext.length > 1500 || /职位描述|岗位职责|任职要求/.test(rawContext)) return "待识别公司";
  let context = rawContext;
  for (const value of [input.title, input.salary]) {
    const token = clean(value, 240);
    if (token) context = context.replace(token, " ");
  }
  const location = clean(input.location, 120);
  if (location) {
    const index = context.lastIndexOf(location);
    if (index >= 0) context = context.slice(0, index);
  } else {
    context = context.replace(/(?:全国|北京|深圳|上海|广州|杭州|成都|武汉|南京|苏州|天津|重庆|西安|长沙|郑州|石家庄|东莞|佛山|厦门|青岛|合肥|济南|福州|宁波|无锡|远程)(?:[·\s][^\s]{1,24}){0,3}\s*$/, " ");
  }
  const tokens = context.split(/\s+/).map((value) => clean(value, 120)).filter(Boolean);
  const rejected = /^(?:经验不限|学历不限|本科|大专|硕士|博士|应届生|其他|[1-9]\d*-[1-9]\d*年|[1-9]\d*年以内|Java|Python|Go|Golang|React|Vue|Node\.js|FastAPI|Django|SpringCloud|MySQL|Redis|Docker|Kubernetes|Agent|AI|LLM|RAG|MCP|skill)$/i;
  const inferred = [...tokens].reverse().find((value) => !rejected.test(value) && value.length >= 2 && value.length <= 60);
  return meaningfulCompany(inferred) || "待识别公司";
}

export function jobFromPage(page) {
  if (page.adapter === "boss-zhipin" && page.boss?.job) {
    const source = page.boss.job;
    const company = inferCompanyName({ ...source, description: source.description || page.text });
    return {
      id: crypto.randomUUID(),
      title: clean(source.title || "待识别岗位"),
      company,
      salary: clean(source.salary || "", 80),
      location: clean(source.location || "", 80),
      url: safeWebUrl(source.url || page.url),
      description: decodeBossPrivateText(source.description || page.text || "").slice(0, 20_000),
      recruiter: clean(source.recruiter || "", 120),
      source: "boss-zhipin",
      status: "captured",
      score: null,
      analysis: null,
      greeting: "",
      capturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
  const titleParts = clean(page.title).split(/\s*[-|—_]\s*/).filter(Boolean);
  const title = titleParts[0] || "待识别岗位";
  const company = titleParts.length > 1 ? titleParts[1] : "待识别公司";
  const text = decodeBossPrivateText(page.text || "");
  const salary = text.match(/\b\d{1,3}\s*[-–—]\s*\d{1,3}K(?:·\d+薪)?/i)?.[0] || "";
  const location = text.match(/(?:北京|深圳|上海|杭州|广州|成都|武汉|南京|苏州|远程)/)?.[0] || "";
  return {
    id: crypto.randomUUID(),
    title,
    company,
    salary,
    location,
    url: safeWebUrl(page.url),
    description: text.slice(0, 20_000),
    status: "captured",
    score: null,
    analysis: null,
    greeting: "",
    capturedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function mergeJobInput(input, existing = {}) {
  const company = inferCompanyName({
    ...existing,
    ...input,
    company: meaningfulCompany(input.company) || meaningfulCompany(existing.company),
    context: input.context || input.description || existing.description
  });
  return {
    ...existing,
    title: clean(input.title || existing.title || "待识别岗位"),
    company,
    salary: clean(input.salary || existing.salary || "", 80),
    location: clean(input.location || existing.location || "", 80),
    url: safeWebUrl(input.url || existing.url || ""),
    description: decodeBossPrivateText(input.description ?? existing.description ?? "").slice(0, 30_000),
    status: clean(input.status || existing.status || "saved", 40),
    updatedAt: new Date().toISOString()
  };
}

export function jobCandidatesFromPage(page) {
  const rolePattern = /(?:AI|Agent|LLM|RAG|工程师|开发|后端|全栈|算法|研发|智能体)/i;
  const salaryPattern = /\b\d{1,3}\s*[-–—]\s*\d{1,3}K(?:·\d+薪)?/i;
  const seen = new Set();
  const structuredCards = page.adapter === "boss-zhipin" ? page.boss?.jobCards || [] : [];
  const structured = structuredCards.flatMap((card) => {
    const url = safeWebUrl(card.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const company = inferCompanyName(card);
    return [{
      id: crypto.randomUUID(), title: clean(card.title || "待识别岗位"), company,
      salary: clean(card.salary || "", 80), location: clean(card.location || "", 80), url,
      description: decodeBossPrivateText(card.context || "").slice(0, 3000), source: "boss-zhipin", status: "captured",
      score: null, analysis: null, greeting: "", browserTarget: { selector: card.selector, point: card.point, bounds: card.bounds },
      capturedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }];
  });
  if (structured.length) return structured.slice(0, 30);
  return (page.links || []).flatMap((link) => {
    const url = safeWebUrl(link.href);
    const label = clean(link.label, 200);
    const context = clean(link.context, 700);
    if (!url || seen.has(url) || !rolePattern.test(`${label} ${context}`)) return [];
    if (!salaryPattern.test(context) && label.length < 4) return [];
    seen.add(url);
    const title = rolePattern.test(label) ? label : context.match(/[^|/·]{2,60}(?:工程师|开发|后端|全栈|算法|研发)/i)?.[0] || label || "待识别岗位";
    const salary = context.match(salaryPattern)?.[0] || "";
    const location = context.match(/(?:北京|深圳|上海|杭州|广州|成都|武汉|南京|苏州|远程)/)?.[0] || "";
    const residue = clean(context.replace(title, " ").replace(salary, " ").replace(location, " "), 80);
    const company = inferCompanyName({ title, salary, location, context })
      || (residue && residue.length <= 40 ? residue : "待识别公司");
    return [{
      id: crypto.randomUUID(), title, company,
      salary,
      location,
      url, description: context, status: "captured", score: null, analysis: null, greeting: "",
      capturedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }];
  }).slice(0, 30);
}
