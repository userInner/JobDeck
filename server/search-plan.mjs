const BOSS_CITY_CODES = new Map([
  ["北京", "101010100"],
  ["深圳", "101280600"],
  ["远程", "100010000"]
]);

export function buildBossExpectationPlans(expectationOptions = []) {
  const seen = new Set();
  return expectationOptions.flatMap((item) => {
    const label = String(item?.label || "").trim();
    if (!label || seen.has(label)) return [];
    seen.add(label);
    return [{
      expectationLabel: label,
      role: String(item?.role || label).trim(),
      location: String(item?.location || "全国").trim() || "全国"
    }];
  });
}

export function bossSearchUrl(keyword, location) {
  const url = new URL("https://www.zhipin.com/web/geek/jobs");
  url.searchParams.set("query", location === "远程" ? `${keyword} 远程` : keyword);
  url.searchParams.set("city", BOSS_CITY_CODES.get(location) || "100010000");
  return url.href;
}
