import assert from "node:assert/strict";
import test from "node:test";
import { bossSearchUrl, buildAutomaticSearchPlans } from "../server/search-plan.mjs";

test("automatic searches use only configured expected locations", () => {
  const plans = buildAutomaticSearchPlans({
    targetRoles: ["AI Agent 工程师", "Go + AI 后端工程师"],
    locations: ["北京", "深圳", "远程"]
  });
  assert.deepEqual([...new Set(plans.map((plan) => plan.location))], ["北京", "深圳", "远程"]);
  assert.equal(plans.some((plan) => plan.location === "石家庄"), false);
  assert.equal(plans.some((plan) => plan.keyword === "AI Agent"), true);
  assert.equal(plans.some((plan) => plan.keyword === "智能体开发"), true);
  assert.equal(plans.some((plan) => plan.keyword === "AI 应用全栈"), true);
  assert.equal(plans.some((plan) => plan.keyword === "Go 后端"), true);
  assert.equal(plans.some((plan) => plan.keyword === "Go AI"), true);
});

test("BOSS search URLs encode the expected city instead of browser location", () => {
  const beijing = new URL(bossSearchUrl("AI Agent", "北京"));
  const shenzhen = new URL(bossSearchUrl("Go 后端", "深圳"));
  const remote = new URL(bossSearchUrl("LLM 应用", "远程"));
  assert.equal(beijing.searchParams.get("city"), "101010100");
  assert.equal(shenzhen.searchParams.get("city"), "101280600");
  assert.equal(remote.searchParams.get("city"), "100010000");
  assert.match(remote.searchParams.get("query"), /远程/);
});
