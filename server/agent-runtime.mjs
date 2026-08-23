import crypto from "node:crypto";

function activeStatus(status) {
  return ["planning", "executing", "waiting"].includes(String(status || ""));
}

function compactToolData(value) {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 8000) return JSON.parse(serialized);
    return { preview: serialized.slice(0, 8000), truncated: true };
  } catch {
    return { preview: String(value).slice(0, 8000) };
  }
}

export class GoalAgentRuntime {
  constructor({ store, ai, tools, observe, waitStatus }) {
    this.store = store;
    this.ai = ai;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.observe = observe;
    this.waitStatus = waitStatus;
    this.running = new Set();
    this.timer = setInterval(() => this.tickWaiting(), 3000);
    this.timer.unref?.();
  }

  catalog() {
    return [...this.tools.values()].map(({ name, description, input, risk }) => ({ name, description, input, risk }));
  }

  current() {
    return this.store.state.workflow.agent || {};
  }

  close() {
    clearInterval(this.timer);
  }

  update(patch) {
    return this.store.update((state) => {
      state.workflow.agent = {
        ...state.workflow.agent,
        ...patch,
        updatedAt: new Date().toISOString()
      };
      state.workflow.updatedAt = new Date().toISOString();
      return state.workflow.agent;
    });
  }

  start({ goal, sourceText, scopes = [] }) {
    const current = this.current();
    if (activeStatus(current.status)) throw new Error(`已有求职 Agent 正在执行：${current.goal || "当前任务"}`);
    const runId = crypto.randomUUID();
    this.update({
      runId,
      status: "planning",
      goal: String(goal || sourceText || "").slice(0, 1200),
      sourceText: String(sourceText || "").slice(0, 1200),
      scopes: [...new Set(scopes)],
      plan: [],
      message: "正在观察当前状态并规划第一步…",
      currentTool: null,
      waitFor: null,
      steps: [],
      noProgressCount: 0,
      stopRequested: false,
      startedAt: new Date().toISOString(),
      completedAt: null
    });
    this.store.addActivity(`求职 Agent 已接收目标：${String(goal || sourceText).slice(0, 100)}`);
    queueMicrotask(() => this.run(runId));
    return this.current();
  }

  stop() {
    const current = this.current();
    if (["idle", "complete", "stopped"].includes(current.status)) return current;
    this.update({ status: "stopped", stopRequested: true, currentTool: null, waitFor: null, message: "已按用户要求停止 Agent 任务", completedAt: new Date().toISOString() });
    this.store.addActivity("用户停止了求职 Agent");
    return this.current();
  }

  appendStep(step) {
    this.store.update((state) => {
      const agent = state.workflow.agent;
      agent.steps = [...(agent.steps || []), { id: crypto.randomUUID(), at: new Date().toISOString(), ...step }].slice(-80);
      agent.updatedAt = new Date().toISOString();
      state.workflow.updatedAt = agent.updatedAt;
    });
  }

  scopeAllowed(tool, task) {
    return tool.risk === "read" || task.scopes?.includes(tool.risk);
  }

