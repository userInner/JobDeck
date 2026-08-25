const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let state;
let activeView = "dashboard";
let chatMode = "general";
let chatMessages = [];
let toastTimer;
let workflowSelection = new Set();
let workflowSelectionRunId = "";
const accessTokenKey = "jobdeckAccessToken";
let accessToken = sessionStorage.getItem(accessTokenKey) || "";
const accountTokenKey = "jobdeckSub2APIAccessToken";
const accountRefreshKey = "jobdeckSub2APIRefreshToken";
let accountAccessToken = sessionStorage.getItem(accountTokenKey) || "";
let accountRefreshToken = sessionStorage.getItem(accountRefreshKey) || "";
let accountConfig;
let accountProfile;

const titles = {
  dashboard: "今天先做对的岗位",
  assistant: "把求职问题说清楚",
  jobs: "每个岗位都有判断依据",
  resume: "简历只说经得起追问的事实",
  automation: "所有浏览器操作都能撤停",
  settings: "把目标和模型设成自己的"
};
const modeNames = { general: "求职策略", matching: "岗位分析", resume: "简历优化", reply: "招聘沟通" };

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);

function toast(message) {
  clearTimeout(toastTimer);
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
}

async function api(path, options = {}, retried = false) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(accountAccessToken ? { Authorization: `Bearer ${accountAccessToken}` } : accessToken ? { "X-JobDeck-Token": accessToken } : {}),
      ...(options.headers || {})
    }
  });
  if (response.status === 401 && !retried && accountRefreshToken && await refreshAccountSession()) {
    return api(path, options, true);
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) showAuthGate(data.error);
  if (!response.ok) throw new Error(data.error || "操作失败");
  return data;
}

