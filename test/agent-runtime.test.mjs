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

test("goal agent stops immediately when an atomic tool reports needsAttention", async () => {
  const store = fakeStore();
  let decisions = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      decisions += 1;
      return { type: "tool", tool: "inspect", arguments: {}, plan: ["检查页面"], message: "检查当前页面" };
    } },
    tools: [{
      name: "inspect",
      description: "检查当前页面",
      input: {},
      risk: "read",
      async execute() {
        return {
          progress: false,
          needsAttention: true,
          summary: "出现验证码，需要本人处理"
        };
      }
    }],
    observe: async () => ({}),
    waitStatus: async () => null
  });

  runtime.start({ goal: "继续找工作", sourceText: "继续找工作", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "needs-attention");
  assert.equal(decisions, 1);
  assert.equal(store.state.workflow.agent.noProgressCount, 0);
  assert.match(store.state.workflow.agent.message, /验证码/);
  assert.equal(store.state.workflow.agent.steps.at(-1).tool, "inspect");
  runtime.close();
});

test("an unverified contact never advances the agent to the next job", async () => {
  const store = fakeStore();
  const executed = [];
  let decisions = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      decisions += 1;
      return decisions === 1
        ? { type: "tool", tool: "contact", arguments: {}, plan: ["发送并验证"], message: "联系当前岗位" }
        : { type: "tool", tool: "inspect-next", arguments: {}, plan: ["下一个 JD"], message: "检查下一个岗位" };
    } },
    tools: [
      {
        name: "contact",
        description: "发送当前岗位的定制招呼并验证",
        input: {},
        risk: "jobs:apply",
        async execute() {
          executed.push("contact");
          return { progress: false, needsAttention: true, summary: "发送结果未验证，保留当前岗位" };
        }
      },
      {
        name: "inspect-next",
        description: "检查下一个岗位",
        input: {},
        risk: "read",
        async execute() { executed.push("inspect-next"); return { progress: true }; }
      }
    ],
    observe: async () => ({ currentJobId: "job-current", sent: 0 }),
    waitStatus: async () => null
  });

  runtime.start({ goal: "完成一个已验证岗位沟通", sourceText: "完成一个已验证岗位沟通", scopes: ["jobs:apply"] });
  await waitUntil(() => store.state.workflow.agent.status === "needs-attention");
  assert.deepEqual(executed, ["contact"]);
  assert.equal(decisions, 1);
  assert.match(store.state.workflow.agent.message, /发送结果未验证/);
  runtime.close();
});

test("goal agent automatically continues after each six-decision slice", async () => {
  const store = fakeStore();
  let executions = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      if (executions >= 8) return { type: "finish", plan: [], message: "八个原子动作均已验证" };
      return { type: "tool", tool: "step", arguments: {}, plan: ["继续推进目标"], message: `执行第 ${executions + 1} 步` };
    } },
    tools: [{
      name: "step",
      description: "执行一个原子动作",
      input: {},
      risk: "read",
      async execute() {
        executions += 1;
        return { progress: true, summary: `已完成 ${executions}/8` };
      }
    }],
    observe: async () => ({ executions }),
    waitStatus: async () => null,
    verifyFinish: async () => ({ done: executions >= 8, message: `仅完成 ${executions}/8` })
  });

  runtime.start({ goal: "完成八个动作", sourceText: "完成八个动作", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "complete");
  assert.equal(executions, 8);
  assert.equal(store.state.workflow.agent.steps.filter((step) => step.tool === "step").length, 8);
  assert.equal(store.state.workflow.agent.steps.at(-1).kind, "finish");
  runtime.close();
});

