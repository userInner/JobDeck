import assert from "node:assert/strict";
import test from "node:test";
import { GoalAgentRuntime } from "../server/agent-runtime.mjs";

function fakeStore() {
  return {
    state: { workflow: { updatedAt: null, agent: { status: "idle", steps: [] } } },
    activities: [],
    update(mutator) { return mutator(this.state); },
    addActivity(message) { this.activities.push(message); }
  };
}

async function waitUntil(predicate, timeout = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("goal agent observes, replans, executes tools and finishes by verified progress", async () => {
  const store = fakeStore();
  const calls = [];
  const decisions = [
    { type: "tool", tool: "inspect", arguments: {}, plan: ["观察", "执行"], message: "先观察" },
    { type: "tool", tool: "work", arguments: { count: 3 }, plan: ["执行", "验证"], message: "继续执行" },
    { type: "finish", plan: [], message: "已验证目标完成" }
  ];
  let observedToolData = null;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep({ task }) {
      observedToolData = task.steps?.at(-1)?.resultData || observedToolData;
      return decisions.shift();
    } },
    tools: [
      { name: "inspect", description: "观察", input: {}, risk: "read", async execute() { calls.push("inspect"); return { progress: true, summary: "观察完成", data: { connected: true } }; } },
      { name: "work", description: "执行", input: {}, risk: "read", async execute(args) { calls.push(`work:${args.count}`); return { progress: true, summary: "完成3项" }; } }
    ],
    observe: async () => ({ calls: [...calls] }),
    waitStatus: async () => null
  });
  runtime.start({ goal: "完成3项", sourceText: "请完成3项", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "complete");
  assert.deepEqual(calls, ["inspect", "work:3"]);
  assert.deepEqual(observedToolData, { connected: true });
  assert.equal(store.state.workflow.agent.message, "已验证目标完成");
  assert.equal(store.state.workflow.agent.steps.at(-1).kind, "finish");
  runtime.close();
});

test("goal agent cannot grant itself an external-write scope", async () => {
  const store = fakeStore();
  let executed = false;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() { return { type: "tool", tool: "apply", arguments: {}, plan: ["投递"], message: "准备投递" }; } },
    tools: [{ name: "apply", description: "发送岗位沟通", input: {}, risk: "jobs:apply", async execute() { executed = true; return { progress: true }; } }],
    observe: async () => ({}),
    waitStatus: async () => null
  });
  runtime.start({ goal: "看看岗位", sourceText: "看看岗位", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "needs-confirmation");
  assert.equal(executed, false);
  assert.match(store.state.workflow.agent.message, /额外授权/);
  runtime.close();
});

test("goal agent resumes planning after a background tool reaches a terminal state", async () => {
  const store = fakeStore();
  let backgroundDone = false;
  let decisions = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      decisions += 1;
      return decisions === 1
        ? { type: "tool", tool: "background", arguments: {}, plan: ["启动", "等待", "验证"], message: "启动任务" }
        : { type: "finish", plan: [], message: "后台结果已验证" };
    } },
    tools: [{ name: "background", description: "后台工作", input: {}, risk: "read", async execute() { return { progress: true, waitFor: "work", summary: "后台运行中" }; } }],
    observe: async () => ({ backgroundDone }),
    waitStatus: async () => backgroundDone ? { done: true, success: true, progress: true, summary: "后台已完成" } : { done: false, summary: "后台运行中" }
  });
  runtime.start({ goal: "等待后台完成", sourceText: "等待后台完成", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "waiting");
  backgroundDone = true;
  await runtime.tickWaiting();
  await waitUntil(() => store.state.workflow.agent.status === "complete");
  assert.equal(store.state.workflow.agent.message, "后台结果已验证");
  runtime.close();
});

test("goal agent rejects an unverified finish and keeps planning", async () => {
  const store = fakeStore();
  let decisions = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      decisions += 1;
      return decisions === 1
        ? { type: "finish", plan: ["投递"], message: "我认为完成了" }
        : { type: "tool", tool: "work", arguments: {}, plan: ["继续投递"], message: "继续执行" };
    } },
    tools: [{ name: "work", description: "执行投递", input: {}, risk: "read", async execute() { return { progress: true, waitFor: "work", summary: "运行中" }; } }],
    observe: async () => ({}),
    waitStatus: async () => ({ done: false, summary: "运行中" }),
    verifyFinish: async () => ({ done: false, message: "目标还没完成" })
  });
  runtime.start({ goal: "完成岗位投递", sourceText: "完成岗位投递", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "waiting");
  assert.equal(decisions, 2);
  assert.equal(store.state.workflow.agent.steps[0].kind, "finish-rejected");
  assert.match(store.state.workflow.agent.message, /运行中/);
  runtime.close();
});