async function accountApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(accountAccessToken ? { Authorization: `Bearer ${accountAccessToken}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "账号操作失败");
  return data;
}

function saveAccountSession(payload) {
  accountAccessToken = payload?.access_token || payload?.accessToken || "";
  accountRefreshToken = payload?.refresh_token || payload?.refreshToken || "";
  if (accountAccessToken) sessionStorage.setItem(accountTokenKey, accountAccessToken);
  if (accountRefreshToken) sessionStorage.setItem(accountRefreshKey, accountRefreshToken);
}

function clearAccountSession() {
  accountAccessToken = "";
  accountRefreshToken = "";
  accountProfile = undefined;
  sessionStorage.removeItem(accountTokenKey);
  sessionStorage.removeItem(accountRefreshKey);
}

async function refreshAccountSession() {
  if (!accountRefreshToken) return false;
  try {
    const refreshed = await accountApi("/api/account/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: accountRefreshToken }),
      headers: { Authorization: "" }
    });
    saveAccountSession(refreshed);
    return Boolean(accountAccessToken);
  } catch {
    clearAccountSession();
    return false;
  }
}

async function loadAccountProfile() {
  if (!accountAccessToken) return;
  try {
    accountProfile = await accountApi("/api/account/me");
  } catch (error) {
    if (!accountRefreshToken) {
      clearAccountSession();
      return;
    }
    try {
      if (!(await refreshAccountSession())) return;
      accountProfile = await accountApi("/api/account/me");
    } catch {
      clearAccountSession();
    }
  }
}

async function initializeAccount() {
  try {
    accountConfig = await accountApi("/api/account/config", { headers: { Authorization: "" } });
    await loadAccountProfile();
  } catch (error) {
    accountConfig = { enabled: false, error: error.message };
  }
  renderAccount();
}

function showAuthGate(message = "请登录后进入你的独立 JobDeck 工作区") {
  $("#authMessage").textContent = message;
  $("#authGate").hidden = false;
  const accountMode = Boolean(accountConfig?.multiUser);
  $("#legacyAuthFields").hidden = accountMode;
  $("#authGoLogin").hidden = !accountMode;
  if (!accountMode) queueMicrotask(() => $("#accessToken")?.focus());
}

function hideAuthGate() {
  $("#authGate").hidden = true;
}

function setBusy(button, busy, label = "处理中…") {
  if (!button) return;
  if (busy) {
    button.dataset.original = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.original || button.textContent;
    button.disabled = false;
  }
}

function go(view) {
  activeView = view;
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $("#pageTitle").textContent = titles[view];
}

async function refresh() {
  try {
    state = await api("/api/state");
    hideAuthGate();
    render();
    $("#privacyDot").classList.add("on");
    $("#dataStatus").textContent = "JobDeck 服务已连接";
  } catch (error) {
    $("#dataStatus").textContent = error.message.includes("访问令牌") ? "等待访问令牌" : "JobDeck 服务未连接";
    $("#privacyDot").classList.remove("on");
    toast(error.message);
  }
}

function render() {
  renderHeader();
  renderWorkflow();
  renderDashboard();
  renderJobs();
  renderResume();
  renderAutomation();
  renderSettings();
  refreshChatActionCards();
}

function renderWorkflow() {
  const workflow = state.workflow || { phase: "not-started", search: {}, batch: [] };
  const phase = workflow.phase || "not-started";
  const copy = {
    "not-started": ["从在线简历开始，而不是盲投", "首次运行会先打开 BOSS 在线简历，完成审查后再进入职位搜索。"],
    "resume-loading": ["正在自动检查 BOSS 在线简历", workflow.resumeAuditMessage || "简历页已经打开，系统会等待页面加载、读取内容并交给 AI 审查。"],
    "resume-open": ["在线简历自动审查需要处理", workflow.resumeAuditMessage || "请确认登录状态或在扩展中允许 zhipin.com，然后继续自动审查。"],
    "resume-optimizing": ["AI 正在帮你修改简历", workflow.resumeOptimizationMessage || "正在生成按字段拆分的可替换优化稿。"],
    "resume-applying": ["插件 Computer Use 正在修改 BOSS 简历", workflow.resumeApply?.message || "正在移动、点击、输入、保存并回读验证。"],
    "resume-review": ["先决定简历是否需要修改", "审查已经完成。建议先处理会影响 AI 岗位判断的问题，再进入职位搜索。"],
    "search-open": ["按期望城市去 BOSS 找岗位", `点击“自动找工作”后会按设置中的期望城市（${state.candidate.locations.join("、")}）搜索目标岗位；不会读取或沿用浏览器当前位置。`],
    shortlist: ["候选岗位需要逐条读完整 JD", `已发现 ${workflow.search?.discovered || 0} 个候选，已完成 ${workflow.search?.analyzed || 0} 个完整 JD 分析。`],
    "job-open": ["读取当前岗位的完整 JD", "候选岗位已经打开。等待页面加载完成后再分析，避免只凭职位卡片判断。"],
    "ready-to-apply": ["高匹配小批次已经准备好", `本批共 ${workflow.batch?.length || 0} 个岗位；逐条打开、核对招呼语并确认联系。`],
    "apply-review": ["核对当前投递", "岗位详情已经打开。请核对岗位状态和定制招呼语，再进入沟通。"],
    "analysis-running": workflow.autopilot?.autoApply
      ? ["自动找工作正在运行", `目标至少 ${workflow.autopilot?.targetApplications || 60} 份。系统会按期望城市（${state.candidate.locations.join("、")}）持续搜索、翻页并读取完整 JD，匹配后发送各自的定制招呼语。`]
      : ["正在建立岗位排名", "系统正在逐条打开最多 8 个候选，读取完整 JD，并按经历、技术栈、地点和薪资评分。"],
    "ranking-ready": ["排名好了，由你决定投哪些", "70 分以上默认勾选，但不是硬限制。你可以单选、多选、只选推荐项，或者全部投递。"],
    "autopilot-running": ["匹配岗位正在投递", "系统已完成岗位与技术栈判断，正在逐条发送基于真实 JD 的定制招呼语。"],
    "autopilot-blocked": ["托管投递已暂停", "页面需要本人处理，或无法安全确认某个控件；处理后可回到职位列表重新启动。"],
    "apply-complete": ["自动找工作目标已完成", `已验证发送 ${workflow.autopilot?.sent || 0}/${workflow.autopilot?.targetApplications || 60} 个沟通。`]
  }[phase] || ["继续首次求职流程", "按在线简历、职位搜索、完整 JD 和投递确认依次完成。"];
  $("#workflowTitle").textContent = copy[0];
  $("#workflowStatus").textContent = copy[1];

  const resumeBusy = ["preparing", "running"].includes(workflow.resumeApply?.status)
    || workflow.resumeAuditStatus === "running"
    || workflow.resumeOptimizationStatus === "running";
  const jobsBusy = String(workflow.autopilot?.status || "").startsWith("running-");
  const resumeLabel = resumeBusy ? "正在自动修改简历…" : "自动修改简历";
  const jobAction = jobsBusy ? "stop-autopilot" : "auto-find-jobs";
  const jobLabel = jobsBusy ? "停止自动找工作" : "自动找工作";
  const actions = `
    <button data-workflow-action="auto-resume" class="workflow-primary-action resume-action" type="button" ${resumeBusy ? "disabled" : ""}>${resumeLabel}</button>
    <button data-workflow-action="${jobAction}" class="workflow-primary-action job-action" type="button">${jobLabel}</button>`;
  $("#workflowActions").innerHTML = actions;

  const phaseStep = ({ "not-started": 0, "resume-loading": 1, "resume-open": 1, "resume-optimizing": 1, "resume-applying": 1, "resume-review": 1, "search-open": 2, shortlist: 3, "job-open": 3, "analysis-running": 3, "ranking-ready": 3, "ready-to-apply": 4, "apply-review": 4, "autopilot-running": 4, "autopilot-blocked": 4, "apply-complete": 4 })[phase] || 0;
  $$("[data-workflow-step]").forEach((element, index) => {
    element.classList.toggle("active", index + 1 === phaseStep);
    element.classList.toggle("done", index + 1 < phaseStep);
  });

  const audit = workflow.resumeAudit;
  const autopilot = workflow.autopilot;
  const resultParts = [];
  if (audit) {
    resultParts.push(`
      <div class="audit-score"><strong>${audit.score}</strong><small>在线简历评分</small></div>
      <div><p><b>第一屏判断：</b>${escapeHtml(audit.firstScreen || "暂无")}</p>
      ${audit.issues?.length ? `<p><b>优先修改：</b>${audit.issues.map(escapeHtml).join("；")}</p>` : ""}
      ${audit.suggestions?.length ? `<p><b>建议：</b>${audit.suggestions.map(escapeHtml).join("；")}</p>` : ""}</div>`);
  }
  if (workflow.resumeOptimization) resultParts.push(renderResumeOptimization(workflow.resumeOptimization));
  if (workflow.resumeApply?.status && workflow.resumeApply.status !== "idle") {
    const apply = workflow.resumeApply;
    const applying = apply.status === "running";
    resultParts.push(`<div class="resume-apply-progress ${applying ? "running" : apply.status === "complete" ? "complete" : "blocked"}">
      <strong>${applying ? "正在自动写入" : apply.status === "complete" ? "写入已验证" : "写入已暂停"}</strong>
      <p>${escapeHtml(apply.message || "")}</p>
      ${apply.appliedFields?.length ? `<span><b>已写入</b>${apply.appliedFields.map(escapeHtml).join("、")}</span>` : ""}
      ${apply.skippedFields?.length ? `<span><b>未自动修改</b>${apply.skippedFields.map(escapeHtml).join("、")}</span>` : ""}
    </div>`);
  }
  if (autopilot && autopilot.status !== "idle") {
    resultParts.push(`<div class="autopilot-progress">
      <strong>${escapeHtml(String(autopilot.status).startsWith("running-") ? "正在处理" : autopilot.status === "selection-ready" ? "等待选择" : autopilot.status === "complete" ? "本轮完成" : "需要处理")}</strong>
      <span>发现 ${autopilot.discovered || 0} · 已读 JD ${autopilot.analyzed || 0} · 匹配 ${autopilot.selected || 0} · 已发送 ${autopilot.sent || 0}/${autopilot.targetApplications || 60}</span>
      <p>${escapeHtml(autopilot.message || "")}</p>
    </div>`);
  } else if (workflow.lastError) {
    resultParts.push(`<p class="workflow-error"><b>上次未完成：</b>${escapeHtml(workflow.lastError)}</p>`);
  }
  $("#workflowResults").innerHTML = resultParts.join("");
  updateRankingSelectionUI();
}

function renderResumeOptimization(optimization) {
  const workflow = state.workflow || {};
  const generating = workflow.resumeOptimizationStatus === "running";
  const apply = workflow.resumeApply || {};
  const appliesToThisDraft = apply.status === "complete"
    && Boolean(optimization.generatedAt)
    && apply.optimizationGeneratedAt === optimization.generatedAt;
  const verified = new Set(apply.verifiedFieldKeys || []);
  const updated = new Set(apply.updatedFieldKeys || []);
  const fieldState = (field) => {
    if (generating) return "新稿生成中";
    if (!appliesToThisDraft) return field.key === "targetRoles" ? "需单独确认" : "待写入";
    if (field.key === "targetRoles") return "未自动修改";
    if (verified.has(field.key)) {
      const stateLabel = updated.has(field.key) ? "正文已写入" : "正文已核对一致";
      if (field.key === "workExperience") return `${stateLabel} · 职位/日期未改`;
      if (["projectExperience", "openSource"].includes(field.key)) return `${stateLabel} · 名称/日期/独立链接未改`;
      return updated.has(field.key) ? "已写入并验证" : "已核对一致";
    }
    return "未处理";
  };
  return `<section class="resume-optimization">
    <header><div><p class="eyebrow">简历优化</p><h3>${appliesToThisDraft ? "已逐项核对的简历优化稿" : "待写入的简历优化稿"}</h3><p>${escapeHtml(optimization.summary || "已根据在线简历和审查结果生成。")}</p></div></header>
    <div class="resume-field-list">${(optimization.fields || []).map((field, index) => `<article class="resume-field-card">
      <div class="resume-field-meta"><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(field.reason)}</small></div><em class="resume-field-state">${fieldState(field)}</em></div>
      ${field.currentSummary ? `<p class="resume-current"><b>${appliesToThisDraft && verified.has(field.key) ? "生成时问题" : "当前问题"}</b>${escapeHtml(field.currentSummary)}</p>` : ""}
      <pre>${escapeHtml(field.replacement)}</pre>
    </article>`).join("")}</div>
    ${optimization.factsToConfirm?.length ? `<footer><b>写入前需要确认：</b>${optimization.factsToConfirm.map(escapeHtml).join("；")}</footer>` : ""}
  </section>`;
}

function renderRankingBoard(jobs) {
  const dimension = (label, value) => `<span><i style="--score:${Number(value) || 0}%"></i><b>${label}</b><em>${Number(value) || 0}</em></span>`;
  return `<section class="ranking-board">
    <header><div><p class="eyebrow">完整 JD 分析</p><h3>${jobs.length} 个候选岗位</h3></div>
      <div class="ranking-tools"><button data-ranking-action="recommended" type="button">仅选 70+</button><button data-ranking-action="all" type="button">全选</button><button data-ranking-action="clear" type="button">清空</button></div>
    </header>
    <div class="ranking-list">${jobs.map((job, index) => {
      const dimensions = job.analysis?.dimensions || {};
      const checked = workflowSelection.has(job.id);
      return `<label class="ranking-row ${checked ? "selected" : ""} ${job.score < 70 ? "low-score" : ""}" data-ranking-row="${job.id}">
        <input type="checkbox" data-ranking-job="${job.id}" ${checked ? "checked" : ""}>
        <span class="rank-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="rank-score">${job.score ?? "—"}<small>${escapeHtml(job.analysis?.verdict || "待判断")}</small></span>
        <span class="rank-main"><strong>${escapeHtml(job.title)}</strong><small>${escapeHtml(job.company)} · ${escapeHtml(job.location || "地点未知")} · ${escapeHtml(job.salary || "薪资未知")}</small><p>${escapeHtml(job.analysis?.summary || "")}</p></span>
        <span class="rank-dimensions">${dimension("方向", dimensions.roleFit)}${dimension("经历", dimensions.experience)}${dimension("技术", dimensions.stack)}${dimension("地点", dimensions.location)}${dimension("薪资", dimensions.compensation)}</span>
      </label>`;
    }).join("")}</div>
    <footer><div><strong id="rankingSelectedCount">已选 0 个</strong><small>低于 70 分的岗位也可以由你手动选中</small></div><button id="applyRankedJobs" class="primary" data-ranking-action="apply" type="button">投递已选岗位</button></footer>
  </section>`;
}

function updateRankingSelectionUI() {
  $$('[data-ranking-job]').forEach((checkbox) => {
    checkbox.checked = workflowSelection.has(checkbox.dataset.rankingJob);
    checkbox.closest(".ranking-row")?.classList.toggle("selected", checkbox.checked);
  });
  const count = workflowSelection.size;
  if ($("#rankingSelectedCount")) $("#rankingSelectedCount").textContent = `已选 ${count} 个`;
  if ($("#applyRankedJobs")) {
    $("#applyRankedJobs").textContent = count ? `投递已选 ${count} 个岗位` : "请先选择岗位";
    $("#applyRankedJobs").disabled = count === 0;
  }
}

function renderHeader() {
  const model = $("#modelState");
  model.textContent = state.provider.configured ? `${state.provider.model} 已连接` : "模型未配置";
  model.className = `state-pill ${state.provider.configured ? "on" : "off"}`;
  const chrome = $("#chromeState");
  chrome.textContent = state.extension.connected ? "Chrome 已连接" : "Chrome 未连接";
  chrome.className = `state-pill ${state.extension.connected ? "on" : "off"}`;
  $("#pauseAll").textContent = state.extension.paused ? "恢复操作" : "暂停操作";
  $("#pauseAll").classList.toggle("resume", state.extension.paused);
}

function countStatus(...statuses) {
  return state.jobs.filter((job) => statuses.includes(job.status)).length;
}

function renderDashboard() {
  $("#targetRoles").textContent = state.candidate.targetRoles.join(" · ") || "尚未设置";
  $("#targetLocations").textContent = state.candidate.locations.join(" · ") || "尚未设置";
  $("#salaryTarget").textContent = Number(state.candidate.salaryFloorK) > 0 || Number(state.candidate.salaryUpperTargetK) > 0
    ? `${state.candidate.salaryFloorK || "未设"}K+ / 上限 ${state.candidate.salaryUpperTargetK || "未设"}K+`
    : "尚未设置";
  $("#countCaptured").textContent = state.jobs.length;
  $("#countRecommended").textContent = state.jobs.filter((job) => Number(job.score) >= 70).length;
  $("#countSent").textContent = countStatus("sent", "replied", "interview");
  $("#countReplied").textContent = countStatus("replied", "interview");
  $("#countInterview").textContent = countStatus("interview");
  $("#activePageLabel").textContent = state.extension.lastPage?.title || "尚未读取";
  $("#pendingBadge").textContent = state.pendingActions.length;
  $("#dashboardQueue").innerHTML = compactActions(state.pendingActions.slice(0, 4));

  const ranked = [...state.jobs].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 5);
  $("#topJobs").innerHTML = ranked.length ? ranked.map((job) => `
    <div class="job-row">
      <span class="score ${job.score >= 70 ? "high" : ""}">${job.score ?? "—"}</span>
      <div><strong>${escapeHtml(job.company)} · ${escapeHtml(job.title)}</strong><small>${escapeHtml([job.location, job.salary, job.analysis?.verdict].filter(Boolean).join(" / ") || "等待分析")}</small></div>
      <button data-job-action="analyze" data-id="${job.id}" type="button">${job.score === null ? "分析" : "重算"}</button>
    </div>`).join("") : empty("还没有岗位", "在 Chrome 打开职位详情，然后捕获当前岗位。");

  const activity = state.activity.slice(0, 7);
  $("#recentActivity").innerHTML = activity.length ? activity.map((item) => `
    <div class="activity-item"><time>${formatTime(item.at)}</time><span>${escapeHtml(item.label)}</span></div>`).join("") : empty("还没有动态", "捕获岗位或保存设置后会记录在这里。");
}

function compactActions(items) {
  return items.length ? items.map((item) => `
    <div class="compact-action"><div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.reason)}</small></div><button class="approve-compact" data-action-id="${item.id}" type="button">批准</button></div>`).join("") : empty("没有待确认操作", "填写、点击和跳转都需要你批准。");
}

function empty(title, text) {
  return `<div class="empty"><div><strong>${escapeHtml(title)}</strong><br>${escapeHtml(text)}</div></div>`;
}

function renderJobs() {
  const filter = $("#jobFilter")?.value || "all";
  const jobs = filter === "all" ? state.jobs : state.jobs.filter((job) => job.status === filter);
  $("#allJobs").innerHTML = jobs.length ? jobs.map((job) => `
    <article class="job-card">
      <div class="large-score">${job.score ?? "—"}</div>
      <div>
        <h3>${escapeHtml(job.company)} · ${escapeHtml(job.title)}</h3>
        <p class="meta">${escapeHtml([job.location, job.salary, job.analysis?.verdict, statusName(job.status)].filter(Boolean).join(" / "))}</p>
        <p class="summary">${escapeHtml(job.analysis?.summary || "岗位已保存，等待 AI 分析完整 JD。")}</p>
      </div>
      <div class="job-actions">
        <button data-job-action="analyze" data-id="${job.id}" type="button">${job.score === null ? "AI 分析" : "重新分析"}</button>
        ${job.greeting ? `<button data-job-action="queue" data-id="${job.id}" type="button">填入招呼语</button>` : ""}
        ${job.url ? `<a href="${escapeHtml(job.url)}" target="_blank" rel="noreferrer">打开岗位</a>` : ""}
      </div>
    </article>`).join("") : empty("没有符合筛选的岗位", "换一个状态，或从 Chrome 捕获当前职位。");
}

function statusName(status) {
  return ({ captured: "待分析", analyzed: "已分析", sent: "已沟通", replied: "有回复", interview: "面试", skipped: "已跳过" })[status] || status;
}

function renderResume() {
  setValueUnlessFocused("#candidateStatus", state.candidate.status || "");
  setValueUnlessFocused("#candidateGithub", state.candidate.github || "");
  setValueUnlessFocused("#resumePath", state.candidate.resumePath || "");
  setValueUnlessFocused("#resumeText", state.candidate.resumeText || "");
  $("#facts").innerHTML = state.candidate.facts.map((fact) => `<div class="fact">${escapeHtml(fact)}</div>`).join("");
}

function renderAutomation() {
  $("#automationCount").textContent = state.pendingActions.length;
  const queue = state.pendingActions;
  $("#automationQueue").innerHTML = queue.length ? queue.map((item) => `
    <article class="action-item"><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(item.reason)}</p><div class="button-row"><button data-action-operation="reject" data-action-id="${item.id}" type="button">拒绝</button><button class="primary" data-action-operation="approve" data-action-id="${item.id}" type="button">批准执行</button></div></article>`).join("") : empty("操作队列为空", "AI 和工作台提出的浏览器操作会出现在这里。");
  const history = state.recentActions;
  $("#actionHistory").innerHTML = history.length ? history.map((item) => `
    <div class="history-item"><time>${formatTime(item.createdAt)}</time><span>${escapeHtml(item.label)}</span><b class="${item.status}">${escapeHtml(statusResult(item.status))}</b></div>`).join("") : empty("还没有执行记录", "批准或拒绝操作后会留下本地记录。");
}

function statusResult(status) {
  return ({ done: "完成", error: "失败", rejected: "拒绝", running: "执行中" })[status] || status;
}

function renderSettings() {
  setValueUnlessFocused("#providerMode", state.provider.mode);
  setValueUnlessFocused("#providerModel", state.provider.model);
  setValueUnlessFocused("#providerBaseURL", state.provider.baseURL);
  setValueUnlessFocused("#settingsRoles", state.candidate.targetRoles.join("\n"));
  setValueUnlessFocused("#settingsLocations", state.candidate.locations.join("\n"));
  setValueUnlessFocused("#salaryFloor", state.candidate.salaryFloorK);
  setValueUnlessFocused("#salaryUpper", state.candidate.salaryUpperTargetK);
  const managed = state.provider.source === "sub2api";
  $("#providerKeyField").hidden = managed;
  $("#providerBaseURL").readOnly = managed;
  $("#providerStorageHint").textContent = managed
    ? "已自动使用当前账号的 Sub2API API Key"
    : "密钥仅保存在你的 JobDeck 服务";
  renderAccount();
}

function renderAccount() {
  const connection = $("#accountConnection");
  if (!connection) return;
  connection.textContent = accountConfig?.enabled === false
    ? accountConfig.error || "账号服务不可用"
    : `${accountConfig?.siteName || "OnPeople"} · 邮箱账号`;
  $("#accountLoggedOut").hidden = Boolean(accountProfile);
  $("#accountLoggedIn").hidden = !accountProfile;
  if (!accountProfile) return;
  const profile = accountProfile.user || accountProfile;
  $("#accountIdentity").textContent = profile.email || profile.username || `用户 #${profile.id || profile.user_id || "—"}`;
  const balance = profile.balance ?? profile.credit ?? profile.quota;
  $("#accountBalance").textContent = balance === undefined ? "已登录" : `AI 余额：$${Number(balance).toFixed(2)}`;
  const reward = accountConfig?.reward || {};
  $("#starRewardCard").hidden = false;
  $("#starRewardCard h3").textContent = reward.enabled
    ? `Star ${reward.repository}，领取 $${reward.amount} AI 额度`
    : "Star 奖励等待服务端启用";
  $("#starRewardForm").hidden = !reward.enabled;
  if (!reward.enabled) $("#starRewardCard p:not(.eyebrow)").textContent = "管理员配置 SUB2API_ADMIN_API_KEY 后即可开放一次性 $5 奖励；管理密钥不会下发到浏览器。";
  const repository = reward.repository || "userInner/JobDeck";
  $("#openRewardRepository").href = `https://github.com/${repository}`;
}