test("goal agent cannot finish a numeric application goal before verified sends reach the target", async () => {
  const store = fakeStore();
  let sent = 0;
  const contactCalls = [];
  const verifiedReceipts = new Set();
  const finishChecks = [];
  const decisions = [
    { type: "tool", tool: "contact", arguments: { jobId: "job-1", receipt: "verified:job-1" }, plan: ["联系第一个岗位"], message: "联系第一个岗位" },
    { type: "finish", plan: [], message: "完成第一个后过早宣布完成" },
    { type: "tool", tool: "contact", arguments: { jobId: "job-2", receipt: "verified:job-2" }, plan: ["联系第二个岗位"], message: "联系第二个岗位" },
    { type: "finish", plan: [], message: "完成第二个后仍然过早" },
    { type: "tool", tool: "contact", arguments: { jobId: "job-3", receipt: "verified:job-3" }, plan: ["联系第三个岗位"], message: "联系第三个岗位" },
    { type: "finish", plan: [], message: "已完成三个已验证沟通" }
  ];
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() { return decisions.shift(); } },
    tools: [{
      name: "contact",
      description: "联系匹配岗位",
      input: {},
      risk: "jobs:apply",
      async execute({ jobId, receipt }) {
        contactCalls.push(jobId);
        if (!verifiedReceipts.has(receipt)) {
          verifiedReceipts.add(receipt);
          sent += 1;
        }
        return { progress: true, summary: `已验证沟通 ${sent}/3` };
      }
    }],
    observe: async () => ({ jobSearch: { sent, target: 3 } }),
    waitStatus: async () => null,
    verifyFinish: async () => {
      finishChecks.push(sent);
      return { done: sent >= 3, message: `目标尚未完成：${sent}/3` };
    }
  });

  runtime.start({ goal: "完成3个已验证岗位沟通", sourceText: "完成3个已验证岗位沟通", scopes: ["jobs:apply"] });
  await waitUntil(() => store.state.workflow.agent.status === "complete");
  assert.deepEqual(contactCalls, ["job-1", "job-2", "job-3"]);
  assert.deepEqual([...verifiedReceipts], ["verified:job-1", "verified:job-2", "verified:job-3"]);
  assert.equal(store.state.workflow.agent.steps.filter((step) => step.tool === "contact").length, 3);
  assert.deepEqual(finishChecks, [1, 2, 3], "the first two finish attempts are checked and rejected before the third verified receipt");
  assert.equal(sent, 3);
  assert.equal(store.state.workflow.agent.steps.filter((step) => step.kind === "finish-rejected").length, 2);
  assert.equal(store.state.workflow.agent.message, "已完成三个已验证沟通");
  runtime.close();
});

test("a machine-readable requiredNextAction bypasses a wrong model choice on the next turn", async () => {
  const store = fakeStore();
  const executed = [];
  let plannerCalls = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      plannerCalls += 1;
      if (plannerCalls === 1) {
        return { type: "tool", tool: "inspect", arguments: {}, plan: ["检查岗位"], message: "检查当前岗位" };
      }
      if (plannerCalls === 2) return { type: "finish", plan: [], message: "必要动作已完成" };
      return { type: "tool", tool: "wrong", arguments: {}, plan: [], message: "错误地跳到其他岗位" };
    } },
    tools: [
      {
        name: "inspect",
        description: "检查当前岗位",
        input: {},
        risk: "read",
        async execute() {
          executed.push("inspect");
          return {
            progress: false,
            summary: "当前岗位必须先联系",
            requiredNextAction: {
              tool: "contact",
              arguments: { jobId: "job-1" },
              reason: "保留当前岗位并完成沟通"
            }
          };
        }
      },
      {
        name: "contact",
        description: "联系当前岗位",
        input: {},
        risk: "jobs:apply",
        async execute(args) {
          executed.push(`contact:${args.jobId}`);
          return { progress: true, summary: "当前岗位已验证沟通" };
        }
      },
      {
        name: "wrong",
        description: "错误动作",
        input: {},
        risk: "read",
        async execute() { executed.push("wrong"); return { progress: true }; }
      }
    ],
    observe: async () => ({ executed: [...executed] }),
    waitStatus: async () => null,
    verifyFinish: async () => ({ done: executed.includes("contact:job-1") })
  });

  runtime.start({ goal: "完成当前岗位沟通", sourceText: "完成当前岗位沟通", scopes: ["jobs:apply"] });
  await waitUntil(() => store.state.workflow.agent.status === "complete");
  assert.deepEqual(executed, ["inspect", "contact:job-1"]);
  assert.equal(plannerCalls, 2);
  assert.equal(store.state.workflow.agent.noProgressCount, 0);
  runtime.close();
});

