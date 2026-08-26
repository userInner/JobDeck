importScripts("boss-adapter.js");

const REMOTE_API_URL = "https://job.aibro.vip";
const REMOTE_BRIDGE_URL = "wss://job.aibro.vip/extension";
const LEGACY_LOCAL_API_URL = "http://127.0.0.1:43120";
const LEGACY_LOCAL_BRIDGE_URL = "ws://127.0.0.1:43120/extension";
const CONNECTION_DEFAULTS_VERSION = 2;
const DEFAULTS = {
  apiUrl: REMOTE_API_URL,
  bridgeUrl: REMOTE_BRIDGE_URL,
  token: "",
  allowedOrigins: []
};

let socket;
let reconnectTimer;
let heartbeatTimer;
let currentState = { connected: false, lastError: "本地服务尚未连接" };
const ACTION_RECEIPTS_KEY = "jobdeckActionReceipts";
const ACTION_RECEIPT_LIMIT = 120;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function migrateLegacyConnectionDefaults() {
  const stored = await chrome.storage.local.get([
    "apiUrl", "bridgeUrl", "connectionDefaultsVersion"
  ]);
  if (Number(stored.connectionDefaultsVersion || 0) >= CONNECTION_DEFAULTS_VERSION) return;

  const untouchedLocalDefaults = (!stored.apiUrl || stored.apiUrl === LEGACY_LOCAL_API_URL)
    && (!stored.bridgeUrl || stored.bridgeUrl === LEGACY_LOCAL_BRIDGE_URL);
  await chrome.storage.local.set(untouchedLocalDefaults
    ? {
        apiUrl: REMOTE_API_URL,
        bridgeUrl: REMOTE_BRIDGE_URL,
        connectionDefaultsVersion: CONNECTION_DEFAULTS_VERSION
      }
    : { connectionDefaultsVersion: CONNECTION_DEFAULTS_VERSION });
}

async function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  const config = await settings();
  if (!config.token) {
    await updateState(false, "请先打开扩展侧边栏进行本机配对");
    return;
  }
  try {
    const previousSocket = socket;
    const nextSocket = new WebSocket(config.bridgeUrl, ["jobdeck", `token.${config.token}`]);
    socket = nextSocket;
    previousSocket?.close();
    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      updateState(true, "已连接 JobDeck 工作台");
      heartbeatTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping", at: Date.now() }));
      }, 20_000);
    };
    nextSocket.onmessage = async (event) => {
      if (socket !== nextSocket) return;
      let message;
      try { message = JSON.parse(event.data); }
      catch { return; }
      if (message.type !== "command") return;
      try {
        const data = await executeOnce(message.action);
        send({ type: "result", id: message.id, ok: true, data });
      } catch (error) {
        send({ type: "result", id: message.id, ok: false, error: error.message });
      }
    };
    nextSocket.onerror = () => {
      if (socket === nextSocket) updateState(false, "无法连接 JobDeck 工作台");
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      clearInterval(heartbeatTimer);
      updateState(false, "连接已断开，正在重试");
      reconnectTimer = setTimeout(connect, 3000);
    };
  } catch (error) {
    await updateState(false, error.message);
    reconnectTimer = setTimeout(connect, 5000);
  }
}