function setValueUnlessFocused(selector, value) {
  const element = $(selector);
  if (element && document.activeElement !== element) element.value = value;
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

async function capture(button) {
  setBusy(button, true, "读取中…");
  try {
    const { job, duplicate } = await api("/api/jobs/capture-current", { method: "POST" });
    toast(duplicate ? "这个岗位已经保存过" : "岗位已保存");
    if (!duplicate && state.provider.configured) {
      toast("岗位已保存，正在进行 AI 分析");
      await api(`/api/jobs/${job.id}/analyze`, { method: "POST" });
    }
    await refresh();
    go("jobs");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function analyzeJob(id, button) {
  setBusy(button, true, "分析中…");
  try {
    await api(`/api/jobs/${id}/analyze`, { method: "POST" });
    toast("岗位分析完成");
    await refresh();
  } catch (error) {
    toast(error.message);
    if (/API Key/.test(error.message)) go("settings");
  } finally { setBusy(button, false); }
}

function greetingSelector() {
  const elements = state.extension.lastPage?.interactives || [];
  const messageWords = /消息|回复|招呼|输入|message|chat|reply/i;
  return elements.find((item) => item.tag === "textarea" && messageWords.test(item.label || ""))?.selector
    || elements.find((item) => item.tag === "textarea")?.selector
    || elements.find((item) => item.tag === "input" && messageWords.test(item.label || ""))?.selector;
}

async function queueGreeting(id, button) {
  setBusy(button, true, "加入中…");
  try {
    await api(`/api/jobs/${id}/queue-greeting`, {
      method: "POST",
      body: JSON.stringify({ selector: greetingSelector() })
    });
    toast("已加入浏览器确认队列");
    await refresh();
    go("automation");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function processAction(id, operation, button) {
  setBusy(button, true, operation === "approve" ? "执行中…" : "处理中…");
  try {
    await api(`/api/actions/${id}/${operation}`, { method: "POST" });
    toast(operation === "approve" ? "浏览器操作已完成" : "已拒绝操作");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

$$('.nav-item').forEach((button) => button.addEventListener("click", () => go(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener("click", () => go(button.dataset.go)));
$("#captureJob").addEventListener("click", (event) => capture(event.currentTarget));
$("#captureJobSecondary").addEventListener("click", (event) => capture(event.currentTarget));
$("#discoverJobs").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true, "扫描中…");
  try {
    const result = await api("/api/jobs/discover-current", { method: "POST" });
    toast(`发现 ${result.added.length} 个新岗位，跳过 ${result.duplicates} 个重复项`);
    await refresh();
    if (result.added.length) go("jobs");
  } catch (error) { toast(error.message); }
  finally { setBusy(event.currentTarget, false); }
});
$("#readPage").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true, "读取中…");
  try { await api("/api/browser/command", { method: "POST", body: JSON.stringify({ kind: "inspect" }) }); await refresh(); toast("页面已读取"); }
  catch (error) { toast(error.message); }
  finally { setBusy(event.currentTarget, false); }
});

$("#browserTaskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const instruction = $("#browserTask").value.trim();
  if (!instruction) return;
  const button = $("#browserTaskForm button[type='submit']");
  setBusy(button, true, "规划中…");
  try {
    const plan = await api("/api/browser/plan", { method: "POST", body: JSON.stringify({ instruction }) });
    $("#browserPlanSummary").textContent = plan.summary || (plan.items.length ? "操作已加入确认队列。" : "没有生成可安全执行的操作。");
    toast(plan.items.length ? `已生成 ${plan.items.length} 个待确认操作` : "当前页面还不能安全生成操作");
    await refresh();
  } catch (error) {
    toast(error.message);
    if (/API Key/.test(error.message)) go("settings");
  } finally { setBusy(button, false); }
});

document.addEventListener("click", (event) => {
  const resumeButton = event.target.closest("[data-resume-action]");
  if (resumeButton) copyResumeOptimization(resumeButton.dataset.resumeAction, resumeButton.dataset.resumeField);
  const rankingButton = event.target.closest("[data-ranking-action]");
  if (rankingButton) runRankingAction(rankingButton.dataset.rankingAction, rankingButton);
  const workflowButton = event.target.closest("[data-workflow-action]");
  if (workflowButton) runWorkflowAction(workflowButton.dataset.workflowAction, workflowButton);
  const jobButton = event.target.closest("[data-job-action]");
  if (jobButton) {
    if (jobButton.dataset.jobAction === "analyze") analyzeJob(jobButton.dataset.id, jobButton);
    if (jobButton.dataset.jobAction === "queue") queueGreeting(jobButton.dataset.id, jobButton);
  }
  const compact = event.target.closest(".approve-compact");
  if (compact) processAction(compact.dataset.actionId, "approve", compact);
  const actionButton = event.target.closest("[data-action-operation]");
  if (actionButton) processAction(actionButton.dataset.actionId, actionButton.dataset.actionOperation, actionButton);
});

async function copyResumeOptimization(action, fieldKey) {
  const optimization = state.workflow?.resumeOptimization;
  if (!optimization) return;
  const field = (optimization.fields || []).find((item) => item.key === fieldKey);
  const text = action === "copy-field"
    ? field?.replacement
    : (optimization.fields || []).map((item) => `【${item.label}】\n${item.replacement}`).join("\n\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(action === "copy-field" ? "这一项已复制" : "整份优化稿已复制");
  } catch {
    toast("复制失败，请在本机工作台重试");
  }
}

document.addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-ranking-job]");
  if (!checkbox) return;
  checkbox.checked ? workflowSelection.add(checkbox.dataset.rankingJob) : workflowSelection.delete(checkbox.dataset.rankingJob);
  updateRankingSelectionUI();
});

