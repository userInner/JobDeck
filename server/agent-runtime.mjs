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

function normalizeRequiredNextAction(value) {
  if (typeof value === "string" && value.trim()) {
    return { tool: value.trim(), arguments: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tool = String(value.tool || value.name || "").trim();
  if (!tool) return null;
  const args = value.arguments ?? value.args;
  return {
    tool,
    arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {},
    message: String(value.message || value.reason || "").trim(),
    plan: Array.isArray(value.plan) ? value.plan.map((item) => String(item)).filter(Boolean) : []
  };
}

const VOLATILE_OBSERVATION_KEYS = new Set([
  "now",
  "at",
  "updatedAt",
  "createdAt",
  "startedAt",
  "completedAt",
  "capturedAt",
  "lastSeenAt",
  "lastConnectedAt",
  "heartbeatAt",
  // Retry bookkeeping must not make an otherwise unchanged browser/page
  // observation look like progress on every pass.
  "actionLedger",
  "attemptCounts",
  "exhaustionAttempts",
  "planCooldowns",
  "lastAction",
  "nextRetryAt"
]);

function stableRuntimeValue(value, key = "") {
  if (VOLATILE_OBSERVATION_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => stableRuntimeValue(item)).filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [childKey, stableRuntimeValue(value[childKey], childKey)])
        .filter(([, childValue]) => childValue !== undefined)
    );
  }
  return value;
}

function runtimeFingerprint(value) {
  let serialized;
  try {
    serialized = JSON.stringify(stableRuntimeValue(value));
  } catch {
    serialized = String(value);
  }
  return crypto.createHash("sha256").update(serialized || "null").digest("hex").slice(0, 24);
}

function actionFingerprint(tool, args) {
  return `${String(tool || "unknown")}:${runtimeFingerprint(args || {})}`;
}