async function executeOnce(action) {
  const operationId = String(action?.operationId || "").trim();
  if (!operationId) return execute(action);
  const operationAttempt = Math.max(0, Math.trunc(Number(action?.operationAttempt) || 0));
  // A logical action keeps one id, while a page-confirmed retry receives a
  // new physical attempt. Replaying that exact attempt remains idempotent.
  const receiptKey = operationAttempt > 0
    ? `${operationId}:attempt:${operationAttempt}`
    : operationId;
  const stored = await chrome.storage.local.get({ [ACTION_RECEIPTS_KEY]: {} });
  const receipts = stored[ACTION_RECEIPTS_KEY] || {};
  const existing = receipts[receiptKey];
  if (existing?.status === "done") return existing.result;

  const result = await execute(action);
  receipts[receiptKey] = { status: "done", result, at: Date.now() };
  const compact = Object.fromEntries(
    Object.entries(receipts)
      .sort((left, right) => Number(right[1]?.at || 0) - Number(left[1]?.at || 0))
      .slice(0, ACTION_RECEIPT_LIMIT)
  );
  await chrome.storage.local.set({ [ACTION_RECEIPTS_KEY]: compact });
  return result;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function updateState(connected, lastError) {
  currentState = { connected, lastError, updatedAt: Date.now() };
  await chrome.storage.local.set({ bridgeState: currentState });
  await chrome.action.setBadgeText({ text: connected ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: connected ? "#177d6d" : "#b44a3a" });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("没有可用的 Chrome 标签页");
  return tab;
}

function originOf(url) {
  try { return new URL(url).origin; }
  catch { return ""; }
}

async function hasSiteAccess(origin) {
  if (!origin || origin === "null") return false;
  const { allowedOrigins } = await settings();
  const hasPermission = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  return allowedOrigins.includes(origin) && hasPermission;
}

async function ensureAllowed(tab) {
  const origin = originOf(tab.url || "");
  if (!(await hasSiteAccess(origin))) {
    throw new Error(`当前站点尚未授权：${origin || tab.url || "未知页面"}。请在扩展侧边栏允许此站点。`);
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function withComputerUse(tabId, callback) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    return await callback(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function animateComputerCursor(tabId, x, y) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: pageAction,
    args: [{ kind: "mouseMove", x, y }]
  });
}

async function computerUseAction(tab, action) {
  // Keep the controlled tab visible so the user can follow the real cursor
  // and so every screenshot reflects the page receiving debugger input.
  await chrome.tabs.update(tab.id, { active: true });
  const x = Number(action.x);
  const y = Number(action.y);
  if (action.kind === "computerMove" || action.kind === "computerClick") {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Computer Use 缺少有效点击坐标");
    await animateComputerCursor(tab.id, x, y);
  }
  if (action.kind === "computerMove") {
    return withComputerUse(tab.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" });
      return { moved: { x, y }, mode: "chrome-debugger" };
    });
  }
  if (action.kind === "computerClick") {
    return withComputerUse(tab.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse" });
      await delay(120);
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
      await delay(70);
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
      return { clicked: { x, y }, mode: "chrome-debugger" };
    });
  }
  if (action.kind === "computerType") {
    const [focus] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        const element = document.activeElement;
        if (!(element instanceof Element)) return { editable: false };
        const signature = `${element.tagName} ${element.getAttribute("type") || ""} ${element.getAttribute("name") || ""} ${element.id || ""} ${element.getAttribute("placeholder") || ""}`;
        const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.getAttribute("contenteditable") === "true";
        return { editable, sensitive: /password|密码|助记词|私钥|seed|secret/i.test(signature) };
      }
    });
    if (!focus?.result?.editable) throw new Error("Computer Use 当前没有聚焦可输入控件");
    if (focus.result.sensitive) throw new Error("扩展禁止自动填写密码、助记词或私钥");
    return withComputerUse(tab.id, async (target) => {
      if (action.replace) {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] });
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 4 });
      }
      await chrome.debugger.sendCommand(target, "Input.insertText", { text: String(action.value || "") });
      return { typed: String(action.value || "").length, replaced: Boolean(action.replace), mode: "chrome-debugger" };
    });
  }
  if (action.kind === "computerKeypress") {
    const key = String(action.key || "");
    if (!new Set(["Escape", "Enter", "ArrowUp", "ArrowDown"]).has(key)) throw new Error(`Computer Use 不允许按键：${key || "空"}`);
    return withComputerUse(tab.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key });
      return { key, mode: "chrome-debugger" };
    });
  }
  if (action.kind === "computerBack") {
    return withComputerUse(tab.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", modifiers: 1 });
      await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", modifiers: 1 });
      return { key: "Alt+ArrowLeft", mode: "chrome-debugger" };
    });
  }
  if (action.kind === "computerScroll") {
    const amount = Math.max(100, Math.min(1200, Number(action.amount) || 600));
    const deltaY = action.direction === "up" ? -amount : amount;
    const scrollX = Number.isFinite(x) ? x : 600;
    const scrollY = Number.isFinite(y) ? y : 500;
    await animateComputerCursor(tab.id, scrollX, scrollY);
    return withComputerUse(tab.id, async (target) => {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: scrollX, y: scrollY, button: "none", buttons: 0, pointerType: "mouse" });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseWheel", x: scrollX, y: scrollY, deltaX: 0, deltaY, pointerType: "mouse" });
      return { scrolled: deltaY, mode: "chrome-debugger" };
    });
  }
  throw new Error(`不支持的 Computer Use 动作：${action.kind}`);
}