async function runRankingAction(action, button) {
  const rankedIds = state.workflow?.autopilot?.rankedJobIds || [];
  if (action === "all") workflowSelection = new Set(rankedIds);
  if (action === "clear") workflowSelection.clear();
  if (action === "recommended") {
    workflowSelection = new Set(rankedIds.filter((id) => Number(state.jobs.find((job) => job.id === id)?.score) >= 70));
  }
  if (action !== "apply") return updateRankingSelectionUI();
  const selectedIds = rankedIds.filter((id) => workflowSelection.has(id));
  if (!selectedIds.length) return;
  const lowScore = selectedIds.filter((id) => Number(state.jobs.find((job) => job.id === id)?.score) < 70).length;
  const warning = lowScore ? `\n其中 ${lowScore} 个岗位低于 70 分。` : "";
  const approved = window.confirm(`将自动联系并发送 ${selectedIds.length} 个岗位的定制招呼语。${warning}\n\n每条发送后都会验证结果；出现验证码或页面异常会立即停止。是否继续？`);
  if (!approved) return;
  setBusy(button, true, "开始投递…");
  try {
    const result = await api("/api/workflow/autopilot/apply-selected", {
      method: "POST",
      body: JSON.stringify({ approved: true, jobIds: selectedIds })
    });
    toast(`已开始投递你选择的 ${result.selected} 个岗位`);
    await refresh();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function runWorkflowAction(action, button) {
  if (action === "go-jobs") return go("jobs");
  if (action === "auto-resume") {
    const approved = window.confirm("将自动打开 BOSS 在线简历，完成 AI 审查与优化，并由插件 Computer Use 逐项点击、输入、保存和回读验证。\n\n公司名称、职位日期、薪资等需要本人确认的结构化信息不会擅自修改；遇到登录失效、验证码或无法确认的控件会立即暂停。是否继续？");
    if (!approved) return;
    setBusy(button, true, "正在自动修改简历…");
    try {
      await api("/api/workflow/resume/auto", {
        method: "POST",
        body: JSON.stringify({ approved: true })
      });
      toast("已启动自动修改简历");
      await refresh();
    } catch (error) { toast(error.message); }
    finally { setBusy(button, false); }
    return;
  }
  if (action === "apply-resume-optimization") {
    const optimization = state.workflow?.resumeOptimization;
    const fields = (optimization?.fields || []).filter((item) => ["personalAdvantage", "workExperience", "projectExperience", "openSource"].includes(item.key) && String(item.replacement || "").trim());
    if (!fields.length) return toast("当前没有可安全自动写入的简历优化稿");
    const labels = [...new Set([...fields.map((field) => field.label), "专业技能中的 Telegram Bot 经历"])];
    const approved = window.confirm(`插件 Computer Use 将逐项修改并验证：\n\n${labels.map((label) => `· ${label}`).join("\n")}\n\n公司、职位、日期、薪资等事实字段不会在缺少确切证据时自动修改；期望职位候选项需要另行确认。每保存一项都会回读验证，遇到异常立即停止。\n\n是否确认继续？`);
    if (!approved) return;
    setBusy(button, true, "开始写入…");
    try {
      await api("/api/workflow/resume/apply-optimization", {
        method: "POST",
        body: JSON.stringify({ approved: true })
      });
      toast("已打开 BOSS 在线简历，Computer Use 正在逐项修改并验证");
      await refresh();
    } catch (error) { toast(error.message); }
    finally { setBusy(button, false); }
    return;
  }
  if (action === "start-analysis") {
    setBusy(button, true, "开始评分…");
    try {
      const result = await api("/api/workflow/autopilot/analyze", { method: "POST", body: "{}" });
      toast(`已开始读取并评分 ${result.candidates} 个完整 JD`);
      await refresh();
    } catch (error) { toast(error.message); }
    finally { setBusy(button, false); }
    return;
  }
  if (action === "auto-find-jobs") {
    const locations = state.candidate.locations.join("、");
    const approved = window.confirm(`将启动目标制自动求职：\n\n· 本次目标：至少验证沟通 60 个匹配岗位\n· 只按期望城市搜索：${locations}\n· 不使用浏览器定位或当前所在城市\n· 循环搜索 AI Agent、LLM/AI 应用、AIGC 全栈和 Go+AI 后端方向\n· 自动滚动、翻页、读取完整 JD，不计算分数，只判断岗位和核心技术栈是否匹配\n· 每个匹配岗位生成不同的定制招呼并自动发送\n· 发送后自动返回岗位列表继续执行，不以固定步骤数结束\n· 自动跳过已沟通、重复及明确不匹配的岗位\n\n完成 60 个验证沟通后结束；遇到验证码、登录失效、平台风控或所有搜索方向连续没有新岗位时暂停。是否授权？`);
    if (!approved) return;
    setBusy(button, true, "启动自动找工作…");
    try {
      const result = await api("/api/workflow/autopilot/run", {
        method: "POST",
        body: JSON.stringify({ approved: true, targetApplications: 60 })
      });
      toast(`已启动 ${result.searches} 组搜索，目标至少 ${result.targetApplications} 份，只使用：${result.locations.join("、")}`);
      await refresh();
    } catch (error) { toast(error.message); }
    finally { setBusy(button, false); }
    return;
  }
  if (action === "stop-autopilot") {
    setBusy(button, true, "停止中…");
    try { await api("/api/workflow/autopilot/stop", { method: "POST", body: "{}" }); await refresh(); toast("已请求停止"); }
    catch (error) { toast(error.message); }
    finally { setBusy(button, false); }
    return;
  }
  const routes = {
    start: ["/api/workflow/start", {}, "正在打开…"],
    "audit-resume": ["/api/workflow/resume/audit", {}, "审查中…"],
    "optimize-resume": ["/api/workflow/resume/optimize", {}, "生成中…"],
    "open-existing-resume": ["/api/workflow/resume/open-existing", {}, "正在打开…"],
    "resume-optimized": ["/api/workflow/resume/continue", { decision: "optimized" }, "正在打开…"],
    "resume-continue": ["/api/workflow/resume/continue", { decision: "continue" }, "正在打开…"],
    "open-search": ["/api/workflow/search/open", {}, "正在打开…"],
    "scan-jobs": ["/api/workflow/search/scan", { keyword: state.workflow?.search?.keyword || "AI Agent" }, "扫描中…"],
    "open-next-job": ["/api/workflow/search/open-next", {}, "正在打开…"],
    "analyze-current-job": ["/api/workflow/search/analyze-current", {}, "分析中…"],
    "prepare-batch": ["/api/workflow/apply/prepare", {}, "准备中…"],
    "open-next-application": ["/api/workflow/apply/open-next", {}, "正在打开…"]
  };
  const route = routes[action];
  if (!route) return;
  setBusy(button, true, route[2]);
  try {
    const result = await api(route[0], { method: "POST", body: JSON.stringify(route[1]) });
    const notices = {
      start: "已打开 BOSS 在线简历，正在自动读取与审查",
      "audit-resume": "已继续自动读取与审查",
      "optimize-resume": "AI 正在生成简历优化稿",
      "open-existing-resume": "已切换到 BOSS 在线简历",
      "resume-optimized": "已进入职位搜索",
      "resume-continue": "已进入职位搜索",
      "open-search": "已打开 BOSS 职位页",
      "scan-jobs": `新增 ${result.added?.length || 0} 个候选岗位`,
      "open-next-job": "已打开候选岗位",
      "analyze-current-job": "完整 JD 分析完成",
      "prepare-batch": `已准备 ${result.batch?.length || 0} 个高匹配岗位`,
      "open-next-application": "已打开待投岗位"
    };
    toast(notices[action] || "流程已更新");
    await refresh();
  } catch (error) {
    toast(error.message);
    if (/API Key|401|认证|Incorrect/.test(error.message)) go("settings");
  } finally { setBusy(button, false); }
}

$("#jobFilter").addEventListener("change", renderJobs);
$("#pauseAll").addEventListener("click", async () => {
  try {
    await api(state.extension.paused ? "/api/automation/resume" : "/api/automation/pause", { method: "POST" });
    await refresh();
  } catch (error) { toast(error.message); }
});

$$('.mode').forEach((button) => button.addEventListener("click", () => {
  chatMode = button.dataset.mode;
  $$('.mode').forEach((item) => item.classList.toggle("active", item === button));
  $("#chatModeLabel").textContent = modeNames[chatMode];
}));

$("#chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chatInput");
  const content = input.value.trim();
  if (!content) return;
  chatMessages.push({ role: "user", content });
  const requestMessages = [...chatMessages];
  const assistant = { role: "assistant", content: "", streaming: true };
  chatMessages.push(assistant);
  const assistantIndex = chatMessages.length - 1;
  renderMessages();
  input.value = "";
  const button = $("#chatForm button[type='submit']");
  setBusy(button, true, "正在生成…");
  try {
    await streamChat({ mode: chatMode, messages: requestMessages }, (delta) => {
      assistant.content += delta;
      updateStreamingMessage(assistantIndex);
    }, (action) => {
      assistant.action = action;
      renderMessages();
    });
    assistant.streaming = false;
    renderMessages();
  } catch (error) {
    assistant.streaming = false;
    if (!assistant.content) chatMessages.splice(assistantIndex, 1);
    renderMessages();
    toast(error.message);
    if (/API Key/.test(error.message)) go("settings");
  } finally { setBusy(button, false); }
});

