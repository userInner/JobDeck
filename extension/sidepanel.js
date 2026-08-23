let apiBase = "http://127.0.0.1:43120";
const $ = (selector) => document.querySelector(selector);
const elements = {
  setup: $("#setup"), workspace: $("#workspace"), connection: $("#connection"),
  chromeDot: $("#chromeDot"), pause: $("#pause"), site: $("#site"), siteToggle: $("#siteToggle"),
  count: $("#count"), queue: $("#queue"), page: $("#page"), history: $("#history"), toast: $("#toast")
};
let state;
let token = "";
let origin = "";
let allowed = false;
let toastTimer;

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2400);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { "X-JobDeck-Token": token } : {}), ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "JobDeck 本地服务没有响应");
  return data;
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { origin = new URL(tab?.url || "").origin; }
  catch { origin = ""; }
  elements.site.textContent = origin && origin !== "null" ? origin : "此页面不可授权";
  const stored = await chrome.storage.local.get({ allowedOrigins: [] });
  const hasPermission = origin && origin !== "null" ? await chrome.permissions.contains({ origins: [`${origin}/*`] }) : false;
  allowed = Boolean(origin && origin !== "null" && stored.allowedOrigins.includes(origin) && hasPermission);
  elements.siteToggle.textContent = allowed ? "停止控制" : "允许此站点";
  elements.siteToggle.classList.toggle("allowed", allowed);
}

function render(next) {
  state = next;
  const paired = Boolean(token);
  elements.setup.classList.toggle("hidden", paired);
  elements.workspace.classList.toggle("hidden", !paired);
  elements.chromeDot.classList.toggle("on", next.extension.connected);
  elements.connection.textContent = next.extension.connected ? "本机工作台与 Chrome 已连接" : "等待 Chrome 执行器连接";
  elements.pause.textContent = next.extension.paused ? "恢复" : "暂停";
  elements.pause.classList.toggle("resume", next.extension.paused);
  elements.count.textContent = next.pendingActions.length;
  renderQueue(next.pendingActions);
  renderPage(next.extension.lastPage);
  renderHistory(next.recentActions);
  renderBoss(next.extension.lastPage);
}

function renderBoss(page) {
  const panel = $("#bossTools");
  const enabled = page?.adapter === "boss-zhipin";
  panel.classList.toggle("hidden", !enabled);
  if (!enabled) return;
  const labels = { "job-list": "职位搜索列表", "job-detail": "职位详情", chat: "沟通消息", resume: "在线简历", other: "BOSS 页面" };
  $("#bossPageType").textContent = labels[page.pageType] || "BOSS 页面";
  const context = page.pageType === "job-detail" ? `${page.boss?.job?.company || "待识别公司"} · ${page.boss?.job?.title || "待识别岗位"}`
    : page.pageType === "job-list" ? `已识别 ${page.boss?.jobCards?.length || 0} 个职位卡片`
      : page.pageType === "chat" ? `${page.boss?.chat?.recruiter || "当前招聘方"} · ${page.boss?.chat?.jobTitle || "当前岗位"}`
        : page.pageType === "resume" ? `已识别 ${page.boss?.resume?.sections?.length || 0} 个简历区块` : "专用解析已启用";
  $("#bossContext").textContent = context;
  $("#draftBossReply").classList.toggle("hidden", page.pageType !== "chat");
}

function renderQueue(queue) {
  if (!queue.length) {
    elements.queue.innerHTML = '<div class="queue-empty">没有待确认操作。填写、点击和跳转会出现在这里。</div>';
    return;
  }
  elements.queue.innerHTML = queue.map((item) => `
    <article class="action"><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.reason || "等待你的确认")}</p>
      <div class="action-buttons"><button data-action="reject" data-id="${item.id}" type="button">拒绝</button><button class="approve" data-action="approve" data-id="${item.id}" type="button">批准执行</button></div>
    </article>`).join("");
}

function renderPage(page) {
  if (!page) {
    elements.page.innerHTML = '<div class="page-empty">还没有读取页面。先允许当前网站，再点击“读取当前页面”。</div>';
    return;
  }
  elements.page.innerHTML = `<span class="url">${escapeHtml(page.url)}</span><h3>${escapeHtml(page.title || "未命名页面")}</h3><pre>${escapeHtml((page.text || "").slice(0, 1400))}</pre>`;
}

