import assert from "node:assert/strict";
import test from "node:test";
import { bossSearchUrl, buildBossExpectationPlans } from "../server/search-plan.mjs";

test("automatic searches are derived only from BOSS saved expectations", () => {
  const plans = buildBossExpectationPlans([
    { label: "全栈工程师(深圳)", role: "全栈工程师", location: "深圳" },
    { label: "AI Agent工程师(北京)", role: "AI Agent工程师", location: "北京" },
    { label: "全栈工程师(深圳)", role: "全栈工程师", location: "深圳" }
  ]);
  assert.deepEqual(plans, [
    { expectationLabel: "全栈工程师(深圳)", role: "全栈工程师", location: "深圳" },
    { expectationLabel: "AI Agent工程师(北京)", role: "AI Agent工程师", location: "北京" }
  ]);
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