async function streamChat(payload, onDelta, onAction = () => {}, retried = false) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accountAccessToken ? { Authorization: `Bearer ${accountAccessToken}` } : accessToken ? { "X-JobDeck-Token": accessToken } : {})
    },
    body: JSON.stringify(payload)
  });
  if (response.status === 401 && !retried && await refreshAccountSession()) {
    return streamChat(payload, onDelta, onAction, true);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  if (!response.body) throw new Error("浏览器不支持流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "delta" && event.delta) onDelta(event.delta);
      if (event.type === "action" && event.action) onAction(event.action);
      if (event.type === "error") streamError = event.error || "模型流式响应失败";
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    if (event.type === "delta" && event.delta) onDelta(event.delta);
    if (event.type === "action" && event.action) onAction(event.action);
    if (event.type === "error") streamError = event.error || "模型流式响应失败";
  }
  if (streamError) throw new Error(streamError);
}

function renderMessages() {
  $("#messages").innerHTML = chatMessages.map((message, index) => `
    <article class="message ${message.role} ${message.streaming ? "streaming" : ""}" data-message-index="${index}"><span>${message.role === "assistant" ? "AI" : "我"}</span><div class="message-body"><p>${escapeHtml(message.content || (message.streaming ? "正在连接模型…" : ""))}</p>${chatActionMarkup(message, index)}</div></article>`).join("");
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function chatActionMarkup(message, index) {
  if (!message?.action) return "";
  if (message.action.kind === "agent") {
    const agent = state?.workflow?.agent || {};
    const statusLabels = {
      planning: "正在规划下一步",
      executing: "正在执行工具",
      waiting: "正在等待并验证结果",
      complete: "目标已完成",
      stopped: "任务已停止",
      "needs-confirmation": "需要你确认",
      "needs-attention": "需要你处理"
    };
    const plan = (agent.plan || []).slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const steps = (agent.steps || []).slice(-6).reverse().map((step) => `<li class="${step.status || ""}"><b>${escapeHtml(step.label || step.tool || "执行动作")}</b>${step.result ? `<span>${escapeHtml(step.result)}</span>` : ""}</li>`).join("");
    const active = ["planning", "executing", "waiting"].includes(agent.status);
    const autopilot = state?.workflow?.autopilot || {};
    const jobProgress = agent.waitFor === "job-search" || String(autopilot.status || "").startsWith("running-")
      ? `<small>自动找工作：已验证沟通 ${autopilot.sent || 0}/${autopilot.targetApplications || 60} · 完整 JD ${autopilot.analyzed || 0} · 候选 ${autopilot.discovered || 0}</small>`
      : "";
    return `<div class="chat-task chat-agent" data-message-index="${index}">
      <div><strong>${escapeHtml(statusLabels[agent.status] || "求职 Agent")}</strong><span>${escapeHtml(agent.currentTool || "动态规划")}</span></div>
      <p class="chat-agent-goal">目标：${escapeHtml(agent.goal || "等待目标同步…")}</p>
      ${jobProgress}
      ${plan ? `<ol class="chat-agent-plan">${plan}</ol>` : ""}
      <p>${escapeHtml(agent.message || "正在观察当前状态…")}</p>
      ${steps ? `<ul class="chat-agent-steps">${steps}</ul>` : ""}
      ${active ? `<button class="secondary chat-agent-stop" data-stop-agent type="button">停止 Agent</button>` : ""}
    </div>`;
  }
  if (message.action.kind === "job-search") {
    const autopilot = state?.workflow?.autopilot || {};
    const target = autopilot.targetApplications || message.action.targetApplications || 60;
    const sent = autopilot.sent || 0;
    const progress = target > 0 ? Math.min(100, Math.round((sent / target) * 100)) : 0;
    const running = String(autopilot.status || "").startsWith("running-");
    const title = running ? "自动找工作运行中" : autopilot.status === "complete" ? "自动找工作已完成" : autopilot.stopRequested ? "正在安全停止" : "自动找工作任务";
    return `<div class="chat-task" data-message-index="${index}">
      <div><strong>${title}</strong><span>目标 ${sent}/${target}</span></div>
      <div class="chat-task-track"><i style="width:${progress}%"></i></div>
      <small>发现 ${autopilot.discovered || 0} · 已读完整 JD ${autopilot.analyzed || 0} · 匹配 ${autopilot.selected || 0}</small>
      <p>${escapeHtml(autopilot.message || "正在等待插件执行器更新进度…")}</p>
    </div>`;
  }
  if (message.action.kind === "resume-rewrite") {
    const apply = state?.workflow?.resumeApply || {};
    const running = ["preparing", "running"].includes(apply.status);
    return `<div class="chat-task" data-message-index="${index}">
      <div><strong>${running ? "自动修改简历运行中" : apply.status === "complete" ? "自动修改简历已完成" : "自动修改简历任务"}</strong></div>
      <small>已写入 ${apply.appliedFields?.length || 0} · 已验证 ${apply.verifiedFieldKeys?.length || 0} · 跳过 ${apply.skippedFields?.length || 0}</small>
      <p>${escapeHtml(apply.message || "正在等待插件执行器更新进度…")}</p>
    </div>`;
  }
  return "";
}

$("#messages").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-stop-agent]");
  if (!button) return;
  setBusy(button, true, "停止中…");
  try {
    await api("/api/agent/stop", { method: "POST" });
    toast("已请求安全停止 Agent");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
});