  async run(runId) {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    try {
      // Yield after a small group of decisions, but never terminate merely
      // because a task needed many steps. Termination is progress-driven.
      for (let turn = 0; turn < 6; turn += 1) {
        const task = this.current();
        if (task.runId !== runId || task.stopRequested || !activeStatus(task.status)) return;
        this.update({ status: "planning", currentTool: null, message: "正在观察结果并规划下一步…" });
        const observation = await this.observe(this.current());
        const decision = await this.ai.planAgentStep({ task: this.current(), observation, tools: this.catalog() });
        if (Array.isArray(decision.plan) && decision.plan.length) this.update({ plan: decision.plan });

        if (decision.type === "finish") {
          this.appendStep({ kind: "finish", label: decision.message || "目标已完成", status: "done" });
          this.update({ status: "complete", message: decision.message || "目标已完成", completedAt: new Date().toISOString(), currentTool: null, waitFor: null });
          this.store.addActivity(`求职 Agent 完成：${decision.message || this.current().goal}`);
          return;
        }
        if (decision.type === "ask_user") {
          this.appendStep({ kind: "ask-user", label: decision.message || "需要本人确认", status: "waiting" });
          this.update({ status: "needs-confirmation", message: decision.message || "下一步需要本人确认", currentTool: null, waitFor: null });
          return;
        }

        const tool = this.tools.get(decision.tool);
        if (!tool) {
          this.appendStep({ kind: "planner-error", label: `模型选择了不存在的工具：${decision.tool || "空"}`, status: "error" });
          this.update({ noProgressCount: (this.current().noProgressCount || 0) + 1, message: "工具不存在，正在重新规划…" });
          continue;
        }
        if (!this.scopeAllowed(tool, this.current())) {
          const message = `下一步需要额外授权：${tool.description}`;
          this.appendStep({ kind: "permission", tool: tool.name, label: message, status: "waiting" });
          this.update({ status: "needs-confirmation", message, currentTool: tool.name, waitFor: null });
          return;
        }

        this.update({ status: "executing", currentTool: tool.name, message: decision.message || `正在执行：${tool.description}` });
        let result;
        try {
          result = await tool.execute(decision.arguments || {}, this.current());
        } catch (error) {
          this.appendStep({ kind: "tool", tool: tool.name, label: tool.description, status: "error", result: error.message });
          const noProgressCount = (this.current().noProgressCount || 0) + 1;
          if (noProgressCount >= 5) {
            this.update({ status: "needs-attention", noProgressCount, currentTool: null, message: `连续多次没有进展：${error.message}` });
            return;
          }
          this.update({ status: "planning", noProgressCount, currentTool: null, message: `${error.message}；正在尝试其他方案…` });
          continue;
        }

        this.appendStep({
          kind: "tool",
          tool: tool.name,
          label: tool.description,
          status: "done",
          result: String(result?.summary || "执行完成").slice(0, 1000),
          resultData: compactToolData(result?.data)
        });
        const noProgressCount = result?.progress === false ? (this.current().noProgressCount || 0) + 1 : 0;
        if (result?.waitFor) {
          this.update({ status: "waiting", waitFor: result.waitFor, noProgressCount, currentTool: tool.name, message: result.summary || "后台任务运行中…" });
          return;
        }
        if (noProgressCount >= 5) {
          this.update({ status: "needs-attention", noProgressCount, currentTool: null, message: "连续五个动作都没有带来可验证进展，需要调整目标或人工处理" });
          return;
        }
        this.update({ status: "planning", noProgressCount, currentTool: null, message: result?.summary || "已执行，正在验证并规划下一步…" });
      }
      if (this.current().runId === runId && activeStatus(this.current().status)) {
        queueMicrotask(() => this.run(runId));
      }
    } catch (error) {
      if (this.current().runId === runId) {
        this.appendStep({ kind: "runtime-error", label: error.message, status: "error" });
        this.update({ status: "needs-attention", currentTool: null, waitFor: null, message: error.message });
      }
    } finally {
      this.running.delete(runId);
    }
  }

  async tickWaiting() {
    const task = this.current();
    if (task.status !== "waiting" || !task.waitFor || task.stopRequested) return;
    try {
      const status = await this.waitStatus(task.waitFor, task);
      if (!status) return;
      this.update({ message: status.summary || task.message });
      if (status.done) {
        this.appendStep({ kind: "background", tool: task.currentTool, label: status.summary || "后台任务结束", status: status.success === false ? "error" : "done" });
        this.update({ status: "planning", waitFor: null, currentTool: null, noProgressCount: status.progress === false ? (task.noProgressCount || 0) + 1 : 0 });
        queueMicrotask(() => this.run(task.runId));
      }
    } catch (error) {
      this.update({ status: "needs-attention", waitFor: null, currentTool: null, message: error.message });
    }
  }
}

export { activeStatus };