async function inspectBossTab(tabId, lite) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["boss-adapter.js", "boss-content.js"]
  });
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, { type: "jobdeck-inspect-boss", lite });
  } catch (error) {
    throw new Error(`BOSS 页面读取通道不可用：${error?.message || String(error)}`);
  }
  if (!response?.ok) throw new Error(`BOSS 页面读取失败：${response?.error || "没有返回内容"}`);
  if (!response.data) throw new Error("BOSS 页面读取失败：返回内容为空");
  return response.data;
}

async function execute(action) {
  if (action.kind === "status") return currentState;
  if (action.kind === "listTabs") {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map((tab) => ({ id: tab.id, active: tab.active, title: tab.title, url: tab.url }));
  }
  if (action.kind === "activateTab") {
    const tab = await chrome.tabs.update(action.tabId, { active: true });
    return { id: tab.id, title: tab.title, url: tab.url };
  }

  const bossPages = {
    openBossResume: "https://www.zhipin.com/web/geek/resume",
    openBossJobs: "https://www.zhipin.com/web/geek/jobs",
    openBossChat: "https://www.zhipin.com/web/geek/chat"
  };
  if (bossPages[action.kind]) {
    const created = await chrome.tabs.create({ url: bossPages[action.kind], active: true });
    return { id: created.id, title: created.title, url: bossPages[action.kind] };
  }
  if (action.kind === "openBossJob") {
    const target = new URL(action.url || "");
    if (target.protocol !== "https:" || !/(^|\.)zhipin\.com$/i.test(target.hostname) || !/job_detail|\/job\//i.test(target.pathname)) {
      throw new Error("只允许打开已识别的 BOSS 职位详情页");
    }
    const current = await activeTab().catch(() => null);
    const currentUrl = current?.url ? new URL(current.url) : null;
    const reusable = currentUrl && /(^|\.)zhipin\.com$/i.test(currentUrl.hostname) && /job_detail|\/job\//i.test(currentUrl.pathname);
    const tab = reusable
      ? await chrome.tabs.update(current.id, { url: target.href, active: true })
      : await chrome.tabs.create({ url: target.href, active: true });
    return { id: tab.id, title: tab.title, url: target.href, reused: Boolean(reusable) };
  }

  const tab = action.tabId ? await chrome.tabs.get(action.tabId) : await activeTab();
  if (!tab?.id) throw new Error("目标 Chrome 标签页已经关闭，请重新打开页面");
  if (action.kind === "navigate") {
    const target = new URL(action.url);
    if (target.protocol !== "https:") throw new Error("自动跳转只允许 HTTPS 页面");
    if (!(await hasSiteAccess(target.origin))) throw new Error(`目标站点尚未授权：${target.origin}`);
    const updated = await chrome.tabs.update(tab.id, { url: target.href });
    return { id: updated.id, url: target.href };
  }
  await ensureAllowed(tab);
  if (["computerMove", "computerClick", "computerType", "computerKeypress", "computerBack", "computerScroll"].includes(action.kind)) {
    return computerUseAction(tab, action);
  }

  const isBoss = /(^|\.)zhipin\.com$/i.test(new URL(tab.url).hostname);
  const bossPath = isBoss ? new URL(tab.url).pathname : "";
  const useBossLite = action.kind === "inspect" && isBoss && /\/web\/geek\/jobs|\/job_detail\//.test(bossPath);
  if (action.kind === "inspect" && isBoss) {
    const result = await inspectBossTab(tab.id, useBossLite);
    send({ type: "page", data: result });
    return result;
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: pageAction,
    args: [action]
  });
  if (!injection) throw new Error("页面没有返回执行结果");
  if (injection.error) {
    const detail = injection.error.message || String(injection.error);
    throw new Error(`页面读取脚本执行失败：${detail}`);
  }
  if (action.kind === "inspect" && !injection.result) {
    throw new Error("页面读取脚本没有返回内容。请在 chrome://extensions 重新加载 JobDeck 扩展后重试");
  }
  let result = injection.result;
  if (action.kind === "inspect" && typeof result === "string") {
    try { result = JSON.parse(result); }
    catch { throw new Error("页面读取结果无法解析，请重新加载 JobDeck 扩展后重试"); }
  }
  if (action.kind === "inspect") send({ type: "page", data: result });
  return result;
}