function refreshChatActionCards() {
  $$(".chat-task[data-message-index]").forEach((element) => {
    const index = Number.parseInt(element.dataset.messageIndex, 10);
    const message = chatMessages[index];
    if (!message?.action) return;
    element.outerHTML = chatActionMarkup(message, index);
  });
}

function updateStreamingMessage(index) {
  const message = chatMessages[index];
  const paragraph = $(`[data-message-index="${index}"] p`);
  if (paragraph) paragraph.textContent = message?.content || "正在连接模型…";
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

$("#saveResume").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true, "保存中…");
  try {
    await api("/api/candidate", { method: "PATCH", body: JSON.stringify({
      status: $("#candidateStatus").value.trim(), github: $("#candidateGithub").value.trim(),
      resumePath: $("#resumePath").value.trim(), resumeText: $("#resumeText").value
    }) });
    toast("候选人资料已保存");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { setBusy(event.currentTarget, false); }
});

$("#providerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#providerForm button[type='submit']");
  setBusy(button, true, "保存中…");
  try {
    await api("/api/provider", { method: "POST", body: JSON.stringify({
      mode: $("#providerMode").value, model: $("#providerModel").value.trim(),
      baseURL: $("#providerBaseURL").value.trim(), apiKey: $("#providerKey").value.trim()
    }) });
    $("#providerKey").value = "";
    toast("模型设置已保存");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
});