function renderHistory(items) {
  if (!items.length) {
    elements.history.innerHTML = '<div class="queue-empty">执行结果只保存在本机。</div>';
    return;
  }
  const labels = { done: "完成", error: "失败", rejected: "拒绝", running: "执行中" };
  elements.history.innerHTML = items.slice(0, 20).map((item) => `
    <div class="log"><time>${new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time><span>${escapeHtml(item.label)}</span><b class="${item.status}">${labels[item.status] || item.status}</b></div>`).join("");
}

async function refresh() {
  try {
    if (!token) token = (await chrome.storage.local.get({ token: "" })).token;
    const next = await request("/api/state");
    if (token && token !== next.pairingToken) {
      token = "";
      await chrome.storage.local.set({ token: "" });
      await chrome.runtime.sendMessage({ type: "reconnect" });
    }
    render(next);
  } catch (error) {
    elements.connection.textContent = "JobDeck 本地服务未启动";
    elements.chromeDot.classList.remove("on");
    if (token) showToast(error.message);
  }
}

$("#pair").addEventListener("click", async () => {
  try {
    const next = await request("/api/state");
    token = next.pairingToken;
    await chrome.storage.local.set({ token });
    await chrome.runtime.sendMessage({ type: "reconnect" });
    render(next);
    showToast("已连接本机 JobDeck");
  } catch {
    showToast("请先启动 JobDeck 本地应用");
  }
});

$("#manualPair").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#openWeb").addEventListener("click", () => chrome.tabs.create({ url: apiBase }));

elements.siteToggle.addEventListener("click", async () => {
  if (!origin || origin === "null") return;
  const pattern = `${origin}/*`;
  if (allowed) await chrome.permissions.remove({ origins: [pattern] });
  else if (!(await chrome.permissions.request({ origins: [pattern] }))) return;
  await chrome.runtime.sendMessage({ type: allowed ? "deny-origin" : "allow-origin", origin });
  await loadTab();
});

elements.pause.addEventListener("click", async () => {
  try {
    const next = await request(state?.extension.paused ? "/api/automation/resume" : "/api/automation/pause", { method: "POST" });
    render(next);
  } catch (error) { showToast(error.message); }
});

$("#inspect").addEventListener("click", async () => {
  try {
    await request("/api/browser/command", { method: "POST", body: JSON.stringify({ kind: "inspect" }) });
    await refresh();
    showToast("页面已读取");
  } catch (error) { showToast(error.message); }
});

$("#capture").addEventListener("click", async () => {
  try {
    const result = await request("/api/jobs/capture-current", { method: "POST" });
    showToast(result.duplicate ? "这个岗位已经保存过" : "岗位已保存到工作台");
    await refresh();
  } catch (error) { showToast(error.message); }
});

$("#discover").addEventListener("click", async () => {
  try {
    const result = await request("/api/jobs/discover-current", { method: "POST" });
    showToast(`发现 ${result.added.length} 个新岗位`);
    await refresh();
  } catch (error) { showToast(error.message); }
});

$("#draftBossReply").addEventListener("click", async () => {
  $("#bossNote").textContent = "正在结合当前对话和候选人事实生成草稿…";
  try {
    const result = await request("/api/boss/draft-reply", { method: "POST" });
    if (result.reply.needsConfirmation) {
      $("#bossNote").textContent = `${result.reply.reason || "该问题需要本人决定"} 建议草稿：${result.reply.draft || "请在 Web 工作台处理"}`;
      showToast("涉及本人决定，未加入自动填写队列");
    } else {
      $("#bossNote").textContent = result.reply.draft;
      showToast(result.item ? "回复草稿已加入确认队列" : "已生成草稿，但未找到输入框");
    }
    await refresh();
  } catch (error) {
    $("#bossNote").textContent = error.message;
    showToast(error.message);
  }
});

elements.queue.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  try {
    await request(`/api/actions/${button.dataset.id}/${button.dataset.action}`, { method: "POST" });
    showToast(button.dataset.action === "approve" ? "已执行" : "已拒绝");
    await refresh();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

chrome.tabs.onActivated.addListener(loadTab);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => { if (changeInfo.url) loadTab(); });
chrome.storage.local.get({ token: "", apiUrl: apiBase }).then((values) => {
  token = values.token;
  apiBase = values.apiUrl;
  refresh();
});
loadTab();
setInterval(refresh, 2000);