async function pageAction(action) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const labelOf = (element) => {
    if (element instanceof HTMLInputElement && ["button", "submit"].includes(element.type)) return element.value.trim();
    return (element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.textContent || "")
      .replace(/\s+/g, " ").trim();
  };
  const cssEscape = (value) => window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const selectorFor = (element) => {
    if (element.id) return `#${cssEscape(element.id)}`;
    for (const attr of ["data-testid", "data-e2e", "name", "aria-label"]) {
      const value = element.getAttribute(attr);
      if (value) return `${element.tagName.toLowerCase()}[${attr}="${value.replace(/"/g, "\\\"")}"]`;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const siblings = [...node.parentElement?.children || []].filter((item) => item.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const findTarget = () => {
    if (action.selector) {
      try {
        const found = document.querySelector(action.selector);
        if (found) return found;
      } catch { /* stale selector falls through to text/current focus */ }
    }
    if (action.text) {
      const wanted = action.text.replace(/\s+/g, " ").trim().toLowerCase();
      const candidates = [...document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit'], [tabindex]")].filter(visible);
      return candidates.find((element) => labelOf(element).toLowerCase() === wanted)
        || candidates.find((element) => labelOf(element).toLowerCase().includes(wanted));
    }
    if ((action.kind === "mouseClick" || action.kind === "mouseMove") && Number.isFinite(action.x) && Number.isFinite(action.y)) {
      return document.elementFromPoint(action.x, action.y);
    }
    return document.activeElement;
  };

  if (action.kind === "inspect") {
    const interactives = [...document.querySelectorAll("button, a[href], input, textarea, select, [role='button'], [contenteditable='true']")]
      .filter(visible)
      .slice(0, 160)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          label: labelOf(element).slice(0, 160),
          selector: selectorFor(element),
          type: element.getAttribute("type") || undefined,
          disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
          valuePreview: "value" in element ? String(element.value || "").slice(0, 600) : undefined,
          point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
          bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
        };
      })
      .filter((item) => item.label || item.tag === "input" || item.tag === "textarea");
    const links = [...document.querySelectorAll("a[href]")]
      .filter(visible)
      .slice(0, 220)
      .flatMap((element) => {
        let href;
        try {
          const url = new URL(element.href, location.href);
          if (!["http:", "https:"].includes(url.protocol)) return [];
          href = url.href;
        } catch { return []; }
        const container = element.closest("li, article, [class*='job'], [class*='card']") || element.parentElement;
        return [{ href, label: labelOf(element).slice(0, 200), context: (container?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 700) }];
      });
    return JSON.stringify({
      title: document.title,
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight, scrollY, pageHeight: document.documentElement.scrollHeight },
      text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 24_000),
      interactives,
      links
    });
  }

  if (action.kind === "scroll") {
    const delta = (action.direction === "up" ? -1 : 1) * (action.amount || 700);
    window.scrollBy({ top: delta, behavior: "smooth" });
    return { scrollY: window.scrollY, requestedDelta: delta };
  }

  const ensureCursor = () => {
    let cursor = document.getElementById("__jobdeck_visual_cursor__");
    if (cursor) return cursor;
    cursor = document.createElement("div");
    cursor.id = "__jobdeck_visual_cursor__";
    cursor.setAttribute("aria-hidden", "true");
    Object.assign(cursor.style, {
      position: "fixed", left: "0", top: "0", width: "22px", height: "28px",
      zIndex: "2147483647", pointerEvents: "none", transform: "translate(24px, 24px)",
      opacity: "1", transition: "opacity 160ms ease", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))"
    });
    cursor.innerHTML = `<svg viewBox="0 0 22 28" width="22" height="28" xmlns="http://www.w3.org/2000/svg"><path d="M2 1.8v21.4l5.4-5.3 3.6 8.2 4.1-1.8-3.6-8.1h7.4L2 1.8Z" fill="#24486d" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(cursor);
    return cursor;
  };
  const moveCursor = async (x, y) => {
    const cursor = ensureCursor();
    if (globalThis.__jobdeckCursorHideTimer) clearTimeout(globalThis.__jobdeckCursorHideTimer);
    cursor.style.opacity = "1";
    const startX = Number(cursor.dataset.x ?? 24);
    const startY = Number(cursor.dataset.y ?? 24);
    const endX = Math.max(1, Math.min(innerWidth - 2, Number(x) || 1));
    const endY = Math.max(1, Math.min(innerHeight - 2, Number(y) || 1));
    const started = performance.now();
    const duration = 360;
    await new Promise((resolve) => {
      const frame = () => {
        const now = performance.now();
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const currentX = startX + (endX - startX) * eased;
        const currentY = startY + (endY - startY) * eased;
        cursor.style.transform = `translate(${currentX}px, ${currentY}px)`;
        if (progress < 1) setTimeout(frame, 16);
        else resolve();
      };
      frame();
    });
    cursor.dataset.x = String(endX);
    cursor.dataset.y = String(endY);
    return { x: endX, y: endY };
  };
  const pulseCursor = async () => {
    const cursor = ensureCursor();
    cursor.animate([
      { filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" },
      { filter: "drop-shadow(0 0 0 rgba(0,0,0,0)) drop-shadow(0 0 9px #d29a25)", transform: `${cursor.style.transform} scale(.82)` },
      { filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))", transform: `${cursor.style.transform} scale(1)` }
    ], { duration: 260, easing: "ease-out" });
    await new Promise((resolve) => setTimeout(resolve, 180));
  };
  const pointFor = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const dispatchMouseGesture = async (element) => {
    let visualTarget = element;
    if (!visible(element) && action.anchorSelector) {
      try { visualTarget = document.querySelector(action.anchorSelector) || element; }
      catch { visualTarget = element; }
    }
    visualTarget.scrollIntoView({ block: "center", behavior: "smooth" });
    await new Promise((resolve) => setTimeout(resolve, 260));
    const point = pointFor(visualTarget);
    await moveCursor(point.x, point.y);
    const eventInit = { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, button: 0 };
    element.dispatchEvent(new PointerEvent("pointerover", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseover", eventInit));
    element.dispatchEvent(new PointerEvent("pointermove", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousemove", eventInit));
    element.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    element.dispatchEvent(new MouseEvent("mousedown", { ...eventInit, buttons: 1 }));
    await pulseCursor();
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.click();
    return point;
  };

  if (action.kind === "mouseMove" && Number.isFinite(action.x) && Number.isFinite(action.y)) {
    return { moved: await moveCursor(action.x, action.y) };
  }

  if (action.kind === "computerNotice") {
    document.getElementById("__jobdeck_computer_notice__")?.remove();
    const notice = document.createElement("div");
    notice.id = "__jobdeck_computer_notice__";
    notice.setAttribute("aria-live", "polite");
    notice.textContent = String(action.text || "JobDeck 操作已完成").slice(0, 160);
    Object.assign(notice.style, {
      position: "fixed", left: "50%", top: "24px", transform: "translateX(-50%) translateY(-8px)",
      zIndex: "2147483647", maxWidth: "min(620px, calc(100vw - 48px))", padding: "13px 18px",
      borderRadius: "10px", background: "#173149", color: "#fff", boxShadow: "0 12px 30px rgba(0,0,0,.22)",
      font: "600 15px/1.5 system-ui, -apple-system, sans-serif", opacity: "0", transition: "opacity 180ms ease, transform 180ms ease",
      pointerEvents: "none"
    });
    document.documentElement.appendChild(notice);
    requestAnimationFrame(() => {
      notice.style.opacity = "1";
      notice.style.transform = "translateX(-50%) translateY(0)";
    });
    setTimeout(() => {
      notice.style.opacity = "0";
      notice.style.transform = "translateX(-50%) translateY(-8px)";
      setTimeout(() => notice.remove(), 220);
    }, 3200);
    return { notified: notice.textContent };
  }

  const target = findTarget();
  if (!target || !(target instanceof Element)) throw new Error("没有找到目标元素，请重新读取页面");

  if (action.kind === "mouseMove") {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    await new Promise((resolve) => setTimeout(resolve, 260));
    return { moved: await moveCursor(pointFor(target).x, pointFor(target).y), selector: selectorFor(target) };
  }

  if (action.kind === "hover") {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    await new Promise((resolve) => setTimeout(resolve, 260));
    const point = pointFor(target);
    await moveCursor(point.x, point.y);
    const eventInit = { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y };
    target.dispatchEvent(new PointerEvent("pointerover", { ...eventInit, pointerId: 1, pointerType: "mouse" }));
    target.dispatchEvent(new MouseEvent("mouseover", eventInit));
    target.dispatchEvent(new MouseEvent("mouseenter", eventInit));
    return { hovered: labelOf(target), selector: selectorFor(target), point };
  }

  if (action.kind === "click" || action.kind === "mouseClick") {
    const point = await dispatchMouseGesture(target);
    return { clicked: labelOf(target), selector: selectorFor(target), point };
  }

  if (action.kind === "type") {
    await dispatchMouseGesture(target);
    target.focus();
    const value = action.value || "";
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const sensitive = target.type === "password" || /password|密码|助记词|私钥|seed|secret/i.test(`${target.name} ${target.id} ${target.placeholder}`);
      if (sensitive) throw new Error("扩展禁止自动填写密码、助记词或私钥");
      const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter ? setter.call(target, value) : (target.value = value);
    } else if (target.getAttribute("contenteditable") === "true") {
      target.textContent = value;
    } else {
      throw new Error("目标不是可输入控件");
    }
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { typed: value.length, selector: selectorFor(target) };
  }

  throw new Error(`页面不支持动作：${action.kind}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "reconnect") {
    connect().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "state") {
    settings().then((config) => sendResponse({ ...currentState, allowedOrigins: config.allowedOrigins }));
    return true;
  }
  if (message.type === "allow-origin" || message.type === "deny-origin") {
    settings().then(async (config) => {
      const allowedOrigins = message.type === "allow-origin"
        ? [...new Set([...config.allowedOrigins, message.origin])]
        : config.allowedOrigins.filter((origin) => origin !== message.origin);
      await chrome.storage.local.set({ allowedOrigins });
      sendResponse({ ok: true, allowedOrigins });
    });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.token || changes.bridgeUrl) connect();
});
chrome.runtime.onInstalled.addListener(() => migrateLegacyConnectionDefaults().then(connect));
chrome.runtime.onStartup.addListener(() => migrateLegacyConnectionDefaults().then(connect));
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create("jobdeck-heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState > WebSocket.OPEN) connect();
});
migrateLegacyConnectionDefaults().then(connect);