$("#targetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#targetForm button[type='submit']");
  setBusy(button, true, "保存中…");
  try {
    await api("/api/candidate", { method: "PATCH", body: JSON.stringify({
      targetRoles: $("#settingsRoles").value.split("\n").map((item) => item.trim()).filter(Boolean),
      locations: $("#settingsLocations").value.split("\n").map((item) => item.trim()).filter(Boolean),
      salaryFloorK: Number($("#salaryFloor").value), salaryUpperTargetK: Number($("#salaryUpper").value)
    }) });
    toast("求职目标已保存");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
});

$("#accountLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#accountLoginForm button[type='submit']");
  setBusy(button, true, "登录中…");
  try {
    const result = await accountApi("/api/account/login", {
      method: "POST",
      body: JSON.stringify({ email: $("#accountLoginEmail").value.trim(), password: $("#accountLoginPassword").value })
    });
    saveAccountSession(result);
    $("#accountLoginPassword").value = "";
    await loadAccountProfile();
    renderAccount();
    await refresh();
    toast("AI 账号已登录");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
});

$("#sendAccountCode").addEventListener("click", async (event) => {
  const email = $("#accountRegisterEmail").value.trim();
  if (!email) return toast("请先填写注册邮箱");
  setBusy(event.currentTarget, true, "发送中…");
  try {
    await accountApi("/api/account/send-code", { method: "POST", body: JSON.stringify({ email }) });
    toast("验证码已发送，请检查邮箱");
  } catch (error) { toast(error.message); }
  finally { setBusy(event.currentTarget, false); }
});

