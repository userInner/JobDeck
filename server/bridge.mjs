import crypto from "node:crypto";
import { WebSocketServer } from "ws";

const SAFE = new Set(["status", "listTabs", "inspect", "scroll", "mouseMove", "hover", "computerMove", "computerNotice", "activateTab", "openBossResume", "openBossJobs", "openBossChat", "openBossJob"]);
const CONTROLLED = new Set(["click", "mouseClick", "type", "computerClick", "computerType", "computerKeypress", "computerBack", "computerScroll", "navigate"]);

function normalizeAction(input = {}) {
  const kind = String(input.kind || "");
  if (!SAFE.has(kind) && !CONTROLLED.has(kind)) throw new Error(`不支持的浏览器动作：${kind || "空"}`);
  const output = { kind };
  for (const key of ["selector", "anchorSelector", "text", "value", "url", "direction", "reason"]) {
    if (input[key] !== undefined && input[key] !== null) {
      output[key] = String(input[key]).slice(0, key === "value" ? 6000 : 1200);
    }
  }
  if (input.tabId !== undefined) output.tabId = Number(input.tabId);
  if (input.x !== undefined) output.x = Math.max(0, Math.min(10000, Number(input.x)));
  if (input.y !== undefined) output.y = Math.max(0, Math.min(10000, Number(input.y)));
  if (input.amount !== undefined) output.amount = Math.max(100, Math.min(4000, Number(input.amount)));
  if (input.replace !== undefined) output.replace = Boolean(input.replace);
  if (input.key !== undefined) output.key = String(input.key).slice(0, 40);
  return output;
}

function actionLabel(action) {
  if (action.kind === "click") return `点击 ${action.text || action.selector || "页面元素"}`;
  if (action.kind === "mouseClick") return `鼠标点击 ${action.text || action.selector || `${action.x},${action.y}`}`;
  if (action.kind === "mouseMove") return `鼠标移动到 ${action.text || action.selector || `${action.x},${action.y}`}`;
  if (action.kind === "hover") return `鼠标悬停 ${action.text || action.selector || "页面区域"}`;
  if (action.kind === "computerMove") return `Computer Use 移动到 ${action.text || `${action.x},${action.y}`}`;
  if (action.kind === "computerClick") return `Computer Use 点击 ${action.text || `${action.x},${action.y}`}`;
  if (action.kind === "computerType") return `Computer Use 输入（${String(action.value || "").length} 字）`;
  if (action.kind === "computerKeypress") return `Computer Use 按键 ${action.key || ""}`.trim();
  if (action.kind === "computerBack") return "Computer Use 返回上一页";
  if (action.kind === "computerScroll") return `Computer Use ${action.direction === "up" ? "向上" : "向下"}滚动`;
  if (action.kind === "computerNotice") return `Computer Use 状态提示：${action.text || "操作已完成"}`;
  if (action.kind === "type") return `填写 ${action.selector || "当前输入框"}（${String(action.value || "").length} 字）`;
  if (action.kind === "navigate") return `打开 ${action.url}`;
  if (action.kind === "openBossResume") return "打开 BOSS 在线简历";
  if (action.kind === "openBossJobs") return "打开 BOSS 职位搜索";
  if (action.kind === "openBossChat") return "打开 BOSS 沟通消息";
  if (action.kind === "openBossJob") return `打开 BOSS 岗位 ${action.url || ""}`.trim();
  if (action.kind === "inspect") return "读取当前页面";
  if (action.kind === "scroll") return `${action.direction === "up" ? "向上" : "向下"}滚动`;
  return action.kind;
}

export class BrowserBridge {
  constructor(store) {
    this.store = store;
    this.wss = new WebSocketServer({ noServer: true });
    this.extension = null;
    this.pending = new Map();
    this.lastPage = null;
    this.paused = false;
  }

  attach(server) {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const origin = req.headers.origin || "";
      if (url.pathname !== "/extension" || url.searchParams.get("token") !== this.store.secrets.extensionToken || !origin.startsWith("chrome-extension://")) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
    });
  }

  connect(ws) {
    this.extension?.close(4000, "新的 Chrome 连接已建立");
    this.extension = ws;
    this.store.addActivity("Chrome 扩展已连接");
    ws.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return; }
      if (message.type === "result" && message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        message.ok ? pending.resolve(message.data) : pending.reject(new Error(message.error || "Chrome 操作失败"));
      }
      if (message.type === "page") this.lastPage = message.data;
    });
    ws.on("close", () => {
      if (this.extension === ws) this.extension = null;
      this.store.addActivity("Chrome 扩展已断开", "error");
    });
  }

  get connected() {
    return Boolean(this.extension && this.extension.readyState === 1);
  }

  publicState() {
    return { connected: this.connected, paused: this.paused, lastPage: this.lastPage };
  }

  async execute(input, timeoutMs = 20_000) {
    if (this.paused) throw new Error("浏览器操作已暂停");
    if (!this.connected) throw new Error("Chrome 扩展尚未连接");
    const action = normalizeAction(input);
    const id = crypto.randomUUID();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Chrome 响应超时"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
    });
    this.extension.send(JSON.stringify({ type: "command", id, action }));
    const value = await result;
    if (action.kind === "inspect") this.lastPage = value;
    return value;
  }

  stage(input) {
    const action = normalizeAction(input);
    if (!CONTROLLED.has(action.kind)) throw new Error("该动作不需要加入确认队列");
    return this.store.update((state) => {
      const item = {
        id: crypto.randomUUID(),
        label: actionLabel(action),
        status: "waiting",
        reason: action.reason || "由 Web 求职助手提出",
        action,
        createdAt: new Date().toISOString()
      };
      state.actions.unshift(item);
      state.actions = state.actions.slice(0, 200);
      return item;
    });
  }

  async approve(id) {
    const item = this.store.state.actions.find((entry) => entry.id === id && entry.status === "waiting");
    if (!item) throw new Error("待确认操作不存在或已经处理");
    item.status = "running";
    this.store.save();
    try {
      item.result = await this.execute(item.action);
      item.status = "done";
      item.completedAt = new Date().toISOString();
      this.store.save();
      this.store.addActivity(item.label);
      return item;
    } catch (error) {
      item.status = "error";
      item.error = error.message;
      this.store.save();
      throw error;
    }
  }

  reject(id) {
    const item = this.store.state.actions.find((entry) => entry.id === id && entry.status === "waiting");
    if (!item) throw new Error("待确认操作不存在或已经处理");
    item.status = "rejected";
    item.completedAt = new Date().toISOString();
    this.store.save();
    return item;
  }
}

export { CONTROLLED, SAFE, actionLabel, normalizeAction };
