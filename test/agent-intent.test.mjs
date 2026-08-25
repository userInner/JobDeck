import assert from "node:assert/strict";
import test from "node:test";
import { isJobSearchExecutionIntent, requestedApplicationTarget } from "../server/agent-intent.mjs";

test("declarative job-search goals start the execution agent", () => {
  assert.equal(isJobSearchExecutionIntent("我找北京、上海、深圳的全栈工程师或 AI Agent 工程师岗位，优先 25K+"), true);
  assert.equal(isJobSearchExecutionIntent("帮我在北京找 AI Agent 工作"), true);
  assert.equal(isJobSearchExecutionIntent("继续投递匹配岗位"), true);
});

test("capability questions remain ordinary answers", () => {
  assert.equal(isJobSearchExecutionIntent("能不能自动找工作？"), false);
  assert.equal(isJobSearchExecutionIntent("这个 Agent 怎么实现投递循环？"), false);
});

test("application targets are extracted without confusing salary", () => {
  assert.equal(requestedApplicationTarget("帮我至少投递 30 份工作，优先 25K+"), 30);
  assert.equal(requestedApplicationTarget("我找北京 AI Agent 岗位，优先 25K+"), null);
});