$("#accountRegisterForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#accountRegisterForm button[type='submit']");
  const email = $("#accountRegisterEmail").value.trim();
  const password = $("#accountRegisterPassword").value;
  setBusy(button, true, "注册中…");
  try {
    const result = await accountApi("/api/account/register", {
      method: "POST",
      body: JSON.stringify({ email, password, verifyCode: $("#accountVerifyCode").value.trim() })
    });
    saveAccountSession(result);
    if (!accountAccessToken) saveAccountSession(await accountApi("/api/account/login", { method: "POST", body: JSON.stringify({ email, password }) }));
    $("#accountRegisterPassword").value = "";
    $("#accountVerifyCode").value = "";
    await loadAccountProfile();
    renderAccount();
    await refresh();
    toast("注册成功，AI 账号已登录");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
});

$("#accountLogout").addEventListener("click", async (event) => {
  setBusy(event.currentTarget, true, "退出中…");
  try {
    await accountApi("/api/account/logout", { method: "POST", body: JSON.stringify({ refreshToken: accountRefreshToken }) });
  } catch { /* 本地会话仍需立即清除。 */ }
  clearAccountSession();
  if (accountConfig?.multiUser) {
    window.location.reload();
    return;
  }
  renderAccount();
  setBusy(event.currentTarget, false);
  toast("AI 账号已退出");
});

$("#claimStarScreenshot").addEventListener("click", async (event) => {
  const username = $("#rewardGithubUsername").value.trim();
  if (!username) return toast("请填写 GitHub 用户名");
  const screenshot = $("#rewardStarScreenshot").files?.[0];
  if (!screenshot) return toast("请上传 Star 截图");
  if (screenshot.size > 4 * 1024 * 1024) return toast("截图不能超过 4MB");
  setBusy(event.currentTarget, true, "正在核验…");
  try {
    const response = await fetch("/api/rewards/github-star/screenshot", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accountAccessToken}`,
        "Content-Type": screenshot.type,
        "X-GitHub-Username": username
      },
      body: screenshot
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "截图核验失败");
    $("#rewardStarScreenshot").value = "";
    await loadAccountProfile();
    renderAccount();
    toast(`已发放 $${result.amount} AI 额度`);
  } catch (error) { toast(error.message); }
  finally { setBusy(event.currentTarget, false); }
});

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidate = $("#accessToken").value.trim();
  if (!candidate) return;
  accessToken = candidate;
  sessionStorage.setItem(accessTokenKey, candidate);
  $("#authMessage").textContent = "正在验证…";
  try {
    await refresh();
    $("#accessToken").value = "";
  } catch {
    showAuthGate("访问令牌无效，请检查服务器部署配置");
  }
});

$("#authGoLogin").addEventListener("click", () => {
  hideAuthGate();
  go("settings");
  queueMicrotask(() => $("#accountLoginEmail")?.focus());
});

$("#copyExtensionToken").addEventListener("click", async () => {
  const token = state?.pairingToken;
  if (!token) return toast("工作区尚未加载，请稍后重试");
  await navigator.clipboard.writeText(token);
  toast("插件连接码已复制，请粘贴到扩展设置中");
});

initializeAccount().then(refresh);
setInterval(() => {
  if (!accountConfig?.multiUser || accountAccessToken) refresh();
}, 2500);