export class GoalAgentRuntime {
  constructor({
    store,
    ai,
    tools,
    observe,
    waitStatus,
    verifyFinish = null,
    runInContext = (callback) => callback(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    retryBackoffBaseMs = 300,
    retryBackoffMaxMs = 4000,
    repeatedStallLimit = 5,
    noProgressLimit = 12
  }) {
    this.store = store;
    this.ai = ai;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.observe = observe;
    this.waitStatus = waitStatus;
    this.verifyFinish = verifyFinish;
    this.runInContext = runInContext;
    this.sleep = sleep;
    this.retryBackoffBaseMs = Math.max(0, Number(retryBackoffBaseMs) || 0);
    this.retryBackoffMaxMs = Math.max(this.retryBackoffBaseMs, Number(retryBackoffMaxMs) || 0);
    this.repeatedStallLimit = Math.max(2, Number(repeatedStallLimit) || 5);
    this.noProgressLimit = Math.max(this.repeatedStallLimit, Number(noProgressLimit) || 12);
    this.running = new Set();
    this.timer = setInterval(() => this.runInContext(() => this.tickWaiting()), 3000);
    this.timer.unref?.();
  }

  catalog() {
    return [...this.tools.values()].map(({ name, description, input, risk }) => ({ name, description, input, risk }));
  }

  current() {
    return this.store.state.workflow.agent || {};
  }

  isActiveRun(runId) {
    const task = this.current();
    return task.runId === runId && !task.stopRequested && activeStatus(task.status);
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
      repeatedStallCount: 0,
      lastNoProgressActionKey: null,
      lastNoProgressObservationKey: null,
      nextRetryAt: null,
      requiredNextAction: null,
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

  progressState({ progress, actionKey, observation }) {
    if (progress !== false) {
      return {
        noProgressCount: 0,
        repeatedStallCount: 0,
        lastNoProgressActionKey: null,
        lastNoProgressObservationKey: null,
        nextRetryAt: null,
        backoffMs: 0,
        repeatedStall: false,
        hardStall: false
      };
    }

    const task = this.current();
    const observationKey = runtimeFingerprint(observation);
    const repeatedStall = task.lastNoProgressActionKey === actionKey
      && task.lastNoProgressObservationKey === observationKey;
    const repeatedStallCount = repeatedStall ? (Number(task.repeatedStallCount) || 1) + 1 : 1;
    const noProgressCount = (Number(task.noProgressCount) || 0) + 1;
    const exponent = Math.max(0, repeatedStallCount - 2);
    const backoffMs = repeatedStall
      ? Math.min(this.retryBackoffMaxMs, this.retryBackoffBaseMs * (2 ** exponent))
      : 0;
    return {
      noProgressCount,
      repeatedStallCount,
      lastNoProgressActionKey: actionKey,
      lastNoProgressObservationKey: observationKey,
      nextRetryAt: null,
      backoffMs,
      repeatedStall,
      hardStall: repeatedStallCount >= this.repeatedStallLimit || noProgressCount >= this.noProgressLimit
    };
  }

  progressPatch(progressState) {
    const {
      noProgressCount,
      repeatedStallCount,
      lastNoProgressActionKey,
      lastNoProgressObservationKey,
      nextRetryAt
    } = progressState;
    return {
      noProgressCount,
      repeatedStallCount,
      lastNoProgressActionKey,
      lastNoProgressObservationKey,
      nextRetryAt
    };
  }

  async backoffBeforeRetry(runId, progressState, message) {
    if (!progressState.backoffMs) return true;
    const nextRetryAt = new Date(Date.now() + progressState.backoffMs).toISOString();
    this.update({
      status: "waiting",
      currentTool: null,
      waitFor: null,
      nextRetryAt,
      message: `${message}；页面状态未变化，${progressState.backoffMs}ms 后重试`
    });
    await this.sleep(progressState.backoffMs);
    const task = this.current();
    if (task.runId !== runId || task.stopRequested || !activeStatus(task.status)) return false;
    this.update({ status: "planning", nextRetryAt: null, message });
    return true;
  }

  pauseForStall(progressState, message = "重复动作没有带来页面或目标进展，已暂停自动重试") {
    this.update({
      status: "needs-attention",
      ...this.progressPatch(progressState),
      currentTool: null,
      waitFor: null,
      nextRetryAt: null,
      message
    });
  }

  async run(runId) {
    if (this.running.has(runId)) return;
    this.running.add(runId);
    let continueRun = false;
    try {
      // Yield after a small group of decisions, but never terminate merely
      // because a task needed many steps. Termination is progress-driven.
      for (let turn = 0; turn < 6; turn += 1) {
        const task = this.current();
        if (task.runId !== runId || task.stopRequested || !activeStatus(task.status)) return;
        this.update({ status: "planning", currentTool: null, message: "正在观察结果并规划下一步…" });
        const observation = await this.observe(this.current());
        if (!this.isActiveRun(runId)) return;
        const requiredNextAction = normalizeRequiredNextAction(this.current().requiredNextAction);
        let decision;
        if (requiredNextAction && this.tools.has(requiredNextAction.tool)) {
          decision = {
            type: "tool",
            tool: requiredNextAction.tool,
            arguments: requiredNextAction.arguments,
            plan: requiredNextAction.plan,
            message: requiredNextAction.message || `继续执行必要动作：${requiredNextAction.tool}`,
            protectiveRedirect: true
          };
        } else {
          if (this.current().requiredNextAction) this.update({ requiredNextAction: null });
          decision = await this.ai.planAgentStep({ task: this.current(), observation, tools: this.catalog() });
          if (!this.isActiveRun(runId)) return;
        }
        if (Array.isArray(decision.plan) && decision.plan.length) this.update({ plan: decision.plan });

        if (decision.type === "finish") {
          const verification = this.verifyFinish
            ? await this.verifyFinish({ task: this.current(), observation, decision })
            : { done: true };
          if (!this.isActiveRun(runId)) return;
          if (verification?.done === false) {
            const message = verification.message || "目标尚未取得足够的可验证进展，正在继续规划…";
            const progressState = this.progressState({ progress: false, actionKey: "finish", observation });
            this.appendStep({ kind: "finish-rejected", label: message, status: "error" });
            if (progressState.hardStall) {
              this.pauseForStall(progressState, message);
              return;
            }
            this.update({ status: "planning", ...this.progressPatch(progressState), currentTool: null, waitFor: null, message });
            if (!await this.backoffBeforeRetry(runId, progressState, message)) return;
            continue;
          }
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
          const actionKey = actionFingerprint(decision.tool, decision.arguments);
          const progressState = this.progressState({ progress: false, actionKey, observation });
          this.appendStep({ kind: "planner-error", label: `模型选择了不存在的工具：${decision.tool || "空"}`, status: "error" });
          if (progressState.hardStall) {
            this.pauseForStall(progressState, "模型重复选择无效工具且页面状态没有变化，已暂停自动重试");
            return;
          }
          this.update({ ...this.progressPatch(progressState), message: "工具不存在，正在重新规划…" });
          if (!await this.backoffBeforeRetry(runId, progressState, "工具不存在，正在重新规划…")) return;
          continue;
        }
        if (!this.scopeAllowed(tool, this.current())) {
          const message = `下一步需要额外授权：${tool.description}`;
          this.appendStep({ kind: "permission", tool: tool.name, label: message, status: "waiting" });
          this.update({ status: "needs-confirmation", message, currentTool: tool.name, waitFor: null });
          return;
        }

        this.update({
          status: "executing",
          currentTool: tool.name,
          requiredNextAction: decision.protectiveRedirect ? null : this.current().requiredNextAction,
          message: decision.message || `正在执行：${tool.description}`
        });
        let result;
        try {
          result = await tool.execute(decision.arguments || {}, this.current());
        } catch (error) {
          if (!this.isActiveRun(runId)) return;
          this.appendStep({ kind: "tool", tool: tool.name, label: tool.description, status: "error", result: error.message });
          const progressState = this.progressState({
            progress: false,
            actionKey: actionFingerprint(tool.name, decision.arguments),
            observation
          });
          if (progressState.hardStall) {
            this.pauseForStall(progressState, `连续多次没有进展：${error.message}`);
            return;
          }
          const message = `${error.message}；正在尝试其他方案…`;
          this.update({ status: "planning", ...this.progressPatch(progressState), currentTool: null, message });
          if (!await this.backoffBeforeRetry(runId, progressState, message)) return;
          continue;
        }

        if (!this.isActiveRun(runId)) return;

        this.appendStep({
          kind: "tool",
          tool: tool.name,
          label: tool.description,
          status: "done",
          result: String(result?.summary || "执行完成").slice(0, 1000),
          resultData: compactToolData(result?.data)
        });
        if (result?.needsAttention) {
          this.update({
            status: "needs-attention",
            currentTool: null,
            waitFor: null,
            message: result.summary || result.message || "当前页面需要本人处理后才能继续"
          });
          return;
        }
        const nextAction = normalizeRequiredNextAction(result?.requiredNextAction ?? result?.data?.requiredNextAction);
        const progressState = this.progressState({
          progress: result?.progress,
          actionKey: actionFingerprint(tool.name, decision.arguments),
          observation
        });
        if (nextAction) this.update({ requiredNextAction: nextAction });
        if (result?.waitFor) {
          this.update({ status: "waiting", waitFor: result.waitFor, ...this.progressPatch(progressState), currentTool: tool.name, message: result.summary || "后台任务运行中…" });
          return;
        }
        if (progressState.hardStall) {
          this.pauseForStall(
            progressState,
            progressState.repeatedStallCount >= this.repeatedStallLimit
              ? "同一必要动作在未变化的页面上重复失败，已暂停自动重试，请检查页面或稍后继续"
              : "连续多个动作都没有带来可验证进展，已暂停自动重试，请检查目标或页面"
          );
          return;
        }
        const message = result?.summary || "已执行，正在验证并规划下一步…";
        this.update({ status: "planning", ...this.progressPatch(progressState), currentTool: null, message });
        if (!await this.backoffBeforeRetry(runId, progressState, message)) return;
      }
      if (this.current().runId === runId && activeStatus(this.current().status)) {
        continueRun = true;
      }
    } catch (error) {
      if (this.isActiveRun(runId)) {
        this.appendStep({ kind: "runtime-error", label: error.message, status: "error" });
        this.update({ status: "needs-attention", currentTool: null, waitFor: null, message: error.message });
      }
    } finally {
      this.running.delete(runId);
      if (continueRun && this.current().runId === runId && activeStatus(this.current().status)) {
        queueMicrotask(() => this.run(runId));
      }
    }
  }

  async tickWaiting() {
    const task = this.current();
    if (task.status !== "waiting" || !task.waitFor || task.stopRequested) return;
    const runId = task.runId;
    try {
      const status = await this.waitStatus(task.waitFor, task);
      const current = this.current();
      if (current.runId !== runId || current.status !== "waiting" || current.stopRequested) return;
      if (!status) return;
      this.update({ message: status.summary || current.message });
      if (status.done) {
        this.appendStep({ kind: "background", tool: current.currentTool, label: status.summary || "后台任务结束", status: status.success === false ? "error" : "done" });
        this.update({ status: "planning", waitFor: null, currentTool: null, noProgressCount: status.progress === false ? (current.noProgressCount || 0) + 1 : 0 });
        queueMicrotask(() => this.run(runId));
      }
    } catch (error) {
      const current = this.current();
      if (current.runId !== runId || current.stopRequested || current.status !== "waiting") return;
      this.update({ status: "needs-attention", waitFor: null, currentTool: null, message: error.message });
    }
  }
}

export { activeStatus };
