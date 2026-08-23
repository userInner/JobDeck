const BOSS_CITY_CODES = new Map([
  ["北京", "101010100"],
  ["深圳", "101280600"],
  ["远程", "100010000"]
]);

export function buildAutomaticSearchPlans(candidate, fallbackKeyword = "AI Agent") {
  const roleText = (candidate?.targetRoles || []).join(" ");
  const queries = [];
  if (/AI|Agent|智能体/i.test(roleText)) queries.push("AI Agent", "智能体开发", "AI 应用全栈", "AIGC 全栈");
  if (/LLM|大模型|AI 应用/i.test(roleText)) queries.push("LLM 应用", "AI 应用全栈", "AIGC 全栈");
  if (/Go/i.test(roleText)) queries.push("Go 后端", "Go AI");
  if (!queries.length) queries.push(fallbackKeyword || candidate?.targetRoles?.[0] || "AI Agent");
  const locations = (candidate?.locations || []).filter((location) => BOSS_CITY_CODES.has(location));
  if (!locations.length) throw new Error("请先在设置中填写受支持的期望城市：北京、深圳或远程");
  return locations.flatMap((location) => [...new Set(queries)].map((keyword) => ({ keyword, location })));
}

export function bossSearchUrl(keyword, location) {
  const url = new URL("https://www.zhipin.com/web/geek/jobs");
  url.searchParams.set("query", location === "远程" ? `${keyword} 远程` : keyword);
  url.searchParams.set("city", BOSS_CITY_CODES.get(location) || "100010000");
  return url.href;
}