test("requiredNextAction never bypasses registry and scope authorization", async () => {
  const store = fakeStore();
  const executed = [];
  let plannerCalls = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      plannerCalls += 1;
      if (plannerCalls === 1) return { type: "tool", tool: "inspect", arguments: {}, plan: [], message: "检查" };
      return { type: "tool", tool: "safe", arguments: {}, plan: [], message: "回退到安全动作" };
    } },
    tools: [
      {
        name: "inspect",
        description: "检查",
        input: {},
        risk: "read",
        async execute() {
          executed.push("inspect");
          return { progress: false, requiredNextAction: { tool: "missing-tool" } };
        }
      },
      {
        name: "safe",
        description: "安全动作",
        input: {},
        risk: "read",
        async execute() {
          executed.push("safe");
          return { progress: false, requiredNextAction: { tool: "apply" } };
        }
      },
      {
        name: "apply",
        description: "发送岗位沟通",
        input: {},
        risk: "jobs:apply",
        async execute() { executed.push("apply"); return { progress: true }; }
      }
    ],
    observe: async () => ({}),
    waitStatus: async () => null
  });

  runtime.start({ goal: "安全推进", sourceText: "安全推进", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "needs-confirmation");
  assert.deepEqual(executed, ["inspect", "safe"]);
  assert.equal(plannerCalls, 2);
  assert.equal(store.state.workflow.agent.noProgressCount, 2, "required follow-up actions do not hide observable no-progress results");
  assert.match(store.state.workflow.agent.message, /额外授权/);
  runtime.close();
});

test("a repeated requiredNextAction on an unchanged page backs off and pauses instead of hot-looping", async () => {
  const store = fakeStore();
  const delays = [];
  let executions = 0;
  let plannerCalls = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      plannerCalls += 1;
      return { type: "tool", tool: "contact", arguments: { jobId: "job-stuck" }, plan: ["完成当前岗位"], message: "联系当前岗位" };
    } },
    tools: [{
      name: "contact",
      description: "联系当前岗位",
      input: {},
      risk: "jobs:apply",
      async execute() {
        executions += 1;
        return {
          progress: false,
          summary: "立即沟通没有产生页面变化，保留当前岗位重试",
          requiredNextAction: { tool: "contact", arguments: { jobId: "job-stuck" } }
        };
      }
    }],
    observe: async () => ({
      now: new Date().toISOString(),
      page: { url: "https://www.zhipin.com/job_detail/job-stuck", title: "同一岗位" },
      sent: 0,
      goal: {
        attemptCounts: { contact: executions },
        actionLedger: [{ at: new Date().toISOString(), action: "contact" }]
      }
    }),
    waitStatus: async () => null,
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    retryBackoffBaseMs: 10,
    retryBackoffMaxMs: 25,
    repeatedStallLimit: 5,
    noProgressLimit: 20
  });

  runtime.start({ goal: "完成当前岗位沟通", sourceText: "完成当前岗位沟通", scopes: ["jobs:apply"] });
  await waitUntil(() => store.state.workflow.agent.status === "needs-attention");
  assert.equal(plannerCalls, 1, "machine-readable continuation owns retries after the first plan");
  assert.equal(executions, 5, "the repeated unchanged action is bounded by the stall threshold");
  assert.deepEqual(delays, [10, 20, 25], "retries use bounded exponential backoff");
  assert.equal(store.state.workflow.agent.noProgressCount, 5);
  assert.equal(store.state.workflow.agent.repeatedStallCount, 5);
  assert.match(store.state.workflow.agent.message, /同一必要动作.*暂停/);
  runtime.close();
});

test("page changes reset repeated-stall detection without erasing the independent no-progress count", async () => {
  const store = fakeStore();
  const delays = [];
  let executions = 0;
  const runtime = new GoalAgentRuntime({
    store,
    ai: { async planAgentStep() {
      if (executions >= 6) return { type: "finish", plan: [], message: "页面导航完成" };
      return { type: "tool", tool: "navigate", arguments: {}, plan: ["继续导航"], message: "继续导航" };
    } },
    tools: [{
      name: "navigate",
      description: "导航到下一页面",
      input: {},
      risk: "read",
      async execute() {
        executions += 1;
        return { progress: false, summary: `已进入候选页面 ${executions}` };
      }
    }],
    observe: async () => ({ page: { url: `https://www.zhipin.com/jobs?page=${executions}` }, sent: 0 }),
    waitStatus: async () => null,
    verifyFinish: async () => ({ done: executions >= 6 }),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    repeatedStallLimit: 3,
    noProgressLimit: 10
  });

  runtime.start({ goal: "浏览六个不同页面", sourceText: "浏览六个不同页面", scopes: [] });
  await waitUntil(() => store.state.workflow.agent.status === "complete");
  assert.equal(executions, 6, "normal atomic navigation continues beyond a decision slice");
  assert.deepEqual(delays, [], "different observable pages are not treated as a repeated stall");
  assert.equal(store.state.workflow.agent.noProgressCount, 6, "no-progress accounting is independent from repeated-stall detection");
  assert.equal(store.state.workflow.agent.repeatedStallCount, 1);
  runtime.close();
});
