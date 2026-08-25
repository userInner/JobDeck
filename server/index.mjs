import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { isJobSearchExecutionIntent, requestedApplicationTarget } from "./agent-intent.mjs";
import { GoalAgentRuntime } from "./agent-runtime.mjs";
import { AIService } from "./ai.mjs";
import { findPageControl, rankAnalyzedJobs, verificationReason } from "./autopilot.mjs";
import { CONTROLLED } from "./bridge.mjs";
import { bossResumeEvidence, hasCandidateEvidence } from "./candidate-evidence.mjs";
import { DEFAULT_HOST, DEFAULT_PORT } from "./defaults.mjs";
import { inferCompanyName, jobCandidatesFromPage, jobFromPage, mergeJobInput } from "./jobs.mjs";
import { buildResumeWritePlan } from "./resume-plan.mjs";
import { bossSearchUrl, buildBossExpectationPlans } from "./search-plan.mjs";
import { StarRewardError, StarRewardService } from "./star-rewards.mjs";
import { Sub2APIClient, Sub2APIError } from "./sub2api-client.mjs";
import { TenantRuntimeManager } from "./tenant-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
const server = http.createServer(app);
const sub2api = new Sub2APIClient();
const multiUserMode = String(process.env.JOBDECK_MULTI_USER || "").toLowerCase() === "true";
const tenantRuntime = new TenantRuntimeManager({
  directory: process.env.JOBDECK_DATA_DIR,
  sub2api,
  multiUser: multiUserMode
});
const store = tenantRuntime.store;
const bridge = tenantRuntime.bridge;
const ai = new AIService(store);
tenantRuntime.attach(server);
const starRewards = new StarRewardService({ sub2api });
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const remoteMode = multiUserMode || !loopbackHosts.has(DEFAULT_HOST);

if (!loopbackHosts.has(DEFAULT_HOST) && !multiUserMode) {
  const accessToken = String(process.env.JOBDECK_ACCESS_TOKEN || "").trim();
  if (accessToken.length < 24) throw new Error("公开监听单用户 JobDeck 时必须设置至少 24 个字符的 JOBDECK_ACCESS_TOKEN");
}

app.disable("x-powered-by");
if (remoteMode) app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

function accountToken(req) {
  const authorization = String(req.headers.authorization || "");
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
}

const rateBuckets = new Map();
function rateLimit(name, limit, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > limit) return res.status(429).json({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
    next();
  };
}

function accountError(res, error) {
  const expected = error instanceof Sub2APIError || error instanceof StarRewardError;
  const status = expected && Number.isInteger(error.status) ? error.status : 500;
  res.status(status).json({ error: expected ? error.message : "服务暂时不可用", code: expected ? error.code : "INTERNAL_ERROR" });
}

function sessionAccessToken(session) {
  return String(session?.access_token || session?.accessToken || "").trim();
}

async function prepareAccountSession(session) {
  const token = sessionAccessToken(session);
  if (token && multiUserMode) await tenantRuntime.fromAccessToken(token);
  return session;
}

// 账号接口在租户中间件之前；登录成功后，后续工作台 API 再由 Access Token 解析到独立租户。
app.get("/api/account/config", rateLimit("account-config", 60, 60_000), async (_req, res) => {
  try {
    const settings = await sub2api.publicSettings();
    res.json({
      enabled: true,
      siteName: settings.site_name || "OnPeople",
      registrationEnabled: settings.registration_enabled !== false,
      emailVerifyEnabled: Boolean(settings.email_verify_enabled),
      multiUser: multiUserMode,
      reward: { enabled: starRewards.enabled, amount: starRewards.amount, repository: starRewards.repository }
    });
  } catch (error) { accountError(res, error); }
});

app.post("/api/account/send-code", rateLimit("send-code", 3, 10 * 60_000), async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "请填写有效邮箱" });
    await sub2api.sendVerifyCode(email);
    res.json({ ok: true });
  } catch (error) { accountError(res, error); }
});

app.post("/api/account/register", rateLimit("register", 5, 30 * 60_000), async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const verifyCode = String(req.body?.verifyCode || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "请填写有效邮箱" });
    if (password.length < 6) return res.status(400).json({ error: "密码至少需要 6 个字符" });
    const data = await prepareAccountSession(await sub2api.register({ email, password, verify_code: verifyCode }));
    res.json(data);
  } catch (error) { accountError(res, error); }
});

app.post("/api/account/login", rateLimit("login", 12, 10 * 60_000), async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "请输入邮箱和密码" });
    res.json(await prepareAccountSession(await sub2api.login(email, password)));
  } catch (error) { accountError(res, error); }
});

app.post("/api/account/refresh", rateLimit("refresh", 30, 10 * 60_000), async (req, res) => {
  try { res.json(await prepareAccountSession(await sub2api.refresh(String(req.body?.refreshToken || "")))); }
  catch (error) { accountError(res, error); }
});

app.post("/api/account/logout", rateLimit("logout", 30, 10 * 60_000), async (req, res) => {
  try {
    const refreshToken = String(req.body?.refreshToken || "");
    tenantRuntime.invalidateAccessToken(accountToken(req));
    if (refreshToken) await sub2api.logout(refreshToken);
    res.json({ ok: true });
  } catch (error) { accountError(res, error); }
});

app.get("/api/account/me", rateLimit("account-me", 60, 60_000), async (req, res) => {
  try {
    const token = accountToken(req);
    const tenant = multiUserMode ? await tenantRuntime.fromAccessToken(token) : null;
    res.json(tenant?.profile || await sub2api.profile(token));
  }
  catch (error) { accountError(res, error); }
});

app.post("/api/rewards/github-star/challenge", rateLimit("star-challenge", 5, 60 * 60_000), async (req, res) => {
  try {
    if (!starRewards.enabled) return res.status(503).json({ error: "Star 奖励尚未启用", code: "REWARD_DISABLED" });
    res.json(await starRewards.createChallenge(accountToken(req), req.body?.username));
  } catch (error) { accountError(res, error); }
});

app.post("/api/rewards/github-star/claim", rateLimit("star-claim", 8, 60 * 60_000), async (req, res) => {
  try {
    if (!starRewards.enabled) return res.status(503).json({ error: "Star 奖励尚未启用", code: "REWARD_DISABLED" });
    res.json(await starRewards.claim(accountToken(req), { challengeId: req.body?.challengeId, gistUrl: req.body?.gistUrl }));
  } catch (error) { accountError(res, error); }
});

app.post("/api/rewards/github-star/screenshot", rateLimit("star-screenshot", 5, 60 * 60_000), express.raw({
  type: ["image/png", "image/jpeg", "image/webp"],
  limit: "4mb"
}), async (req, res) => {
  try {
    if (!starRewards.enabled) return res.status(503).json({ error: "Star 奖励尚未启用", code: "REWARD_DISABLED" });
    res.json(await starRewards.claimScreenshot(accountToken(req), {
      username: req.get("x-github-username"),
      screenshot: req.body
    }));
  } catch (error) { accountError(res, error); }
});

app.use("/api", (req, res, next) => {
  if (req.path === "/health") return next();
  tenantRuntime.middleware()(req, res, next);
});

function statePayload() {
  const state = store.publicState();
  return {
    ...state,
    extension: bridge.publicState(),
    pairingToken: store.secrets.extensionToken,
    pendingActions: state.actions.filter((item) => item.status === "waiting"),
    recentActions: state.actions.filter((item) => item.status !== "waiting").slice(0, 50)
  };
}

function setWorkflow(patch) {
  return store.update((state) => {
    state.workflow = {
      ...state.workflow,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    return state.workflow;
  });
}

function failWorkflow(error) {
  setWorkflow({ lastError: error.message });
  throw error;
}

function persistBossResumeEvidence(page) {
  const resumeText = bossResumeEvidence(page);
  if (resumeText.length < 300) {
    throw new Error("BOSS 在线简历没有读取到足够的工作、项目或技能内容，无法据此判断岗位匹配");
  }
  store.update((state) => {
    state.candidate.resumeText = resumeText;
  });
  return resumeText;
}

function resumeAuditActive(runId) {
  const workflow = store.state.workflow;
  return workflow.resumeAuditRunId === runId && workflow.resumeAuditStatus === "running";
}

async function waitForBossResume(runId, tabId, attempts = 20) {
  let lastPage;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!resumeAuditActive(runId)) throw new Error("在线简历审查已被新的流程替代");
    await sleep(attempt === 0 ? 900 : 700);
    lastPage = await bridge.execute({ kind: "inspect", tabId });
    const verification = verificationReason(lastPage);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    const sections = lastPage.boss?.resume?.sections || [];
    if (lastPage.adapter === "boss-zhipin" && lastPage.pageType === "resume" && (sections.length || String(lastPage.text || "").length > 600)) {
      return lastPage;
    }
  }
  if (lastPage?.pageType && lastPage.pageType !== "resume") {
    throw new Error("BOSS 没有停留在在线简历页，可能需要重新登录");
  }
  throw new Error("BOSS 在线简历加载超时，请确认登录状态后重试");
}

async function runAutomaticResumeAudit(runId, tabId) {
  try {
    const page = await waitForBossResume(runId, tabId);
    persistBossResumeEvidence(page);
    setWorkflow({ resumeAuditMessage: "在线简历已读取，正在进行 AI 审查…" });
    const audit = await ai.auditBossResume({ ...page.boss?.resume, text: page.text });
    if (!resumeAuditActive(runId)) return;
    setWorkflow({
      phase: "resume-review",
      resumeAuditStatus: "complete",
      resumeAuditMessage: "在线简历读取与 AI 审查已自动完成",
      resumeAudit: { ...audit, auditedAt: new Date().toISOString() },
      lastError: ""
    });
    store.addActivity(`首次流程：在线简历已自动审查（${audit.score} 分）`);
  } catch (error) {
    if (!resumeAuditActive(runId)) return;
    setWorkflow({
      phase: "resume-open",
      resumeAuditStatus: "needs-attention",
      resumeAuditMessage: error.message,
      lastError: error.message
    });
    store.addActivity(`在线简历自动审查暂停：${error.message}`, "error");
  }
}

function startAutomaticResumeAudit(tabId) {
  const runId = crypto.randomUUID();
  setWorkflow({
    phase: "resume-loading",
    resumeTabId: tabId,
    resumeAuditStatus: "running",
    resumeAuditMessage: "正在等待 BOSS 在线简历加载…",
    resumeAuditRunId: runId,
    lastError: ""
  });
  queueMicrotask(() => runAutomaticResumeAudit(runId, tabId));
  return runId;
}

function resumeOptimizationActive(runId) {
  const workflow = store.state.workflow;
  return workflow.resumeOptimizationRunId === runId && workflow.resumeOptimizationStatus === "running";
}

async function runResumeOptimization(runId, tabId) {
  try {
    const page = await bridge.execute({ kind: "inspect", tabId });
    if (page.adapter !== "boss-zhipin" || page.pageType !== "resume") {
      throw new Error("BOSS 在线简历标签已经失效，请重新打开简历后再生成优化稿");
    }
    persistBossResumeEvidence(page);
    setWorkflow({ resumeOptimizationMessage: "在线简历已读取，AI 正在生成字段级替换稿…" });
    const optimization = await ai.optimizeBossResume({ ...page.boss?.resume, text: page.text }, store.state.workflow.resumeAudit);
    if (!resumeOptimizationActive(runId)) return;
    setWorkflow({
      phase: "resume-review",
      resumeOptimizationStatus: "complete",
      resumeOptimizationMessage: "AI 简历优化稿已生成，等待你逐项确认",
      resumeOptimization: { ...optimization, generatedAt: new Date().toISOString() },
      lastError: ""
    });
    store.addActivity(`AI 简历优化稿已生成：${optimization.fields.length} 个字段`);
  } catch (error) {
    if (!resumeOptimizationActive(runId)) return;
    setWorkflow({
      phase: "resume-review",
      resumeOptimizationStatus: "needs-attention",
      resumeOptimizationMessage: error.message,
      lastError: error.message
    });
    store.addActivity(`AI 简历优化失败：${error.message}`, "error");
  }
}

async function runAutomaticResumeRewrite(runId, tabId) {
  try {
    const page = await waitForBossResume(runId, tabId);
    persistBossResumeEvidence(page);
    setWorkflow({ resumeAuditMessage: "在线简历已读取，正在进行 AI 审查…" });
    const audit = await ai.auditBossResume({ ...page.boss?.resume, text: page.text });
    if (!resumeAuditActive(runId)) return;
    setWorkflow({
      resumeAuditStatus: "complete",
      resumeAuditMessage: "在线简历读取与 AI 审查已完成",
      resumeAudit: { ...audit, auditedAt: new Date().toISOString() },
      resumeOptimizationMessage: "AI 正在生成可写入的优化稿…"
    });

    const optimization = await ai.optimizeBossResume({ ...page.boss?.resume, text: page.text }, audit);
    if (!resumeOptimizationActive(runId)) return;
    const generatedOptimization = { ...optimization, generatedAt: new Date().toISOString() };
    setWorkflow({
      resumeOptimizationStatus: "complete",
      resumeOptimizationMessage: "AI 优化稿已生成，准备使用 Computer Use 写入",
      resumeOptimization: generatedOptimization,
      phase: "resume-applying",
      lastError: ""
    });
    setResumeApply({
      status: "running",
      runId,
      message: "优化稿已生成，插件 Computer Use 正在准备写入…",
      appliedFields: [],
      skippedFields: [],
      verifiedFieldKeys: [],
      updatedFieldKeys: [],
      optimizationGeneratedAt: generatedOptimization.generatedAt,
      startedAt: new Date().toISOString(),
      completedAt: null
    });
    store.addActivity(`自动修改简历：审查完成（${audit.score} 分），开始 Computer Use 写入`);
    await runResumeApply(runId, tabId);
  } catch (error) {
    const stillPreparing = store.state.workflow.resumeAuditRunId === runId
      || store.state.workflow.resumeOptimizationRunId === runId;
    if (!stillPreparing) return;
    setWorkflow({
      phase: "resume-review",
      resumeAuditStatus: store.state.workflow.resumeAuditStatus === "running" ? "needs-attention" : store.state.workflow.resumeAuditStatus,
      resumeOptimizationStatus: store.state.workflow.resumeOptimizationStatus === "running" ? "needs-attention" : store.state.workflow.resumeOptimizationStatus,
      resumeAuditMessage: error.message,
      resumeOptimizationMessage: error.message,
      lastError: error.message
    });
    setResumeApply({ status: "needs-attention", runId, message: error.message, completedAt: new Date().toISOString() });
    store.addActivity(`自动修改简历暂停：${error.message}`, "error");
  }
}

function setResumeApply(patch) {
  return store.update((state) => {
    state.workflow.resumeApply = { ...state.workflow.resumeApply, ...patch };
    state.workflow.updatedAt = new Date().toISOString();
    return state.workflow.resumeApply;
  });
}

function resumeApplyActive(runId) {
  const apply = store.state.workflow.resumeApply;
  return apply.runId === runId && apply.status === "running";
}

function normalizedResumeText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function centerOf(item, label) {
  const bounds = item?.bounds;
  const point = item?.point || (bounds && bounds.width > 0 && bounds.height > 0 ? {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2)
  } : null);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${label}没有可用的 Computer Use 坐标，未执行修改`);
  }
  return point;
}

async function waitForResumeEditor(runId, tabId, sectionText, attempts = 10) {
  const expected = normalizedResumeText(sectionText).slice(0, 24);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!resumeApplyActive(runId)) throw new Error("在线简历写入已停止");
    await sleep(attempt === 0 ? 700 : 450);
    const page = await bridge.execute({ kind: "inspect", tabId });
    const textareas = (page.interactives || []).filter((item) => item.tag === "textarea" && !item.disabled);
    const matching = textareas.filter((item) => normalizedResumeText(item.valuePreview).includes(expected));
    if (matching.length === 1) return { page, editor: matching[0] };
    if (textareas.length === 1) return { page, editor: textareas[0] };
  }
  throw new Error("没有唯一识别到“个人优势”编辑框，未写入任何内容");
}

async function waitForResumeApplyPage(runId, tabId, attempts = 20) {
  let page;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!resumeApplyActive(runId)) throw new Error("在线简历写入已停止");
    await sleep(attempt === 0 ? 800 : 600);
    page = await bridge.execute({ kind: "inspect", tabId });
    const verification = verificationReason(page);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    if (page.adapter === "boss-zhipin" && page.pageType === "resume") return page;
  }
  if (page?.pageType && page.pageType !== "resume") throw new Error("已打开的 BOSS 标签不是在线简历页，请确认登录状态");
  throw new Error("BOSS 在线简历加载超时，请确认登录状态后重试");
}

async function waitForResumeSaved(runId, tabId, replacement, attempts = 12) {
  const expected = normalizedResumeText(replacement).slice(0, 32);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!resumeApplyActive(runId)) throw new Error("在线简历写入已停止");
    await sleep(attempt === 0 ? 800 : 500);
    const page = await bridge.execute({ kind: "inspect", tabId });
    if (normalizedResumeText(page.text).includes(expected)) return page;
  }
  throw new Error("保存后未能在在线简历中回读到新内容，请本人检查；系统不会继续修改其他字段");
}

function resumeSection(page, key) {
  const matches = (page.boss?.resume?.sectionDetails || []).filter((section) => section.key === key);
  if (matches.length !== 1 || matches[0].unique === false) throw new Error(`没有唯一识别到“${key}”简历区块`);
  return matches[0];
}

function resumeRecord(section, match) {
  const expected = normalizedResumeText(match);
  const records = section.recordDetails || [];
  // 项目正文可能顺带提到另一个项目名（例如 DSH 的描述里包含
  // “示例项目”）。优先按记录标题开头匹配，只有旧页面缺少标题结构时
  // 才退回全文包含，避免把两条记录误判为重复。
  const titleMatches = records.filter((record) => normalizedResumeText(record.text).startsWith(expected));
  const matches = titleMatches.length ? titleMatches : records.filter((record) => normalizedResumeText(record.text).includes(expected));
  if (matches.length !== 1 || matches[0].unique === false) throw new Error(`没有唯一识别到“${match}”记录`);
  return matches[0];
}

async function inspectResume(runId, tabId) {
  if (!resumeApplyActive(runId)) throw new Error("在线简历写入已停止");
  const page = await bridge.execute({ kind: "inspect", tabId });
  const verification = verificationReason(page);
  if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
  if (page.adapter !== "boss-zhipin" || page.pageType !== "resume") throw new Error("当前不是可识别的 BOSS 在线简历页");
  return page;
}

async function visibleInteractive(runId, tabId, control) {
  let page = await inspectResume(runId, tabId);
  let current = (page.interactives || []).find((item) => item.selector === control.selector) || control;
  const viewportHeight = Number(page.viewport?.height) || 800;
  if (!current.bounds || current.bounds.y < 12 || current.bounds.y + current.bounds.height > viewportHeight - 12) {
    await bridge.execute({ kind: "mouseMove", tabId, selector: current.selector, text: "将目标控件滚动到可见区域" });
    await sleep(220);
    page = await inspectResume(runId, tabId);
    current = (page.interactives || []).find((item) => item.selector === control.selector);
  }
  if (!current) throw new Error("编辑表单控件在滚动后失效，未继续写入");
  return { page, control: current };
}

async function computerReplace(runId, tabId, control, value, label) {
  if (normalizedResumeText(control.valuePreview) === normalizedResumeText(value)) return;
  const visible = await visibleInteractive(runId, tabId, control);
  const point = centerOf(visible.control, label);
  await bridge.execute({ kind: "computerClick", tabId, x: point.x, y: point.y, reason: `用户已批准：聚焦${label}` });
  try {
    await bridge.execute({ kind: "computerType", tabId, value, replace: true, reason: `用户已批准：填写${label}` });
  } catch (error) {
    if (!/当前没有聚焦可输入控件/.test(error.message)) throw error;
    // BOSS 的富文本容器有时会在真实鼠标点击后立即夺回焦点。继续限定在
    // 前一步已唯一识别的同一控件上写入，避免一次偶发失焦中断整批简历。
    await bridge.execute({
      kind: "type",
      tabId,
      selector: visible.control.selector,
      value,
      reason: `用户已批准：${label}在 Computer Use 点击后失焦，改为写入同一已识别控件`
    });
  }
}

function uniqueFormControl(page, predicate, label) {
  const matches = (page.interactives || []).filter((item) => !item.disabled && predicate(item));
  if (matches.length !== 1) throw new Error(`没有唯一识别到${label}`);
  return matches[0];
}

async function openRecordEditor(runId, tabId, sectionKey, match) {
  let page = await inspectResume(runId, tabId);
  let section = resumeSection(page, sectionKey);
  if (!Array.isArray(section.recordDetails)) throw new Error("Chrome 扩展版本过旧，请重新加载 JobDeck 扩展后再试");
  let record = resumeRecord(section, match);
  await bridge.execute({ kind: "mouseMove", tabId, selector: record.selector, text: `滚动到${match}` });
  page = await inspectResume(runId, tabId);
  record = resumeRecord(resumeSection(page, sectionKey), match);
  const point = centerOf(record, `${match}记录`);
  await bridge.execute({ kind: "computerMove", tabId, x: point.x, y: point.y, reason: `用户已批准：移动到${match}记录` });
  await sleep(180);
  page = await inspectResume(runId, tabId);
  record = resumeRecord(resumeSection(page, sectionKey), match);
  const editControls = (record.controls || []).filter((control) => control.visible && control.unique !== false && /编辑|修改|edit|modify/i.test(control.label));
  if (editControls.length !== 1) throw new Error(`没有看到唯一的“${match}”编辑按钮`);
  const editPoint = centerOf(editControls[0], `${match}编辑按钮`);
  await bridge.execute({ kind: "computerClick", tabId, x: editPoint.x, y: editPoint.y, reason: `用户已批准：打开${match}编辑表单` });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(attempt === 0 ? 650 : 350);
    page = await inspectResume(runId, tabId);
    const hasMatchingInput = (page.interactives || []).some((item) => ["input", "textarea"].includes(item.tag) && normalizedResumeText(item.valuePreview).includes(normalizedResumeText(match)));
    if (hasMatchingInput) return page;
  }
  throw new Error(`“${match}”编辑表单没有正常打开`);
}

async function saveResumeForm(runId, tabId, verificationText) {
  let page = await inspectResume(runId, tabId);
  const save = uniqueFormControl(page, (item) => item.tag === "button" && /^(完成|保存|确定|确认)$/.test(String(item.label || "").trim()), "保存按钮");
  const visible = await visibleInteractive(runId, tabId, save);
  const point = centerOf(visible.control, "保存按钮");
  await bridge.execute({ kind: "computerClick", tabId, x: point.x, y: point.y, reason: "用户已批准：保存当前简历字段" });
  return waitForResumeSaved(runId, tabId, verificationText);
}

async function applySimpleSection(runId, tabId, sectionKey, replacement, label) {
  let page = await inspectResume(runId, tabId);
  if (normalizedResumeText(page.text).includes(normalizedResumeText(replacement).slice(0, 80))) return false;
  let section = resumeSection(page, sectionKey);
  await bridge.execute({ kind: "mouseMove", tabId, selector: section.selector, text: `滚动到${label}` });
  page = await inspectResume(runId, tabId);
  section = resumeSection(page, sectionKey);
  const sectionPoint = centerOf(section, `${label}区块`);
  await bridge.execute({ kind: "computerMove", tabId, x: sectionPoint.x, y: sectionPoint.y, reason: `用户已批准：移动到${label}区块` });
  await sleep(180);
  page = await inspectResume(runId, tabId);
  section = resumeSection(page, sectionKey);
  const editControls = (section.controls || []).filter((control) => control.visible && control.unique !== false && /编辑|修改|edit|modify/i.test(control.label));
  if (editControls.length !== 1) throw new Error(`没有看到唯一的“${label}”编辑按钮`);
  const editPoint = centerOf(editControls[0], `${label}编辑按钮`);
  await bridge.execute({ kind: "computerClick", tabId, x: editPoint.x, y: editPoint.y, reason: `用户已批准：打开${label}编辑框` });
  const { editor } = await waitForResumeEditor(runId, tabId, section.text);
  await computerReplace(runId, tabId, editor, replacement, `${label}输入框`);
  await saveResumeForm(runId, tabId, replacement);
  return true;
}

async function applyWorkEntry(runId, tabId, entry) {
  let page = await inspectResume(runId, tabId);
  const record = resumeRecord(resumeSection(page, "workExperience"), entry.match);
  const expected = [entry.content, entry.achievements].filter(Boolean);
  if (expected.every((value) => normalizedResumeText(record.text).includes(normalizedResumeText(value)))) return false;
  page = await openRecordEditor(runId, tabId, "workExperience", entry.match);
  const content = uniqueFormControl(page, (item) => item.tag === "textarea" && /主要负责新员工入职培训/.test(item.selector), "工作内容输入框");
  await computerReplace(runId, tabId, content, entry.content, `${entry.match}工作内容`);
  if (entry.achievements) {
    page = await inspectResume(runId, tabId);
    const achievements = uniqueFormControl(page, (item) => item.tag === "textarea" && /工作业绩/.test(item.selector), "工作业绩输入框");
    await computerReplace(runId, tabId, achievements, entry.achievements, `${entry.match}工作业绩`);
  }
  await saveResumeForm(runId, tabId, entry.achievements || entry.content);
  return true;
}

async function applyProjectEntry(runId, tabId, entry) {
  let page = await inspectResume(runId, tabId);
  const record = resumeRecord(resumeSection(page, "projectExperience"), entry.match);
  const expected = [entry.role, entry.description, entry.achievements].filter(Boolean);
  if (expected.every((value) => normalizedResumeText(record.text).includes(normalizedResumeText(value)))) return false;
  page = await openRecordEditor(runId, tabId, "projectExperience", entry.match);
  if (entry.role) {
    const role = uniqueFormControl(page, (item) => item.tag === "input" && /UI 设计师/.test(item.selector), "项目角色输入框");
    await computerReplace(runId, tabId, role, entry.role, `${entry.match}项目角色`);
  }
  if (entry.description) {
    page = await inspectResume(runId, tabId);
    const description = uniqueFormControl(page, (item) => item.tag === "textarea" && /描述该项目/.test(item.selector), "项目描述输入框");
    await computerReplace(runId, tabId, description, entry.description, `${entry.match}项目描述`);
  }
  if (entry.achievements) {
    page = await inspectResume(runId, tabId);
    const achievements = uniqueFormControl(page, (item) => item.tag === "textarea" && /请填写内容/.test(item.selector), "项目业绩输入框");
    await computerReplace(runId, tabId, achievements, entry.achievements, `${entry.match}项目业绩`);
  }
  await saveResumeForm(runId, tabId, entry.achievements || entry.description || entry.role);
  return true;
}

async function applySkills(runId, tabId, skillPlan) {
  let page = await inspectResume(runId, tabId);
  const section = resumeSection(page, "skills");
  if (skillPlan.appendLines.every((line) => normalizedResumeText(section.text).includes(normalizedResumeText(line)))) return false;
  let currentSection = section;
  await bridge.execute({ kind: "mouseMove", tabId, selector: currentSection.selector, text: "滚动到专业技能" });
  page = await inspectResume(runId, tabId);
  currentSection = resumeSection(page, "skills");
  const sectionPoint = centerOf(currentSection, "专业技能区块");
  await bridge.execute({ kind: "computerMove", tabId, x: sectionPoint.x, y: sectionPoint.y, reason: "用户已批准：移动到专业技能区块" });
  await sleep(180);
  page = await inspectResume(runId, tabId);
  currentSection = resumeSection(page, "skills");
  const editControls = (currentSection.controls || []).filter((control) => control.visible && control.unique !== false && /编辑|修改|edit|modify/i.test(control.label));
  if (editControls.length !== 1) throw new Error("没有看到唯一的专业技能编辑按钮");
  const editPoint = centerOf(editControls[0], "专业技能编辑按钮");
  await bridge.execute({ kind: "computerClick", tabId, x: editPoint.x, y: editPoint.y, reason: "用户已批准：打开专业技能编辑框" });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(attempt === 0 ? 650 : 350);
    page = await inspectResume(runId, tabId);
    const editors = (page.interactives || []).filter((item) => item.tag === "textarea" && /参考技能词/.test(item.selector));
    if (editors.length === 1) {
      const replacement = [String(editors[0].valuePreview || "").trim(), ...skillPlan.appendLines].filter(Boolean).join("\n");
      await computerReplace(runId, tabId, editors[0], replacement, "专业技能输入框");
      await saveResumeForm(runId, tabId, skillPlan.appendLines[0]);
      return true;
    }
  }
  throw new Error("专业技能编辑框没有正常打开");
}

async function runResumeApply(runId, tabId) {
  const optimization = store.state.workflow.resumeOptimization;
  const plan = buildResumeWritePlan(optimization, store.state.candidate);
  const appliedFields = [];
  const skippedFields = [...plan.requiresConfirmation];
  const verifiedFieldKeys = [];
  const updatedFieldKeys = [];
  const markVerified = (key, changed = false) => {
    if (!verifiedFieldKeys.includes(key)) verifiedFieldKeys.push(key);
    if (changed && !updatedFieldKeys.includes(key)) updatedFieldKeys.push(key);
  };
  try {
    if (!plan.personalAdvantage && !plan.workExperience.length && !plan.projectExperience.length && !plan.skills) {
      throw new Error("当前优化稿没有可安全自动写入的字段");
    }
    await bridge.execute({ kind: "activateTab", tabId });
    setResumeApply({ message: "BOSS 在线简历已打开，正在等待页面加载…" });
    await waitForResumeApplyPage(runId, tabId);
    const updateProgress = (message) => setResumeApply({ message, appliedFields: [...appliedFields], skippedFields: [...skippedFields] });

    if (plan.personalAdvantage) {
      updateProgress("正在检查并写入个人优势…");
      const changed = await applySimpleSection(runId, tabId, "personalAdvantage", plan.personalAdvantage.replacement, "个人优势");
      if (changed) appliedFields.push("个人优势");
      markVerified("personalAdvantage", changed);
    }

    let workChanged = false;
    for (const entry of plan.workExperience) {
      updateProgress(`正在处理工作经历：${entry.match}…`);
      if (await applyWorkEntry(runId, tabId, entry)) {
        appliedFields.push(`工作经历 · ${entry.match}`);
        workChanged = true;
      }
    }
    if (plan.workExperience.length) markVerified("workExperience", workChanged);

    const projectChanges = new Set();
    const projectSources = new Set();
    for (const entry of plan.projectExperience) {
      updateProgress(`正在处理项目经历：${entry.match}…`);
      projectSources.add(entry.sourceKey || "projectExperience");
      if (await applyProjectEntry(runId, tabId, entry)) {
        appliedFields.push(`项目经历 · ${entry.match}`);
        projectChanges.add(entry.sourceKey || "projectExperience");
      }
    }
    for (const sourceKey of projectSources) markVerified(sourceKey, projectChanges.has(sourceKey));

    if (plan.skills) {
      updateProgress("正在补充专业技能中的 Telegram Bot 经历…");
      const changed = await applySkills(runId, tabId, plan.skills);
      if (changed) appliedFields.push("专业技能 · Telegram Bot");
      markVerified("skills", changed);
    }

    if (!appliedFields.length) {
      const message = `所有可安全写入的正文已经是最新内容；${skippedFields.length} 类结构化信息未自动修改`;
      setResumeApply({
        status: "complete",
        message,
        appliedFields,
        skippedFields,
        verifiedFieldKeys,
        updatedFieldKeys,
        optimizationGeneratedAt: optimization?.generatedAt || null,
        completedAt: new Date().toISOString()
      });
      setWorkflow({ phase: "resume-review", lastError: "" });
      store.addActivity("BOSS 在线简历无需重复修改：内容已是最新版本");
      await bridge.execute({ kind: "computerNotice", tabId, text: `JobDeck：${message}` }).catch(() => {});
      return;
    }

    const savedPage = await inspectResume(runId, tabId);
    let updatedAudit;
    let auditNote = "";
    try {
      setResumeApply({ message: "修改已保存，正在重新审查在线简历…" });
      updatedAudit = await ai.auditBossResume({ ...savedPage.boss?.resume, text: savedPage.text });
    } catch (error) {
      auditNote = `；重新评分未完成：${error.message}`;
    }
    if (!resumeApplyActive(runId)) return;
    if (updatedAudit) {
      setWorkflow({ resumeAudit: { ...updatedAudit, auditedAt: new Date().toISOString() }, lastError: "" });
    }
    setResumeApply({
      status: "complete",
      message: `${appliedFields.length ? `已写入并验证 ${appliedFields.length} 个正文内容` : "所有可安全写入的正文已经是最新内容"}；${skippedFields.length} 类结构化信息未自动修改${auditNote}`,
      appliedFields,
      skippedFields,
      verifiedFieldKeys,
      updatedFieldKeys,
      optimizationGeneratedAt: optimization?.generatedAt || null,
      completedAt: new Date().toISOString()
    });
    setWorkflow({ phase: "resume-review", lastError: "" });
    store.addActivity(`BOSS 在线简历批量修改完成：${appliedFields.length} 项已写入并验证`);
    await bridge.execute({
      kind: "computerNotice",
      tabId,
      text: `JobDeck 已完成：${appliedFields.length} 项简历内容已写入并验证`
    }).catch(() => {});
  } catch (error) {
    if (!resumeApplyActive(runId)) return;
    setResumeApply({
      status: "needs-attention",
      message: error.message,
      appliedFields,
      skippedFields,
      verifiedFieldKeys,
      updatedFieldKeys,
      optimizationGeneratedAt: optimization?.generatedAt || null,
      completedAt: new Date().toISOString()
    });
    setWorkflow({ phase: "resume-review", lastError: error.message });
    store.addActivity(`BOSS 在线简历自动写入暂停：${error.message}`, "error");
  }
}

function sameJobUrl(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.hostname === b.hostname && a.pathname === b.pathname;
  } catch {
    return left === right;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const DEFAULT_AUTO_APPLY_TARGET = 60;

function automaticApplicationTarget(value) {
  const requested = Number.parseInt(value, 10);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(500, Math.max(1, requested))
    : DEFAULT_AUTO_APPLY_TARGET;
}

function setAutopilot(patch) {
  return store.update((state) => {
    state.workflow.autopilot = {
      ...state.workflow.autopilot,
      ...patch
    };
    state.workflow.updatedAt = new Date().toISOString();
    return state.workflow.autopilot;
  });
}

function autopilotActive(runId) {
  const current = store.state.workflow.autopilot;
  return current.runId === runId && String(current.status).startsWith("running-") && !current.stopRequested;
}

async function waitForBossPage(runId, predicate, description, attempts = 14, tabId = null) {
  let lastPage = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    await sleep(attempt === 0 ? 900 : 700);
    lastPage = await bridge.execute({ kind: "inspect", ...(tabId ? { tabId } : {}) });
    // A newly opened or reloaded BOSS tab can briefly return no inspection
    // result while the content script is being attached. Treat that as a
    // transient loading state instead of dereferencing it and stopping the run.
    if (!lastPage) continue;
    const verification = verificationReason(lastPage);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    if (predicate(lastPage)) return lastPage;
  }
  if (!lastPage) {
    throw new Error(`未能读取${description}。请保持 BOSS 页面加载完成，并确认扩展侧边栏当前站点已授权后重试`);
  }
  // A normal page transition timeout belongs to the current candidate. Do
  // not describe it as a stopped run: callers distinguish explicit user or
  // security stops from recoverable per-job failures by their error text.
  throw new Error(`${description}加载超时`);
}

function isBossTabUrl(value) {
  try {
    return /(^|\.)zhipin\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function bossTabPageHint(value) {
  try {
    const pathname = new URL(value).pathname;
    if (/\/web\/geek\/chat|\/web\/chat/.test(pathname)) return "chat";
    if (/\/web\/geek\/jobs|\/c\d+/.test(pathname)) return "job-list";
    if (/\/job_detail\//.test(pathname)) return "job-detail";
  } catch {
    // The live inspection below remains the source of truth.
  }
  return "other";
}

async function inspectBossPageFollowingTabs(tabId, preferredPageTypes = []) {
  const tabs = await bridge.execute({ kind: "listTabs" });
  const bossTabs = tabs.filter((tab) => tab.id && isBossTabUrl(tab.url));
  const preferred = new Set(preferredPageTypes);
  const ordered = [...bossTabs].sort((left, right) => {
    const leftPreferred = preferred.has(bossTabPageHint(left.url)) ? 1 : 0;
    const rightPreferred = preferred.has(bossTabPageHint(right.url)) ? 1 : 0;
    const leftActive = left.active ? 1 : 0;
    const rightActive = right.active ? 1 : 0;
    const leftOriginal = left.id === tabId ? 1 : 0;
    const rightOriginal = right.id === tabId ? 1 : 0;
    return rightPreferred - leftPreferred || rightActive - leftActive || rightOriginal - leftOriginal;
  });

  let fallback = null;
  let lastError = null;
  for (const tab of ordered) {
    try {
      const page = await bridge.execute({ kind: "inspect", tabId: tab.id });
      if (page?.adapter !== "boss-zhipin") continue;
      const result = { page, tabId: tab.id };
      if (preferred.has(page.pageType)) {
        if (!tab.active) await bridge.execute({ kind: "activateTab", tabId: tab.id });
        return result;
      }
      if (!fallback || tab.id === tabId || tab.active) fallback = result;
    } catch (error) {
      lastError = error;
    }
  }
  if (fallback) return fallback;
  if (lastError) throw lastError;
  throw new Error("没有可用的 BOSS 标签页，可能已被页面跳转关闭");
}

async function waitForBossPageFollowingTabs(runId, predicate, description, attempts, tabId, preferredPageTypes = []) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    await sleep(attempt === 0 ? 700 : 550);
    try {
      lastResult = await inspectBossPageFollowingTabs(tabId, preferredPageTypes);
      tabId = lastResult.tabId;
      const verification = verificationReason(lastResult.page);
      if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
      if (predicate(lastResult.page)) return lastResult;
    } catch (error) {
      lastError = error;
      if (fatalAutopilotError(error)) throw error;
    }
  }
  if (lastError && !lastResult) throw lastError;
  throw new Error(`${description}加载超时`);
}

function bossSearchInput(page) {
  const candidates = (page?.interactives || []).filter((item) => item.tag === "input" && !item.disabled);
  return candidates.find((item) => /搜索职位|搜索.*公司|职位.*公司/i.test(`${item.label || ""} ${item.selector || ""}`))
    || candidates.find((item) => /search/i.test(`${item.type || ""} ${item.selector || ""}`))
    || (candidates.filter((item) => !/password|hidden/i.test(item.type || "")).length === 1
      ? candidates.find((item) => !/password|hidden/i.test(item.type || ""))
      : null);
}

function bossSearchButton(page) {
  return findPageControl(page, /^搜索$/i, ["button", "a"]);
}

function bossLocationChoice(page, label, current = null) {
  return (page?.boss?.locationOptions || [])
    .filter((item) => item.label === label && item.point)
    .filter((item) => !current?.point || item.point.x !== current.point.x || item.point.y !== current.point.y)
    .filter((item) => !/company|boss-info|job-card|job-list/i.test(item.hint || ""))
    .sort((left, right) => {
      const leftHint = /dialog|popup|menu|city|location|area/i.test(left.hint || "") ? 1 : 0;
      const rightHint = /dialog|popup|menu|city|location|area/i.test(right.hint || "") ? 1 : 0;
      const leftOverlay = current?.point && left.point.x > current.point.x + 300 ? 1 : 0;
      const rightOverlay = current?.point && right.point.x > current.point.x + 300 ? 1 : 0;
      return rightHint - leftHint || rightOverlay - leftOverlay || (left.bounds?.width || 9999) - (right.bounds?.width || 9999);
    })[0] || null;
}

async function exposeBossListHeader(runId, tabId, page, attempts = 7) {
  let current = page;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    if (current?.boss?.expectationOptions?.length) return current;
    const viewport = current?.viewport || { width: 1400, height: 800 };
    await bridge.execute({
      kind: "computerScroll",
      tabId,
      x: Math.round(viewport.width * 0.22),
      y: Math.max(140, Math.round(viewport.height * 0.32)),
      amount: 1200,
      direction: "up",
      reason: "自动找工作：回到职位列表顶部，核对 BOSS 求职期望"
    });
    await sleep(350);
    current = await bridge.execute({ kind: "inspect", tabId }).catch(() => null);
  }
  return current || page;
}

async function waitForStableBossLocation(runId, tabId, desired, attempts = 14, requiredStableSamples = 3) {
  let stableSamples = 0;
  let lastPage = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    await sleep(attempt === 0 ? 700 : 550);
    lastPage = await bridge.execute({ kind: "inspect", tabId }).catch(() => null);
    const verification = verificationReason(lastPage);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    const matches = lastPage?.adapter === "boss-zhipin"
      && lastPage?.pageType === "job-list"
      && lastPage?.boss?.locationFilter?.label === desired
      && Boolean(lastPage?.boss?.jobCards?.length);
    stableSamples = matches ? stableSamples + 1 : 0;
    if (stableSamples >= requiredStableSamples) return lastPage;
  }
  throw new Error(`期望城市 ${desired} 未能保持稳定，BOSS 页面可能已回退到账号所在地`);
}

function savedBossExpectation(page, expectationLabel = "") {
  const options = (page?.boss?.expectationOptions || []).filter((item) => item.point && item.label);
  if (!options.length) return null;
  const exact = options.find((item) => item.label === expectationLabel);
  if (expectationLabel) return exact || null;
  return options.find((item) => item.selected) || options[0];
}

function expectedBossLocation(expectation) {
  const location = String(expectation?.location || "").trim();
  return location === "远程" ? "全国" : location;
}

function bossExpectationContextMatches(page, expectationLabel, desiredLocation) {
  const active = page?.boss?.activeExpectation;
  const visibleLocation = String(page?.boss?.locationFilter?.label || "").trim();
  return page?.adapter === "boss-zhipin"
    && page?.pageType === "job-list"
    && Boolean(page?.boss?.jobCards?.length)
    && active?.label === expectationLabel
    && (!desiredLocation || visibleLocation === desiredLocation);
}

async function waitForStableBossExpectation(runId, tabId, expectationLabel, desiredLocation, attempts = 16, requiredStableSamples = 3) {
  let stableSamples = 0;
  let lastPage = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    await sleep(attempt === 0 ? 800 : 550);
    lastPage = await bridge.execute({ kind: "inspect", tabId }).catch(() => null);
    const verification = verificationReason(lastPage);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    const matches = bossExpectationContextMatches(lastPage, expectationLabel, desiredLocation);
    stableSamples = matches ? stableSamples + 1 : 0;
    if (stableSamples >= requiredStableSamples) return lastPage;
  }
  const actualExpectation = lastPage?.boss?.activeExpectation?.label || "未识别";
  const actualLocation = lastPage?.boss?.locationFilter?.label || "未识别";
  throw new Error(`BOSS 求职期望未能稳定恢复：需要 ${expectationLabel} / ${desiredLocation || "任意城市"}，当前 ${actualExpectation} / ${actualLocation}`);
}

async function selectSavedBossExpectation(runId, tabId, page, expectationLabel = "", { force = false } = {}) {
  page = await exposeBossListHeader(runId, tabId, page);
  const expectation = savedBossExpectation(page, expectationLabel);
  if (!expectation) {
    throw new Error("没有识别到 BOSS 顶部已保存的求职期望。请先在 BOSS 添加包含岗位和城市的求职期望，再启动自动找工作");
  }
  const desiredLocation = expectedBossLocation(expectation);
  if (!force && bossExpectationContextMatches(page, expectation.label, desiredLocation)) {
    return { page, expectation };
  }
  const point = centerOf(expectation, `求职期望 ${expectation.label}`);
  setAutopilot({ message: `Computer Use 正在${force ? "重新" : ""}选择 BOSS 求职期望：${expectation.label}，并核对城市 ${desiredLocation}` });
  await bridge.execute({ kind: "computerMove", tabId, x: point.x, y: point.y, reason: `自动找工作：移动到求职期望 ${expectation.label}` });
  await sleep(160);
  await bridge.execute({ kind: "computerClick", tabId, x: point.x, y: point.y, reason: `自动找工作：${force ? "重新" : ""}选择求职期望 ${expectation.label}` });

  let nextPage = await waitForStableBossExpectation(runId, tabId, expectation.label, desiredLocation);
  nextPage = await exposeBossListHeader(runId, tabId, nextPage);
  return { page: nextPage, expectation };
}

async function selectExpectedBossLocation(runId, tabId, page, location) {
  const desired = location === "远程" ? "全国" : location;
  page = await exposeBossListHeader(runId, tabId, page);
  let current = page?.boss?.locationFilter;
  if (current?.label === desired) return waitForStableBossLocation(runId, tabId, desired);

  let lastError = null;
  for (let round = 0; round < 3; round += 1) {
    page = await exposeBossListHeader(runId, tabId, page);
    current = page?.boss?.locationFilter;
    if (!current?.point) throw new Error(`没有识别到 BOSS 地点筛选器，无法选择期望城市 ${desired}`);

    const currentPoint = centerOf(current, "地点筛选器");
    await bridge.execute({ kind: "computerMove", tabId, x: currentPoint.x, y: currentPoint.y, reason: `自动找工作：移动到当前城市 ${current.label}` });
    await bridge.execute({ kind: "computerClick", tabId, x: currentPoint.x, y: currentPoint.y, reason: `自动找工作：打开地点筛选，准备选择 ${desired}` });

    let choice = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!autopilotActive(runId)) throw new Error("托管投递已停止");
      await sleep(attempt === 0 ? 450 : 300);
      const opened = await bridge.execute({ kind: "inspect", tabId });
      choice = bossLocationChoice(opened, desired, current);
      if (choice) break;
    }
    if (!choice) {
      lastError = new Error(`地点面板中没有识别到期望城市 ${desired}`);
      continue;
    }

    const choicePoint = centerOf(choice, `期望城市 ${desired}`);
    await bridge.execute({ kind: "computerMove", tabId, x: choicePoint.x, y: choicePoint.y, reason: `自动找工作：移动到期望城市 ${desired}` });
    await bridge.execute({ kind: "computerClick", tabId, x: choicePoint.x, y: choicePoint.y, reason: `自动找工作：选择期望城市 ${desired}` });
    try {
      return await waitForStableBossLocation(runId, tabId, desired);
    } catch (error) {
      if (fatalAutopilotError(error)) throw error;
      lastError = error;
      page = await bridge.execute({ kind: "inspect", tabId }).catch(() => page);
      setAutopilot({ message: `BOSS 城市发生回退，Computer Use 正在重新选择 ${desired}（${round + 2}/3）` });
    }
  }
  throw lastError || new Error(`期望城市 ${desired} 选择失败`);
}

function bossJobCard(page, candidate) {
  const cards = page?.boss?.jobCards || [];
  const exact = cards.find((card) => sameJobUrl(card.url, candidate.url));
  if (exact) return exact;
  const expectedTitle = normalizedResumeText(candidate.title);
  const expectedCompany = normalizedResumeText(candidate.company);
  return cards.find((card) => {
    const title = normalizedResumeText(card.title);
    const company = normalizedResumeText(card.company);
    return expectedTitle && (title.includes(expectedTitle) || expectedTitle.includes(title))
      && (!expectedCompany || company.includes(expectedCompany) || expectedCompany.includes(company));
  });
}

async function waitForBossList(runId, tabId, description, attempts = 20) {
  return waitForBossPage(
    runId,
    (page) => page?.adapter === "boss-zhipin" && page?.pageType === "job-list" && (page?.boss?.jobCards || []).length > 0,
    description,
    attempts,
    tabId
  );
}

async function restoreBossListAfterContact(runId, tabId, job) {
  let current = await inspectBossPageFollowingTabs(tabId, ["job-list"]).catch(() => null);
  let page = current?.page || null;
  tabId = current?.tabId || tabId;
  if (page?.adapter === "boss-zhipin" && page?.pageType === "job-list") return { page, tabId };

  setAutopilot({ message: `已联系 ${job.company}，Computer Use 正在返回职位列表` });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    const returnControl = [
      /^返回职位列表$/i,
      /^返回岗位列表$/i,
      /^查看职位$/i,
      /^职位$/i
    ].map((pattern) => findPageControl(page, pattern, ["button", "a"])).find(Boolean);
    if (returnControl) {
      const point = centerOf(returnControl, returnControl.label || "返回职位列表");
      await bridge.execute({ kind: "computerMove", tabId, x: point.x, y: point.y, reason: "自动找工作：移动到返回职位列表控件" });
      await bridge.execute({ kind: "computerClick", tabId, x: point.x, y: point.y, reason: "自动找工作：返回职位列表" });
    } else {
      await bridge.execute({ kind: "computerBack", tabId, reason: "自动找工作：通过浏览器历史返回职位列表" });
    }
    await sleep(900);
    current = await inspectBossPageFollowingTabs(tabId, ["job-list"]).catch(() => null);
    page = current?.page || null;
    tabId = current?.tabId || tabId;
    const verification = verificationReason(page);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    if (page?.adapter === "boss-zhipin" && page?.pageType === "job-list") return { page, tabId };
  }
  throw new Error(`${job.company} / ${job.title} 已完成沟通，但 Computer Use 连续尝试后仍无法返回职位列表`);
}

function pageJobUrls(page) {
  return jobCandidatesFromPage(page).map((candidate) => candidate.url).filter(Boolean);
}

async function advanceBossJobResults(runId, tabId, seenUrls) {
  let page = await bridge.execute({ kind: "inspect", tabId }).catch(() => null);
  if (!page) page = await waitForBossList(runId, tabId, "BOSS 职位列表", 8);
  if (page?.pageType !== "job-list") return null;

  const hasNewJob = (value) => pageJobUrls(value).some((url) => !seenUrls.has(url));
  if (hasNewJob(page)) return page;

  let unchanged = 0;
  let previousFingerprint = pageJobUrls(page).join("|");
  while (unchanged < 3) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    const cards = page?.boss?.jobCards || [];
    const anchor = cards.find((card) => card.bounds)?.bounds;
    const viewport = page.viewport || { width: 1400, height: 800 };
    await bridge.execute({
      kind: "computerScroll",
      tabId,
      x: anchor ? Math.max(60, Math.min(viewport.width - 60, anchor.x + Math.min(anchor.width / 2, 180))) : Math.round(viewport.width * 0.22),
      y: anchor ? Math.max(120, Math.min(viewport.height - 120, anchor.y + anchor.height / 2)) : Math.round(viewport.height * 0.72),
      amount: 720,
      direction: "down",
      reason: "自动找工作：继续浏览当前搜索结果"
    });
    await sleep(700);
    page = await bridge.execute({ kind: "inspect", tabId }).catch(() => null);
    if (!page) continue;
    const verification = verificationReason(page);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    if (hasNewJob(page)) return page;
    const fingerprint = pageJobUrls(page).join("|");
    unchanged = fingerprint === previousFingerprint ? unchanged + 1 : 0;
    previousFingerprint = fingerprint;
  }

  const next = findPageControl(page, /^(?:下一页|下页|Next|›|»)$/i, ["button", "a"]);
  if (!next || next.disabled) return null;
  const point = centerOf(next, "下一页");
  await bridge.execute({ kind: "computerMove", tabId, x: point.x, y: point.y, reason: "自动找工作：移动到下一页" });
  await bridge.execute({ kind: "computerClick", tabId, x: point.x, y: point.y, reason: "自动找工作：打开下一页搜索结果" });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(attempt === 0 ? 900 : 500);
    page = await bridge.execute({ kind: "inspect", tabId }).catch(() => null);
    if (page?.pageType === "job-list" && hasNewJob(page)) return page;
  }
  return null;
}

async function openBossJobList({ expectationLabel = "", tabId = null, runId = null, attempts = 20, forceExpectation = false } = {}) {
  if (runId && !autopilotActive(runId)) throw new Error("托管投递已停止");
  let tab = Number.isInteger(tabId) && tabId > 0 ? { id: tabId } : null;
  let page;
  if (tab) {
    page = await bridge.execute({ kind: "inspect", tabId: tab.id }).catch(() => null);
  }
  if (!tab || page?.adapter !== "boss-zhipin" || page?.pageType !== "job-list") {
    tab = await bridge.execute({ kind: "openBossJobs" });
    page = await waitForBossList(runId, tab.id, "BOSS 职位列表", attempts);
  }
  const selected = await selectSavedBossExpectation(runId, tab.id, page, expectationLabel, { force: forceExpectation });
  page = selected.page;
  return {
    page,
    tabId: tab.id,
    expectation: selected.expectation,
    effectiveLocation: selected.expectation.location,
    feedKey: selected.expectation.label
  };
}

async function selectBossJobCard(runId, tabId, candidate) {
  let page = await bridge.execute({ kind: "inspect", tabId });
  if (!page) page = await waitForBossList(runId, tabId, "BOSS 职位列表", 8);
  if (page?.adapter !== "boss-zhipin" || page?.pageType !== "job-list") throw new Error("BOSS 已离开职位列表，未继续操作");
  let card = bossJobCard(page, candidate);
  if (!card) throw new Error(`${candidate.company} / ${candidate.title}：当前列表未找到对应岗位卡片`);
  const viewport = page.viewport || { width: 1400, height: 800 };
  for (let attempt = 0; attempt < 6 && card?.bounds && (card.bounds.y < 8 || card.bounds.y + card.bounds.height > viewport.height - 8); attempt += 1) {
    const direction = card.bounds.y < 8 ? "up" : "down";
    await bridge.execute({
      kind: "computerScroll",
      tabId,
      x: Math.max(40, Math.min(viewport.width - 40, card.bounds.x + Math.min(card.bounds.width / 2, 180))),
      y: Math.max(80, Math.min(viewport.height - 80, direction === "up" ? 180 : viewport.height - 180)),
      amount: 520,
      direction,
      reason: `自动找工作：滚动到 ${candidate.title}`
    });
    await sleep(500);
    page = await bridge.execute({ kind: "inspect", tabId });
    if (!page) page = await waitForBossList(runId, tabId, "滚动后的 BOSS 职位列表", 8);
    card = bossJobCard(page, candidate);
  }
  if (!card) throw new Error(`${candidate.company} / ${candidate.title}：滚动后岗位卡片失效`);
  const beforeFingerprint = bossJobDetailFingerprint(page);
  let lastPage = page;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    if (attempt === 0 || attempt === 6 || attempt === 12) {
      card = bossJobCard(lastPage, candidate) || bossJobCard(page, candidate);
      if (!card) throw new Error(`${candidate.company} / ${candidate.title}：重试时岗位卡片已不在当前列表`);
      const point = centerOf(card, `${candidate.title}岗位卡片`);
      setAutopilot({ message: `正在${attempt ? "重新" : ""}打开 ${candidate.company} / ${candidate.title} 的完整 JD` });
      await bridge.execute({ kind: "computerMove", tabId, x: point.x, y: point.y, reason: `自动找工作：移动到 ${candidate.title}` });
      await sleep(180);
      await bridge.execute({ kind: "computerClick", tabId, x: point.x, y: point.y, reason: `自动找工作：查看 ${candidate.title}` });
    }
    await sleep(attempt === 0 ? 900 : 650);
    lastPage = await bridge.execute({ kind: "inspect", tabId }).catch(() => null);
    if (!lastPage) continue;
    const verification = verificationReason(lastPage);
    if (verification) throw new Error(`BOSS 页面需要本人处理：${verification}`);
    if (bossJobDetailMatches(lastPage, candidate, beforeFingerprint)) return lastPage;
  }
  throw new Error(`${candidate.title}右侧职位详情加载超时`);
}

function bossJobDetailFingerprint(page) {
  const job = page?.boss?.job;
  if (!job) return "";
  return [job.url, job.title, job.company, String(job.description || "").slice(0, 240)]
    .map(normalizedResumeText)
    .join("|");
}

function bossJobDetailMatches(page, candidate, beforeFingerprint = "") {
  const job = page?.boss?.job;
  if (!job?.description) return false;
  const expectedTitle = normalizedResumeText(candidate.title);
  const actualTitle = normalizedResumeText(job.title);
  const expectedCompany = normalizedResumeText(candidate.company);
  const actualCompany = normalizedResumeText(job.company);
  const titleMatches = !expectedTitle || actualTitle.includes(expectedTitle) || expectedTitle.includes(actualTitle);
  const companyMatches = !expectedCompany || !actualCompany
    || actualCompany.includes(expectedCompany) || expectedCompany.includes(actualCompany);
  const selectedCardMatches = (page?.boss?.jobCards || []).some((entry) => entry.selected
    && Boolean(bossJobCard({ boss: { jobCards: [entry] } }, candidate)));
  const detailUrlMatches = /job_detail/i.test(job.url || "") && sameJobUrl(job.url, candidate.url);
  // The first card in a BOSS result list is frequently already selected. In
  // that case clicking it again leaves the detail fingerprint unchanged even
  // though the visible JD is exactly the requested one. Title + company are
  // therefore sufficient independent evidence; requiring a DOM change made
  // the runner time out and move on before it ever reached “立即沟通”.
  return detailUrlMatches || selectedCardMatches || (titleMatches && companyMatches);
}

function fatalAutopilotError(error) {
  if (error?.code === "BOSS_APPLY_NOT_VERIFIED") return true;
  return /本人处理|验证码|登录失效|扩展(?:未连接|不可用|未授权)|托管投递已停止|浏览器操作已暂停|模型服务不可用|API Key is not assigned to any group|Incorrect API key|API_KEY_GROUP_UNAVAILABLE/i
    .test(String(error?.message || error || ""));
}

function autopilotProviderError(error) {
  const message = String(error?.message || error || "");
  if (/not assigned to any group|API_KEY_GROUP_UNAVAILABLE|没有可用于 OpenAI 模型的分组/i.test(message)) {
    return new Error("模型服务不可用：当前 Sub2API API Key 未绑定可用分组。请刷新 JobDeck 重新登录；若仍失败，请先为该账号开通 OpenAI 模型分组。");
  }
  if (/Incorrect API key|invalid.*api.?key|authentication|unauthorized|\b401\b/i.test(message)) {
    return new Error("模型服务不可用：Sub2API API Key 无效或已失效，请刷新 JobDeck 重新登录后再试。");
  }
  if (/forbidden|\b403\b/i.test(message)) {
    return new Error(`模型服务不可用：Sub2API 拒绝了当前账号的模型请求（${message}）`);
  }
  return error;
}

async function verifyAutopilotProvider(runId) {
  if (!autopilotActive(runId)) throw new Error("托管投递已停止");
  setAutopilot({
    stage: "provider-check",
    status: "running-analysis",
    message: "正在验证 Sub2API 模型与账号分组，验证成功后开始查找并投递"
  });
  try {
    await ai.verifyProvider();
  } catch (error) {
    throw autopilotProviderError(error);
  }
}

async function recoverBossListAfterCandidateError(runId, tabId, plan, candidate) {
  let current = await inspectBossPageFollowingTabs(tabId, ["job-list"]).catch(() => null);
  let page = current?.page || null;
  tabId = current?.tabId || tabId;
  if (page?.adapter !== "boss-zhipin" || page?.pageType !== "job-list") {
    try {
      const restored = await restoreBossListAfterContact(runId, tabId, candidate);
      page = restored?.page || page;
      tabId = restored?.tabId || tabId;
    } catch (error) {
      if (fatalAutopilotError(error)) throw error;
    }
  }
  setAutopilot({ message: `正在重新点击 BOSS 求职期望 ${plan.expectationLabel}，确认期望城市后再继续` });
  return openBossJobList({ ...plan, tabId, runId, forceExpectation: true });
}

function upsertDetailedJob(page, preferredId, preferredUrl = "") {
  const captured = jobFromPage(page);
  if (preferredUrl) captured.url = preferredUrl;
  let job = store.state.jobs.find((entry) => sameJobUrl(entry.url, captured.url));
  if (!job && preferredId) job = store.state.jobs.find((entry) => entry.id === preferredId);
  if (job) {
    Object.assign(job, mergeJobInput(captured, job), {
      description: captured.description,
      recruiter: captured.recruiter,
      source: captured.source
    });
    store.save();
    return job;
  }
  store.update((state) => state.jobs.unshift(captured));
  return captured;
}

async function analyzeForAutopilot(job, { matchOnly = false } = {}) {
  const analysis = matchOnly ? await ai.matchJob(job) : await ai.analyzeJob(job);
  store.update(() => {
    job.analysis = analysis;
    job.score = matchOnly ? null : analysis.score;
    job.greeting = analysis.greeting;
    job.status = matchOnly ? (analysis.matches ? "analyzed" : "skipped") : (analysis.verdict === "跳过" ? "skipped" : "analyzed");
    job.updatedAt = new Date().toISOString();
  });
  return analysis;
}

function bossComposerFromPage(page) {
  return page?.boss?.chat?.composer
    || findPageControl(page, /消息|回复|招呼|输入|message|chat|reply/i, ["textarea", "input"])
    || (page?.interactives || []).find((item) => item.tag === "textarea" && !item.disabled);
}

const SAFE_BOSS_TRANSITION = /^(?:继续沟通|去沟通|进入沟通|打开聊天|留在此页|返回职位|关闭|取消)$/i;

async function adaptiveBossComposer(runId, tabId, job) {
  const attempts = new Map();
  const trace = [];
  let platformGreetingObserved = false;
  let contactRetries = 0;
  for (let turn = 1; turn <= 12; turn += 1) {
    if (!autopilotActive(runId)) throw new Error("托管投递已停止");
    let current;
    try {
      current = await inspectBossPageFollowingTabs(tabId, ["chat"]);
    } catch (error) {
      if (fatalAutopilotError(error)) throw error;
      trace.push(`第${turn}步：等待 BOSS 新标签页（${error.message}）`);
      setAutopilot({ message: `智能规划第 ${turn} 步：等待 BOSS 沟通页面加载` });
      await sleep(550);
      continue;
    }
    tabId = current.tabId;
    const page = current.page;
    if (!page) {
      trace.push(`第${turn}步：页面暂时为空`);
      await sleep(450);
      continue;
    }
    const blocked = verificationReason(page);
    if (blocked) throw new Error(`BOSS 要求${blocked}，需要本人处理后继续`);
    const composer = bossComposerFromPage(page);
    if (composer) return { page, composer, mode: "tailored", tabId };

    const controls = page.interactives || [];
    const platformGreetingSent = /已向BOSS发送消息|已发送招呼|消息已发送/.test(String(page.text || ""));
    platformGreetingObserved ||= platformGreetingSent;
    let next = findPageControl(page, /^(?:继续沟通|去沟通|进入沟通|打开聊天)$/i);
    let source = "页面状态规则";
    if (next && (attempts.get(next.selector) || 0) >= 2) next = undefined;

    // A visible click can occasionally be swallowed while the BOSS detail
    // panel is still settling. Retry the same job in place instead of treating
    // “JD opened” as completion and advancing to another card. We only retry
    // while the original action is still present and BOSS has not reported
    // that its default greeting was sent, which avoids duplicate contacts.
    if (!next && !platformGreetingSent && contactRetries < 2) {
      next = findPageControl(page, /^(?:立即沟通|立即申请|投递简历|申请职位)$/i);
      if (next) {
        contactRetries += 1;
        source = `沟通入口未生效，原岗位重试 ${contactRetries}/2`;
      }
    }

    if (!next && turn >= 3) {
      const plan = await ai.planBrowserTask(
        `已经点击“立即沟通”，目标是进入与 ${job.title} 招聘方的沟通输入页并发送既有定制招呼。请只从真实可见控件中选择一个用于继续、进入聊天、关闭中间层或返回的安全点击；不要填写或发送任何内容。`,
        page
      );
      const planned = plan.actions.find((action) => action.kind === "click");
      const candidate = planned
        ? controls.find((item) => item.selector === planned.selector && !item.disabled && SAFE_BOSS_TRANSITION.test(item.label || ""))
        : undefined;
      if (candidate && (attempts.get(candidate.selector) || 0) < 2) {
        next = candidate;
        source = `Luna 规划：${plan.summary || candidate.label}`;
      } else if (plan.summary) {
        trace.push(`第${turn}步：Luna 未找到可安全执行的控件（${plan.summary}）`);
      }
    }

    if (!next && platformGreetingSent && turn >= 3) {
      next = findPageControl(page, /^留在此页$/i);
      source = "关闭平台默认招呼提示，继续进入会话补发定制消息";
    }

    if (next) {
      const point = centerOf(next, next.label || "中间页面操作");
      attempts.set(next.selector, (attempts.get(next.selector) || 0) + 1);
      trace.push(`第${turn}步：${source} → ${next.label}`);
      setAutopilot({ message: `智能规划第 ${turn} 步：${next.label}（${source}）` });
      await bridge.execute({ kind: "computerMove", tabId, x: point.x, y: point.y, reason: `智能规划：移动到 ${next.label}` });
      await sleep(160);
      await bridge.execute({ kind: "computerClick", tabId, x: point.x, y: point.y, reason: `智能规划：点击 ${next.label}` });
      await sleep(650);
      continue;
    }

    trace.push(`第${turn}步：等待页面产生新状态`);
    setAutopilot({ message: `智能规划第 ${turn} 步：重新观察页面` });
    await sleep(500);
  }
  const prefix = platformGreetingObserved
    ? "平台只发送了默认招呼，尚未找到会话输入框；定制消息未发送且不会计入成功。"
    : "智能规划未找到沟通输入框。";
  throw new Error(`${job.company} / ${job.title}：${prefix}尝试记录：${trace.slice(-5).join("；")}`);
}

function recordBossJobSent(job) {
  store.update((state) => {
    job.status = "sent";
    job.sentAt = new Date().toISOString();
    job.sentMode = "tailored";
    const batchItem = state.workflow.batch.find((item) => item.jobId === job.id);
    if (batchItem) batchItem.status = "sent";
  });
  const sent = store.state.workflow.autopilot.sent + 1;
  const message = `已验证发送定制招呼：${job.company} / ${job.title}`;
  setAutopilot({ sent, message });
  store.addActivity(message);
}

async function applyCurrentBossJob(runId, tabId, job) {
  let page = await bridge.execute({ kind: "inspect", tabId });
  if (!page) {
    page = await waitForBossPage(runId, (value) => value?.adapter === "boss-zhipin" && Boolean(value?.boss?.job?.description), "BOSS 职位详情", 8, tabId);
  }
  const contact = findPageControl(page, /^(?:立即沟通|继续沟通|立即申请|投递简历|申请职位)$/i);
  if (!contact) throw new Error(`${job.company} / ${job.title}：未找到明确的沟通或投递按钮`);
  const contactPoint = centerOf(contact, "沟通或投递按钮");
  setAutopilot({ message: `目标 ${store.state.workflow.autopilot.sent}/${store.state.workflow.autopilot.targetApplications}；鼠标正在移向“${contact.label || "立即沟通"}”` });
  await bridge.execute({ kind: "computerMove", tabId, x: contactPoint.x, y: contactPoint.y, reason: `已批准批次：移动到 ${job.company} 的沟通按钮` });
  await sleep(180);
  await bridge.execute({ kind: "computerClick", tabId, x: contactPoint.x, y: contactPoint.y, reason: `已批准批次：联系 ${job.company} 的 ${job.title}` });
  setAutopilot({ message: `已点击“${contact.label || "立即沟通"}”，正在验证 BOSS 会话与定制消息输入框` });
  await sleep(500);
  const transition = await adaptiveBossComposer(runId, tabId, job);
  tabId = transition.tabId;
  page = transition.page;
  const composer = transition.composer;
  if (!composer) throw new Error(`${job.company} / ${job.title}：未找到沟通输入框`);
  const composerPoint = centerOf(composer, "沟通输入框");
  await bridge.execute({ kind: "computerMove", tabId, x: composerPoint.x, y: composerPoint.y, reason: `已批准批次：移动到 ${job.company} 的沟通输入框` });
  await bridge.execute({ kind: "computerClick", tabId, x: composerPoint.x, y: composerPoint.y, reason: `已批准批次：聚焦 ${job.company} 的沟通输入框` });
  await bridge.execute({ kind: "computerType", tabId, value: job.greeting, replace: true, reason: `已批准批次：填写该 JD 的定制招呼语` });
  await sleep(500);
  let current = await waitForBossPageFollowingTabs(
    runId,
    (value) => value?.adapter === "boss-zhipin",
    "BOSS 沟通页面",
    8,
    tabId,
    ["chat"]
  );
  page = current.page;
  tabId = current.tabId;
  let send = findPageControl(page, /^(?:发送|发送消息|确定发送)$/i);
  if (!send) {
    current = await waitForBossPageFollowingTabs(
      runId,
      (value) => Boolean(findPageControl(value, /^(?:发送|发送消息|确定发送)$/i)),
      "可用的消息发送按钮",
      8,
      tabId,
      ["chat"]
    );
    page = current.page;
    tabId = current.tabId;
    send = findPageControl(page, /^(?:发送|发送消息|确定发送)$/i);
  }
  if (!send) throw new Error(`${job.company} / ${job.title}：未找到唯一的发送按钮，未自动发送`);
  const sendPoint = centerOf(send, "发送按钮");
  await bridge.execute({ kind: "computerMove", tabId, x: sendPoint.x, y: sendPoint.y, reason: `已批准批次：移动到 ${job.company} 的发送按钮` });
  await bridge.execute({ kind: "computerClick", tabId, x: sendPoint.x, y: sendPoint.y, reason: `已批准批次：发送 ${job.company} / ${job.title} 的定制招呼语` });
  await waitForBossPageFollowingTabs(
    runId,
    (value) => String(value.text || "").includes(job.greeting.slice(0, 24)),
    "消息发送结果",
    10,
    tabId,
    ["chat"]
  );
  recordBossJobSent(job);
  return restoreBossListAfterContact(runId, tabId, job);
}

function unverifiedBossApplicationError(job, error) {
  const wrapped = new Error(`${job.company} / ${job.title}：投递链路未完整验证，已暂停而不是跳到下一个 JD。${error.message}`);
  wrapped.code = "BOSS_APPLY_NOT_VERIFIED";
  return wrapped;
}

function stopAutopilotWith(error, fallbackPhase = "autopilot-blocked") {
  const stopped = /已停止/.test(error.message);
  setAutopilot({
    status: stopped ? "stopped" : "needs-attention",
    stage: stopped ? "stopped" : "blocked",
    currentJobId: null,
    message: error.message,
    completedAt: new Date().toISOString()
  });
  setWorkflow({ phase: stopped ? "shortlist" : fallbackPhase, lastError: error.message });
  store.addActivity(`托管流程${stopped ? "已停止" : "暂停"}：${error.message}`, stopped ? "done" : "error");
}

async function runAutopilotAnalysis(runId, candidateIds, { autoApply = false, tabId = null } = {}) {
  try {
    if (!tabId) throw new Error("没有可用的 BOSS 职位列表标签页");
    const candidates = candidateIds
      .map((id) => store.state.jobs.find((job) => job.id === id))
      .filter((job) => job && !["sent", "replied", "interview"].includes(job.status))
      .slice(0, autoApply ? 30 : 8);

    for (const candidate of candidates) {
      if (!autopilotActive(runId)) throw new Error("托管投递已停止");
      setAutopilot({
        stage: "analyzing",
        currentJobId: candidate.id,
        message: `正在读取完整 JD：${candidate.company} / ${candidate.title}`
      });
      const page = await selectBossJobCard(runId, tabId, candidate);
      const job = upsertDetailedJob(page, candidate.id, candidate.url);
      const analysis = await analyzeForAutopilot(job, { matchOnly: autoApply });
      const analyzed = store.state.workflow.autopilot.analyzed + 1;
      setAutopilot({
        analyzed,
        message: autoApply
          ? `${job.company} / ${job.title}：${analysis.matches ? "技术与岗位匹配，加入投递" : "方向或技术栈不匹配，跳过"}`
          : `${job.company} / ${job.title}：${analysis.score} 分，${analysis.verdict}`
      });
      if (autoApply && analysis.matches === true && job.greeting) {
        const selected = store.state.workflow.autopilot.selected + 1;
        setAutopilot({ selected, message: `${job.company} / ${job.title}：技术与岗位匹配，使用 Computer Use 发送定制招呼` });
        await applyCurrentBossJob(runId, tabId, job);
      }
      await sleep(900);
    }

    if (autoApply) {
      setAutopilot({
        status: "complete",
        stage: "complete",
        currentJobId: null,
        rankedJobIds: [],
        selectedJobIds: [],
        message: `已使用 Computer Use 检查 ${candidates.length} 个完整 JD，发送 ${store.state.workflow.autopilot.sent} 个定制沟通`,
        completedAt: new Date().toISOString()
      });
      setWorkflow({ phase: "apply-complete", lastError: "" });
      store.addActivity(`Computer Use 自动找工作完成：检查 ${candidates.length} 个岗位，发送 ${store.state.workflow.autopilot.sent} 个沟通`);
      return;
    }
    const ranked = rankAnalyzedJobs(store.state.jobs, candidates.map((candidate) => candidate.id));
    if (!ranked.length) throw new Error("没有岗位成功完成完整 JD 分析，未进入投递选择");
    const recommended = ranked.filter((job) => Number(job.score) >= 70).map((job) => job.id);
    setAutopilot({
      status: "selection-ready",
      stage: "ranking",
      currentJobId: null,
      rankedJobIds: ranked.map((job) => job.id),
      selectedJobIds: recommended,
      selected: recommended.length,
      message: `已完成 ${ranked.length} 个岗位评分，请查看排名并选择要投递的岗位`,
      completedAt: new Date().toISOString()
    });
    setWorkflow({ phase: "ranking-ready", lastError: "" });
    store.addActivity(`完整 JD 评分完成：${ranked.length} 个岗位，等待用户选择`);
  } catch (error) {
    stopAutopilotWith(error);
  }
}

function persistSearchCandidates(found) {
  const candidateIds = [];
  let addedCount = 0;
  store.update((state) => {
    for (const candidate of found) {
      let job = state.jobs.find((entry) => sameJobUrl(entry.url, candidate.url));
      if (!job) {
        state.jobs.unshift(candidate);
        job = candidate;
        addedCount += 1;
      }
      if (!["sent", "replied", "interview"].includes(job.status) && !candidateIds.includes(job.id)) candidateIds.push(job.id);
    }
  });
  return { candidateIds, addedCount };
}

function candidateMatchesExpectedLocation(candidate, activeLocation = "") {
  const expected = (activeLocation && activeLocation !== "全国"
    ? [activeLocation]
    : store.state.candidate.locations || [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!expected.length) return true;
  const haystack = `${candidate.location || ""} ${candidate.context || ""}`;
  return expected.some((location) => location === "远程"
    ? /远程|居家|remote/i.test(haystack)
    : haystack.includes(location));
}

async function ensureAutopilotCandidateEvidence(runId) {
  if (hasCandidateEvidence(store.state.candidate)) return;
  setAutopilot({
    stage: "resume-evidence",
    status: "running-search",
    message: "候选人技术证据尚未同步，正在自动读取 BOSS 在线简历"
  });
  store.addActivity("自动找工作：候选人技术证据为空，先读取 BOSS 在线简历");
  const tab = await bridge.execute({ kind: "openBossResume" });
  const page = await waitForBossPage(
    runId,
    (value) => value?.adapter === "boss-zhipin"
      && value?.pageType === "resume"
      && ((value?.boss?.resume?.sections || []).length > 0 || String(value?.text || "").length > 600),
    "BOSS 在线简历",
    20,
    tab.id
  );
  const resumeText = persistBossResumeEvidence(page);
  store.addActivity(`自动找工作：已从 BOSS 在线简历同步 ${resumeText.length} 字真实技术证据`);
  setAutopilot({ message: "BOSS 在线简历证据已同步，准备进入职位列表" });
}

async function runAutomaticJobSearch(runId, targetApplications) {
  try {
    await verifyAutopilotProvider(runId);
    await ensureAutopilotCandidateEvidence(runId);
    const initialTab = await bridge.execute({ kind: "openBossJobs" });
    let tabId = initialTab.id;
    let initialPage = await waitForBossList(runId, tabId, "BOSS 职位列表", 20);
    initialPage = await exposeBossListHeader(runId, tabId, initialPage);
    const plans = buildBossExpectationPlans(initialPage?.boss?.expectationOptions || []);
    if (!plans.length) {
      throw new Error("没有识别到 BOSS 顶部已保存的求职期望。请先在 BOSS 添加求职期望，再启动自动找工作");
    }
    setAutopilot({ message: `已读取 ${plans.length} 个 BOSS 求职期望，直接按 BOSS 的岗位和城市开始查找` });
    let inspectedCount = 0;
    let discoveredCount = 0;
    let addedCount = 0;
    const seenUrls = new Set();
    const discoveredUrls = new Set();
    let plansWithoutProgress = 0;
    let planIndex = 0;

    while (store.state.workflow.autopilot.sent < targetApplications && plansWithoutProgress < plans.length) {
      if (!autopilotActive(runId)) throw new Error("托管投递已停止");
      const plan = plans[planIndex % plans.length];
      const sentBeforePlan = store.state.workflow.autopilot.sent;
      const inspectedBeforePlan = inspectedCount;
      setAutopilot({
        stage: "searching",
        status: "running-search",
        message: `目标 ${store.state.workflow.autopilot.sent}/${targetApplications}；Computer Use 正在处理 BOSS 求职期望 ${plan.expectationLabel}`
      });

      try {
        const result = await openBossJobList({ ...plan, tabId, runId });
        tabId = result.tabId;
        let activeLocation = result.effectiveLocation;
        let page = result.page;
        while (page && store.state.workflow.autopilot.sent < targetApplications) {
          // BOSS virtualizes and refreshes the result column whenever a detail
          // is opened or a chat is closed. Process exactly one card from the
          // latest snapshot, then observe the page again. Iterating a captured
          // array of cards caused the runner to click a valid first JD and then
          // silently skip the remaining stale entries.
          const visible = jobCandidatesFromPage(page);
          const fresh = visible.filter((candidate) => {
            if (!candidate.url || seenUrls.has(candidate.url)) return false;
            if (!candidateMatchesExpectedLocation(candidate, activeLocation)) return false;
            const existing = store.state.jobs.find((job) => sameJobUrl(job.url, candidate.url));
            return !["sent", "replied", "interview"].includes(existing?.status);
          });
          const persisted = persistSearchCandidates(fresh);
          addedCount += persisted.addedCount;
          for (const candidate of fresh) {
            if (!discoveredUrls.has(candidate.url)) {
              discoveredUrls.add(candidate.url);
              discoveredCount += 1;
            }
          }
          setAutopilot({ discovered: discoveredCount, status: "running-analysis", stage: "analyzing" });

          const candidateId = persisted.candidateIds[0];
          if (!candidateId) {
            page = await advanceBossJobResults(runId, tabId, seenUrls);
            continue;
          }
          if (!autopilotActive(runId)) throw new Error("托管投递已停止");
          const candidate = store.state.jobs.find((job) => job.id === candidateId);
          if (!candidate) {
            page = await advanceBossJobResults(runId, tabId, seenUrls);
            continue;
          }
          seenUrls.add(candidate.url);
          let applicationAttempted = false;
          try {
            setAutopilot({ currentJobId: candidate.id, message: `目标 ${store.state.workflow.autopilot.sent}/${targetApplications}；正在查看 ${candidate.company} / ${candidate.title}` });
            const detailPage = await selectBossJobCard(runId, tabId, candidate);
            const job = upsertDetailedJob(detailPage, candidate.id, candidate.url);
            if (!candidateMatchesExpectedLocation(job, activeLocation)) {
              store.addActivity(`自动找工作跳过异地岗位：${job.company} / ${job.title}（${job.location || "地点未识别"}，当前期望 ${activeLocation}）`, "done");
            } else {
              const analysis = await analyzeForAutopilot(job, { matchOnly: true });
              inspectedCount += 1;
              setAutopilot({
                analyzed: inspectedCount,
                message: `${job.company} / ${job.title}：${analysis.matches ? "技术与岗位匹配，下一步将点击立即沟通" : `未进入“立即沟通”点击：${analysis.summary || analysis.hardGaps?.join("、") || "岗位方向不符"}`}`
              });
              if (analysis.matches === true && job.greeting) {
                applicationAttempted = true;
                const selected = store.state.workflow.autopilot.selected + 1;
                setAutopilot({ selected, status: "running-apply", stage: "applying", message: `目标 ${store.state.workflow.autopilot.sent}/${targetApplications}；正在沟通 ${job.company} / ${job.title}` });
                const application = await applyCurrentBossJob(runId, tabId, job);
                tabId = application.tabId;
                applicationAttempted = false;
                setAutopilot({ status: "running-analysis", stage: "analyzing", message: `已完成 ${store.state.workflow.autopilot.sent}/${targetApplications}；正在重新选择 ${plan.expectationLabel} 并核对期望城市` });
                const resumed = await openBossJobList({ ...plan, tabId, runId, forceExpectation: true });
                page = resumed.page;
                tabId = resumed.tabId;
                activeLocation = resumed.effectiveLocation || activeLocation;
                setAutopilot({ status: "running-analysis", stage: "analyzing", message: `已恢复 ${plan.expectationLabel} / ${activeLocation}，继续寻找匹配岗位` });
              } else {
                store.addActivity(`未点击立即沟通：${job.company} / ${job.title}（${analysis.summary || analysis.hardGaps?.join("、") || "岗位存在明确硬性冲突"}）`, "done");
              }
            }
          } catch (error) {
            if (applicationAttempted && error?.code !== "BOSS_APPLY_NOT_VERIFIED") {
              throw unverifiedBossApplicationError(candidate, error);
            }
            if (fatalAutopilotError(error)) throw error;
            store.addActivity(`自动找工作当前岗位未完成：${candidate.company} / ${candidate.title}（${error.message}）`, "error");
            try {
              const recovered = await recoverBossListAfterCandidateError(runId, tabId, plan, candidate);
              tabId = recovered.tabId;
              page = recovered.page;
            } catch (recoveryError) {
              if (fatalAutopilotError(recoveryError)) throw recoveryError;
              store.addActivity(`恢复职位列表失败，改试下一组求职期望：${recoveryError.message}`, "error");
              page = null;
            }
          }
          await sleep(900);
          if (page?.pageType !== "job-list") {
            page = await bridge.execute({ kind: "inspect", tabId }).catch(() => page);
          }
        }
      } catch (error) {
        if (fatalAutopilotError(error)) throw error;
        store.addActivity(`BOSS 求职期望 ${plan.expectationLabel} 暂时跳过：${error.message}`, "error");
      }

      const progressed = inspectedCount > inspectedBeforePlan || store.state.workflow.autopilot.sent > sentBeforePlan;
      plansWithoutProgress = progressed ? 0 : plansWithoutProgress + 1;
      planIndex += 1;
      await sleep(900);
    }

    store.update((state) => {
      state.workflow.search.discovered += addedCount;
      state.workflow.search.locations = [...new Set(plans.map((plan) => plan.location))];
      state.workflow.search.queries = [...new Set(plans.map((plan) => plan.role))];
    });
    const sent = store.state.workflow.autopilot.sent;
    if (sent < targetApplications) {
      throw new Error(`目标尚未完成：已验证沟通 ${sent}/${targetApplications}；BOSS 已保存的求职期望暂未发现新的匹配岗位`);
    }
    setAutopilot({
      status: "complete",
      stage: "complete",
      currentJobId: null,
      message: `目标已完成：查看 ${inspectedCount} 个完整 JD，已验证沟通 ${sent}/${targetApplications}`,
      completedAt: new Date().toISOString()
    });
    setWorkflow({ phase: "apply-complete", lastError: "" });
    store.addActivity(`Computer Use 自动找工作目标完成：查看 ${inspectedCount} 个岗位，已验证沟通 ${sent}/${targetApplications}`);
  } catch (error) {
    stopAutopilotWith(error);
  }
}

function startAutomaticJobSearch(requestedTarget) {
  const targetApplications = automaticApplicationTarget(requestedTarget);
  const runId = crypto.randomUUID();
  store.update((state) => {
    state.workflow.phase = "analysis-running";
    state.workflow.lastError = "";
  });
  setAutopilot({
    status: "running-search",
    runId,
    stage: "searching",
    autoApply: true,
    autoApplyLimit: targetApplications,
    targetApplications,
    message: `目标 0/${targetApplications}；准备读取 BOSS 已保存的求职期望`,
    discovered: 0,
    analyzed: 0,
    selected: 0,
    sent: 0,
    currentJobId: null,
    rankedJobIds: [],
    selectedJobIds: [],
    stopRequested: false,
    startedAt: new Date().toISOString(),
    completedAt: null
  });
  store.addActivity(`Computer Use 自动找工作启动：目标至少 ${targetApplications} 份，岗位与城市完全使用 BOSS 已保存的求职期望`);
  queueMicrotask(() => runAutomaticJobSearch(runId, targetApplications));
  return { runId, targetApplications, source: "boss-expectations" };
}

async function startAutopilotFromCurrentList() {
  const page = await bridge.execute({ kind: "inspect" });
  if (page.adapter !== "boss-zhipin" || page.pageType !== "job-list") {
    throw new Error("请先在 BOSS 打开职位列表，再开始手动评分");
  }
  const found = jobCandidatesFromPage(page);
  const tabs = await bridge.execute({ kind: "listTabs" });
  const activeTab = tabs.find((tab) => tab.active);
  if (!activeTab?.id) throw new Error("没有识别到当前 BOSS 职位列表标签页");
  const { candidateIds, addedCount } = persistSearchCandidates(found);
  if (!candidateIds.length) throw new Error("当前列表没有新的可投候选，请调整筛选条件");
  const runId = crypto.randomUUID();
  store.update((state) => {
    state.workflow.phase = "analysis-running";
    state.workflow.search.discovered += addedCount;
  });
  setAutopilot({
    status: "running-analysis",
    runId,
    stage: "analyzing",
    autoApply: false,
    autoApplyLimit: null,
    message: `已发现 ${candidateIds.length} 个未重复候选，开始读取完整 JD`,
    discovered: candidateIds.length,
    analyzed: 0,
    selected: 0,
    sent: 0,
    currentJobId: null,
    rankedJobIds: [],
    selectedJobIds: [],
    stopRequested: false,
    startedAt: new Date().toISOString(),
    completedAt: null
  });
  store.addActivity(`开始读取并评分 ${Math.min(candidateIds.length, 8)} 个完整 JD`);
  queueMicrotask(() => runAutopilotAnalysis(runId, candidateIds, { tabId: activeTab.id }));
  return { runId, candidates: Math.min(candidateIds.length, 8), autoApply: false };
}

async function runAutopilotApply(runId, selectedIds) {
  try {
    const selected = selectedIds
      .map((id) => store.state.jobs.find((job) => job.id === id))
      .filter((job) => job?.analysis && job.greeting && job.url && !["sent", "replied", "interview"].includes(job.status));
    if (!selected.length) throw new Error("没有可投递的已选岗位");

    let tabId = null;
    for (const job of selected) {
      if (!autopilotActive(runId)) throw new Error("托管投递已停止");
      setAutopilot({ currentJobId: job.id, message: `Computer Use 正在重新搜索并投递：${job.company} / ${job.title}` });
      const result = await openBossJobList({ keyword: job.title, location: job.location || store.state.candidate.locations?.[0] || "全国", tabId, runId });
      tabId = result.tabId;
      const visible = jobCandidatesFromPage(result.page);
      const candidate = visible.find((entry) => sameJobUrl(entry.url, job.url))
        || visible.find((entry) => normalizedResumeText(entry.title).includes(normalizedResumeText(job.title))
          || normalizedResumeText(job.title).includes(normalizedResumeText(entry.title)));
      if (!candidate) throw new Error(`${job.company} / ${job.title}：当前搜索结果没有找到该岗位，未继续投递`);
      const page = await selectBossJobCard(runId, tabId, candidate);
      upsertDetailedJob(page, job.id, job.url);
      await applyCurrentBossJob(runId, tabId, job);
      await sleep(1200);
    }

    setAutopilot({
      status: "complete",
      stage: "complete",
      currentJobId: null,
      message: `本轮完成，已发送 ${store.state.workflow.autopilot.sent} 个定制沟通`,
      completedAt: new Date().toISOString()
    });
    setWorkflow({ phase: "apply-complete", lastError: "" });
  } catch (error) {
    stopAutopilotWith(error);
  }
}

tenantRuntime.setTenantInitializer(() => {
  store.update((state) => {
    for (const job of state.jobs) {
      if (job.company && job.company !== "待识别公司") continue;
      job.company = inferCompanyName(job);
    }
  });
  if (String(store.state.workflow.autopilot?.status).startsWith("running-")) {
    setAutopilot({ status: "stopped", stage: "stopped", stopRequested: true, message: "服务曾中断，请重新授权一个批次" });
  }
  if (store.state.workflow.phase === "autopilot-blocked" && /Cannot read properties of null \(reading 'adapter'\)|页面读取脚本没有返回内容|BOSS 页面读取(?:通道不可用|失败)/.test(store.state.workflow.lastError || "")) {
    setAutopilot({
      status: "stopped",
      stage: "stopped",
      currentJobId: null,
      stopRequested: true,
      message: "上次因页面临时未读取到而暂停；问题已修复，可重新启动自动找工作"
    });
    setWorkflow({ phase: "shortlist", lastError: "" });
  }
  if (store.state.workflow.phase === "search-open" && /127\.0\.0\.1:43120/.test(store.state.workflow.lastError || "")) {
    setWorkflow({ lastError: "" });
  }
  if (["planning", "executing", "waiting"].includes(store.state.workflow.agent?.status)) {
    store.update((state) => {
      state.workflow.agent = {
        ...state.workflow.agent,
        status: "needs-attention",
        currentTool: null,
        waitFor: null,
        message: "服务曾中断；为避免重复外部操作，任务没有自动续跑，请重新下达目标",
        updatedAt: new Date().toISOString()
      };
    });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "jobdeck", version: "0.16.0", remoteMode, multiUser: multiUserMode }));
app.get("/api/state", (_req, res) => res.json(statePayload()));

app.post("/api/provider", (req, res) => {
  const { mode, baseURL, model, apiKey } = req.body || {};
  if (baseURL) {
    let providerUrl;
    try { providerUrl = new URL(baseURL); }
    catch { return res.status(400).json({ error: "模型地址格式不正确" }); }
    const localHttp = providerUrl.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(providerUrl.hostname);
    if (providerUrl.protocol !== "https:" && !localHttp) return res.status(400).json({ error: "远程模型地址必须使用 HTTPS；HTTP 仅允许本机服务" });
  }
  if (!model) return res.status(400).json({ error: "请填写模型名称" });
  const provider = store.setProvider({ mode, baseURL, model, apiKey: String(apiKey || "").trim() });
  store.addActivity("模型设置已保存");
  res.json(provider);
});

function saveConversation(mode, messages, content) {
  store.update((state) => {
    state.conversations.push({
      id: crypto.randomUUID(),
      mode,
      messages: [...messages, { role: "assistant", content }],
      at: new Date().toISOString()
    });
    state.conversations = state.conversations.slice(-50);
  });
}

function jobSearchProgressContent() {
  const autopilot = store.state.workflow.autopilot || {};
  const target = autopilot.targetApplications || DEFAULT_AUTO_APPLY_TARGET;
  const running = String(autopilot.status || "").startsWith("running-");
  const label = running ? "自动找工作正在运行" : autopilot.status === "complete" ? "自动找工作已完成" : "自动找工作当前未运行";
  return `${label}：已验证沟通 ${autopilot.sent || 0}/${target}，已读取 ${autopilot.analyzed || 0} 个完整 JD，发现 ${autopilot.discovered || 0} 个候选。${autopilot.message || ""}`;
}

async function beginAutomaticResumeRewrite() {
  if (store.state.workflow.resumeApply?.status === "running"
    || store.state.workflow.resumeAuditStatus === "running"
    || store.state.workflow.resumeOptimizationStatus === "running") {
    throw new Error("自动修改简历已经在运行");
  }
  if (!store.secrets.apiKey) throw new Error("请先在设置中填写模型 API Key");
  const tab = await bridge.execute({ kind: "openBossResume" });
  const runId = crypto.randomUUID();
  setResumeApply({
    status: "preparing",
    runId,
    message: "正在打开并读取 BOSS 在线简历…",
    appliedFields: [],
    skippedFields: [],
    verifiedFieldKeys: [],
    updatedFieldKeys: [],
    optimizationGeneratedAt: null,
    startedAt: new Date().toISOString(),
    completedAt: null
  });
  setWorkflow({
    phase: "resume-loading",
    resumeTabId: tab.id,
    resumeAuditStatus: "running",
    resumeAuditMessage: "正在等待 BOSS 在线简历加载…",
    resumeAuditRunId: runId,
    resumeOptimizationStatus: "running",
    resumeOptimizationMessage: "等待在线简历审查完成…",
    resumeOptimizationRunId: runId,
    lastError: ""
  });
  store.addActivity("自动修改简历启动：读取、审查、生成优化稿并用 Computer Use 写入");
  queueMicrotask(() => runAutomaticResumeRewrite(runId, tab.id));
  return { runId, tabId: tab.id };
}

function agentAuthorizationScopes(text) {
  const value = String(text || "");
  const scopes = [];
  if (isJobSearchExecutionIntent(value) || /(?:投递|海投|申请岗位|沟通(?:岗位|职位))/.test(value)) scopes.push("jobs:apply");
  if (/(?:修改|优化|改写|更新).{0,10}(?:在线)?简历/.test(value)) scopes.push("resume:write");
  if (/(?:发送|回复).{0,10}(?:招聘|HR|BOSS|消息)/i.test(value)) scopes.push("reply:send");
  return scopes;
}

function compactBrowserPage(page) {
  if (!page) return null;
  return {
    adapter: page.adapter || "",
    pageType: page.pageType || "",
    title: String(page.title || "").slice(0, 200),
    url: String(page.url || "").slice(0, 1000),
    text: String(page.text || "").slice(0, 5000),
    boss: page.boss ? {
      location: page.boss.location || "",
      activeExpectation: page.boss.activeExpectation || null,
      jobs: Array.isArray(page.boss.jobs) ? page.boss.jobs.slice(0, 12).map((job) => ({ title: job.title, company: job.company, salary: job.salary, location: job.location })) : [],
      chat: page.boss.chat ? { recruiter: page.boss.chat.recruiter, company: page.boss.chat.company, jobTitle: page.boss.chat.jobTitle, messages: page.boss.chat.messages?.slice(-6) } : null
    } : null
  };
}

const agentTools = [
  {
    name: "get_workspace_status",
    description: "读取候选人目标、求职工作流、插件连接、简历和投递进度",
    input: {},
    risk: "read",
    execute: async () => ({ progress: false, summary: jobSearchProgressContent(), data: await observeAgentState() })
  },
  {
    name: "inspect_current_browser",
    description: "通过 Chrome 插件观察当前页面，不点击或修改页面",
    input: {},
    risk: "read",
    execute: async () => {
      const page = compactBrowserPage(await bridge.execute({ kind: "inspect" }));
      return { progress: false, summary: `已观察当前页面：${page?.title || "未识别页面"}`, data: page };
    }
  },
  {
    name: "open_boss_resume",
    description: "在真实 Chrome 中打开 BOSS 在线简历页面",
    input: {},
    risk: "read",
    execute: async () => {
      const tab = await bridge.execute({ kind: "openBossResume" });
      return { progress: true, summary: "已打开 BOSS 在线简历", data: { tabId: tab.id } };
    }
  },
  {
    name: "rewrite_boss_resume",
    description: "审查并使用 Computer Use 自动修改、保存和回读验证 BOSS 在线简历",
    input: {},
    risk: "resume:write",
    execute: async () => {
      const result = await beginAutomaticResumeRewrite();
      return { progress: true, waitFor: "resume-rewrite", summary: "已启动在线简历读取、优化、写入和验证", data: result };
    }
  },
  {
    name: "open_boss_jobs",
    description: "在真实 Chrome 中打开 BOSS 职位页面，后续由 Agent 根据状态继续规划",
    input: {},
    risk: "read",
    execute: async () => {
      const tab = await bridge.execute({ kind: "openBossJobs" });
      return { progress: true, summary: "已打开 BOSS 职位页面", data: { tabId: tab.id } };
    }
  },
  {
    name: "search_and_apply_jobs",
    description: "读取 BOSS 已保存求职期望、循环浏览完整 JD、技术匹配即发送逐岗位定制招呼语",
    input: { targetApplications: "希望完成的已验证沟通数量，1到500；未指定时默认60" },
    risk: "jobs:apply",
    execute: async (arguments_, task) => {
      if (String(store.state.workflow.autopilot?.status || "").startsWith("running-")) {
        return { progress: false, waitFor: "job-search", summary: jobSearchProgressContent() };
      }
      const requestedTarget = requestedApplicationTarget(task?.sourceText || task?.goal);
      const targetApplications = requestedTarget || DEFAULT_AUTO_APPLY_TARGET;
      const result = startAutomaticJobSearch(targetApplications);
      return { progress: true, waitFor: "job-search", summary: `已启动目标为 ${result.targetApplications} 个已验证沟通的搜索与投递`, data: result };
    }
  },
  {
    name: "stop_job_search",
    description: "安全停止正在运行的自动找工作任务",
    input: {},
    risk: "read",
    execute: async () => {
      const running = String(store.state.workflow.autopilot?.status || "").startsWith("running-");
      if (running) setAutopilot({ stopRequested: true, message: "正在完成当前安全边界并停止…" });
      return { progress: running, summary: running ? "已请求安全停止自动找工作" : "当前没有运行中的自动找工作任务" };
    }
  },
  {
    name: "list_saved_jobs",
    description: "读取岗位池中的岗位、分析和沟通状态，用于统计、比较或决定下一步",
    input: { limit: "返回数量，默认20，最多100" },
    risk: "read",
    execute: async (arguments_) => {
      const limit = Math.max(1, Math.min(100, Number.parseInt(arguments_.limit, 10) || 20));
      const jobs = store.state.jobs.slice(0, limit).map(({ id, title, company, location, salary, status, score, url }) => ({ id, title, company, location, salary, status, score, url }));
      return { progress: false, summary: `读取了 ${jobs.length} 个已保存岗位`, data: jobs };
    }
  },
  {
    name: "draft_current_recruiter_reply",
    description: "读取当前 BOSS 对话并生成事实安全的回复草稿；敏感事项只请求本人确认，不自动发送",
    input: {},
    risk: "read",
    execute: async () => {
      const page = await bridge.execute({ kind: "inspect" });
      if (page?.adapter !== "boss-zhipin" || page?.pageType !== "chat" || !page.boss?.chat) throw new Error("当前不是可识别的 BOSS 沟通页面");
      const reply = await ai.draftBossReply(page.boss.chat);
      let stagedActionId = null;
      if (!reply.needsConfirmation && reply.draft && page.boss.chat.composer?.selector) {
        stagedActionId = bridge.stage({ kind: "type", selector: page.boss.chat.composer.selector, value: reply.draft, reason: "Agent 生成事实安全的招聘回复草稿" }).id;
      }
      return { progress: true, summary: reply.needsConfirmation ? `回复需要本人确认：${reply.reason}` : "已生成并加入确认队列，尚未发送", data: { reply, stagedActionId } };
    }
  },
  {
    name: "propose_browser_actions",
    description: "根据当前页面规划可扩展的浏览器点击或输入动作，并加入人工确认队列",
    input: { instruction: "希望在当前页面完成的具体事情" },
    risk: "read",
    execute: async (arguments_) => {
      const instruction = String(arguments_.instruction || "").trim().slice(0, 1200);
      if (!instruction) throw new Error("缺少浏览器操作目标");
      const page = await bridge.execute({ kind: "inspect" });
      const plan = await ai.planBrowserTask(instruction, page);
      const items = plan.actions.map((action) => bridge.stage(action));
      return { progress: items.length > 0, summary: items.length ? `已规划 ${items.length} 个待确认浏览器动作：${plan.summary}` : `没有生成安全动作：${plan.summary}`, data: { actionIds: items.map((item) => item.id) } };
    }
  }
];

async function observeAgentState() {
  const workflow = store.state.workflow;
  return {
    now: new Date().toISOString(),
    provider: {
      configured: store.state.provider.configured,
      mode: store.state.provider.mode,
      model: store.state.provider.model,
      baseURL: store.state.provider.baseURL
    },
    extension: bridge.publicState(),
    candidate: {
      status: store.state.candidate.status,
      targetRoles: store.state.candidate.targetRoles,
      locations: store.state.candidate.locations,
      salaryFloorK: store.state.candidate.salaryFloorK,
      salaryUpperTargetK: store.state.candidate.salaryUpperTargetK
    },
    resume: {
      auditStatus: workflow.resumeAuditStatus,
      optimizationStatus: workflow.resumeOptimizationStatus,
      applyStatus: workflow.resumeApply?.status,
      message: workflow.resumeApply?.message || workflow.resumeAuditMessage || ""
    },
    jobSearch: {
      status: workflow.autopilot?.status,
      target: workflow.autopilot?.targetApplications,
      discovered: workflow.autopilot?.discovered,
      analyzed: workflow.autopilot?.analyzed,
      selected: workflow.autopilot?.selected,
      sent: workflow.autopilot?.sent,
      message: workflow.autopilot?.message
    },
    jobs: {
      total: store.state.jobs.length,
      contacted: store.state.jobs.filter((job) => job.status === "sent").length,
      analyzed: store.state.jobs.filter((job) => job.analysis).length
    },
    pendingApprovals: store.state.actions.filter((item) => item.status === "waiting").length
  };
}

async function agentBackgroundStatus(waitFor) {
  if (waitFor === "job-search") {
    const autopilot = store.state.workflow.autopilot || {};
    const running = String(autopilot.status || "").startsWith("running-");
    return { done: !running, success: autopilot.status === "complete", progress: (autopilot.sent || 0) > 0, summary: jobSearchProgressContent() };
  }
  if (waitFor === "resume-rewrite") {
    const apply = store.state.workflow.resumeApply || {};
    const running = ["preparing", "running"].includes(apply.status)
      || store.state.workflow.resumeAuditStatus === "running"
      || store.state.workflow.resumeOptimizationStatus === "running";
    return { done: !running, success: apply.status === "complete", progress: (apply.verifiedFieldKeys?.length || 0) > 0, summary: apply.message || "自动修改简历运行中" };
  }
  return { done: true, success: false, progress: false, summary: `未知后台任务：${waitFor}` };
}

async function verifyAgentFinish({ task, observation }) {
  if (!isJobSearchExecutionIntent(task?.sourceText || task?.goal)) return { done: true };
  const startedSearch = (task?.steps || []).some((step) => step.tool === "search_and_apply_jobs");
  const jobSearch = observation?.jobSearch || {};
  const target = requestedApplicationTarget(task?.sourceText || task?.goal)
    || Number(jobSearch.target)
    || DEFAULT_AUTO_APPLY_TARGET;
  const sent = Number(jobSearch.sent) || 0;
  if (startedSearch && jobSearch.status === "complete" && sent >= target) return { done: true };
  return {
    done: false,
    message: startedSearch
      ? `求职目标尚未完成：已验证沟通 ${sent}/${target}，Agent 将继续观察并规划下一步`
      : "尚未启动真实岗位搜索与投递，不能只输出计划后结束"
  };
}

tenantRuntime.setAgentFactory((tenant) => new GoalAgentRuntime({
  store: tenant.store,
  ai: new AIService(tenant.store),
  tools: agentTools,
  observe: observeAgentState,
  waitStatus: agentBackgroundStatus,
  verifyFinish: verifyAgentFinish,
  runInContext: (callback) => tenantRuntime.run(tenant, callback)
}));

async function routeToAgent(messages) {
  const agentRuntime = tenantRuntime.agentRuntime();
  const sourceText = messages.at(-1)?.content || "";
  const route = await ai.routeAgentRequest(sourceText, agentRuntime.catalog(), store.state.workflow.agent);
  const executableGoal = isJobSearchExecutionIntent(sourceText);
  if (route.kind !== "agent" && !executableGoal) return null;
  const task = agentRuntime.start({ goal: route.kind === "agent" ? (route.goal || sourceText) : sourceText, sourceText, scopes: agentAuthorizationScopes(sourceText) });
  return {
    content: `已把目标交给求职 Agent：${task.goal}\n它会持续观察状态、动态规划下一步并从工具底座选择动作；只按可验证进度结束。涉及未授权的外部发送、简历写入或敏感决定时会暂停向你确认。`,
    action: { kind: "agent", runId: task.runId }
  };
}

app.post("/api/chat", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").slice(0, 20_000)
    })) : [];
    if (!messages.length) return res.status(400).json({ error: "请输入问题" });
    if (!store.secrets.apiKey) return res.status(400).json({ error: "请先在设置中填写模型 API Key" });
    const mode = ["general", "resume", "matching", "reply"].includes(req.body.mode) ? req.body.mode : "general";
    const agentResult = await routeToAgent(messages);
    if (agentResult) {
      saveConversation(mode, messages, agentResult.content);
      return res.json(agentResult);
    }
    const content = await ai.complete(messages, mode);
    saveConversation(mode, messages, content);
    res.json({ content });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/chat/stream", async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-20).map((message) => ({
    role: message.role === "assistant" ? "assistant" : "user",
    content: String(message.content || "").slice(0, 20_000)
  })) : [];
  if (!messages.length) return res.status(400).json({ error: "请输入问题" });
  const mode = ["general", "resume", "matching", "reply"].includes(req.body.mode) ? req.body.mode : "general";
  if (!store.secrets.apiKey) return res.status(400).json({ error: "请先在设置中填写模型 API Key" });
  let agentResult;
  try {
    agentResult = await routeToAgent(messages);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.flushHeaders();
  let content = "";
  try {
    if (agentResult) {
      if (res.destroyed) return;
      res.write(`${JSON.stringify({ type: "action", action: agentResult.action })}\n`);
      res.write(`${JSON.stringify({ type: "delta", delta: agentResult.content })}\n`);
      saveConversation(mode, messages, agentResult.content);
      return res.end(`${JSON.stringify({ type: "done", content: agentResult.content })}\n`);
    }
    for await (const delta of ai.stream(messages, mode)) {
      if (res.destroyed) return;
      content += delta;
      res.write(`${JSON.stringify({ type: "delta", delta })}\n`);
    }
    if (res.destroyed) return;
    saveConversation(mode, messages, content);
    res.end(`${JSON.stringify({ type: "done", content })}\n`);
  } catch (error) {
    if (!res.destroyed) res.end(`${JSON.stringify({ type: "error", error: error.message })}\n`);
  }
});

app.post("/api/agent/stop", (_req, res) => {
  const agentRuntime = tenantRuntime.agentRuntime();
  const task = agentRuntime.stop();
  if (String(store.state.workflow.autopilot?.status || "").startsWith("running-")) {
    setAutopilot({ stopRequested: true, message: "Agent 已请求在当前安全边界后停止自动找工作…" });
  }
  res.json({ agent: task, autopilot: store.state.workflow.autopilot });
});

app.patch("/api/candidate", (req, res) => {
  const allowed = ["displayName", "status", "github", "resumePath", "resumeText", "targetRoles", "locations", "salaryFloorK", "salaryUpperTargetK", "facts"];
  store.update((state) => {
    for (const key of allowed) {
      if (req.body[key] !== undefined) state.candidate[key] = req.body[key];
    }
  });
  store.addActivity("候选人资料已更新");
  res.json(store.state.candidate);
});

app.post("/api/workflow/start", async (_req, res) => {
  try {
    const tab = await bridge.execute({ kind: "openBossResume" });
    const startedAt = store.state.workflow.startedAt || new Date().toISOString();
    setWorkflow({ startedAt });
    const runId = startAutomaticResumeAudit(tab.id);
    store.addActivity("首次流程：已打开 BOSS 在线简历，开始自动读取与审查");
    res.status(202).json({ runId, workflow: store.state.workflow });
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/resume/audit", async (_req, res) => {
  try {
    const tabId = Number(store.state.workflow.resumeTabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return res.status(400).json({ error: "没有可恢复的 BOSS 简历标签，请点击“重新打开简历”" });
    }
    const runId = startAutomaticResumeAudit(tabId);
    store.addActivity("在线简历自动审查已重试");
    res.status(202).json({ runId, workflow: store.state.workflow });
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/resume/auto", async (req, res) => {
  if (req.body?.approved !== true) {
    return res.status(400).json({ error: "需要先确认本次自动修改简历" });
  }
  try {
    const result = await beginAutomaticResumeRewrite();
    res.status(202).json({ ...result, workflow: store.state.workflow });
  } catch (error) {
    res.status(/已经在运行/.test(error.message) ? 409 : 400).json({ error: error.message });
  }
});

app.post("/api/workflow/resume/optimize", (_req, res) => {
  if (store.state.workflow.resumeOptimizationStatus === "running") {
    return res.status(409).json({ error: "AI 正在生成简历优化稿" });
  }
  const tabId = Number(store.state.workflow.resumeTabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    return res.status(400).json({ error: "没有可读取的 BOSS 简历标签，请重新打开简历" });
  }
  const runId = crypto.randomUUID();
  setResumeApply({
    status: "idle",
    runId: null,
    message: "新优化稿生成中，尚未写入 BOSS",
    appliedFields: [],
    skippedFields: [],
    verifiedFieldKeys: [],
    updatedFieldKeys: [],
    optimizationGeneratedAt: null,
    startedAt: null,
    completedAt: null
  });
  setWorkflow({
    phase: "resume-optimizing",
    resumeOptimizationStatus: "running",
    resumeOptimizationMessage: "正在读取在线简历并生成优化稿…",
    resumeOptimizationRunId: runId,
    lastError: ""
  });
  store.addActivity("开始生成 AI 简历优化稿");
  queueMicrotask(() => runResumeOptimization(runId, tabId));
  res.status(202).json({ runId, workflow: store.state.workflow });
});

app.post("/api/workflow/resume/apply-optimization", async (req, res) => {
  if (req.body?.approved !== true) {
    return res.status(400).json({ error: "需要先确认本次 BOSS 在线简历修改" });
  }
  if (store.state.workflow.resumeApply?.status === "running") {
    return res.status(409).json({ error: "BOSS 在线简历正在修改中" });
  }
  if (store.state.workflow.resumeOptimizationStatus === "running") {
    return res.status(409).json({ error: "新优化稿仍在生成，请生成完成后再执行修改" });
  }
  const optimization = store.state.workflow.resumeOptimization;
  const writePlan = buildResumeWritePlan(optimization, store.state.candidate);
  const writableCount = Number(Boolean(writePlan.personalAdvantage)) + writePlan.workExperience.length + writePlan.projectExperience.length + Number(Boolean(writePlan.skills));
  if (!writableCount) {
    return res.status(400).json({ error: "当前优化稿没有可安全自动写入的字段" });
  }
  try {
    let tabId = Number(store.state.workflow.resumeTabId);
    const tabs = await bridge.execute({ kind: "listTabs" });
    const storedTab = tabs.find((tab) => tab.id === tabId);
    let storedTabIsResume = false;
    try {
      const storedUrl = new URL(storedTab?.url || "");
      storedTabIsResume = /(^|\.)zhipin\.com$/i.test(storedUrl.hostname) && /\/web\/geek\/resume|\/web\/user/.test(storedUrl.pathname);
    } catch { /* stale or internal tab will be replaced below */ }
    if (!Number.isInteger(tabId) || tabId <= 0 || !storedTabIsResume) {
      const tab = await bridge.execute({ kind: "openBossResume" });
      tabId = tab.id;
      setWorkflow({ resumeTabId: tabId });
      store.addActivity("原 BOSS 简历标签已关闭，已自动重新打开在线简历");
    } else {
      await bridge.execute({ kind: "activateTab", tabId });
    }
    const runId = crypto.randomUUID();
    setResumeApply({
      status: "running",
      runId,
      message: "BOSS 在线简历已打开，正在等待页面加载…",
      appliedFields: [],
      skippedFields: [],
      verifiedFieldKeys: [],
      updatedFieldKeys: [],
      optimizationGeneratedAt: optimization?.generatedAt || null,
      startedAt: new Date().toISOString(),
      completedAt: null
    });
    setWorkflow({ phase: "resume-applying", lastError: "" });
    store.addActivity("已获用户确认，开始自动写入 BOSS 在线简历");
    queueMicrotask(() => runResumeApply(runId, tabId));
    res.status(202).json({ runId, tabId, writableCount, workflow: store.state.workflow });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/resume/open-existing", async (_req, res) => {
  try {
    const tabId = Number(store.state.workflow.resumeTabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return res.status(400).json({ error: "BOSS 简历标签已失效，请重新打开" });
    const tab = await bridge.execute({ kind: "activateTab", tabId });
    res.json({ tab });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/resume/continue", async (req, res) => {
  try {
    const decision = req.body?.decision === "optimized" ? "optimized" : "continue";
    await bridge.execute({ kind: "openBossJobs" });
    setWorkflow({ phase: "search-open", resumeDecision: decision, lastError: "" });
    store.addActivity(`首次流程：${decision === "optimized" ? "简历已确认优化" : "保留当前简历"}，进入岗位搜索`);
    res.json(statePayload());
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/search/open", async (_req, res) => {
  try {
    await bridge.execute({ kind: "openBossJobs" });
    setWorkflow({ phase: "search-open", lastError: "" });
    res.json(statePayload());
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/search/scan", async (req, res) => {
  try {
    const page = await bridge.execute({ kind: "inspect" });
    if (page.adapter !== "boss-zhipin" || page.pageType !== "job-list") {
      return res.status(400).json({ error: "当前标签页不是 BOSS 职位列表。请先完成搜索或筛选，再点击扫描。" });
    }
    const candidates = jobCandidatesFromPage(page);
    const added = [];
    store.update((state) => {
      for (const candidate of candidates) {
        if (state.jobs.some((job) => sameJobUrl(job.url, candidate.url))) continue;
        state.jobs.unshift(candidate);
        added.push(candidate);
      }
    });
    const search = {
      ...store.state.workflow.search,
      keyword: String(req.body?.keyword || store.state.workflow.search.keyword || "AI Agent").slice(0, 80),
      discovered: store.state.workflow.search.discovered + added.length,
      analyzed: store.state.jobs.filter((job) => job.analysis).length
    };
    setWorkflow({ phase: "shortlist", search, lastError: "" });
    store.addActivity(`首次流程：职位列表新增 ${added.length} 个候选，等待读取完整 JD`);
    res.json({ added, duplicates: candidates.length - added.length, workflow: store.state.workflow });
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/search/open-next", async (_req, res) => {
  try {
    const job = store.state.jobs.find((entry) => entry.status === "captured" && entry.url && !entry.analysis);
    if (!job) return res.status(400).json({ error: "当前没有待读取的候选岗位，请回到职位列表继续扫描。" });
    await bridge.execute({ kind: "openBossJob", url: job.url });
    setWorkflow({ phase: "job-open", currentJobId: job.id, lastError: "" });
    store.addActivity(`首次流程：已打开候选岗位 ${job.company} / ${job.title}`);
    res.json({ job, workflow: store.state.workflow });
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/search/analyze-current", async (_req, res) => {
  try {
    const page = await bridge.execute({ kind: "inspect" });
    if (page.adapter !== "boss-zhipin" || page.pageType !== "job-detail") {
      return res.status(400).json({ error: "当前标签页不是 BOSS 职位详情。等待页面加载完成后再试。" });
    }
    const captured = jobFromPage(page);
    let job = store.state.jobs.find((entry) => sameJobUrl(entry.url, captured.url));
    if (!job && store.state.workflow.currentJobId) job = store.state.jobs.find((entry) => entry.id === store.state.workflow.currentJobId);
    if (job) {
      const updated = mergeJobInput(captured, job);
      Object.assign(job, updated, { description: captured.description, recruiter: captured.recruiter, source: captured.source });
      store.save();
    } else {
      job = captured;
      store.update((state) => state.jobs.unshift(job));
    }
    const analysis = await ai.analyzeJob(job);
    store.update(() => {
      job.analysis = analysis;
      job.score = analysis.score;
      job.greeting = analysis.greeting;
      job.status = analysis.verdict === "跳过" ? "skipped" : "analyzed";
      job.updatedAt = new Date().toISOString();
    });
    const search = { ...store.state.workflow.search, analyzed: store.state.jobs.filter((entry) => entry.analysis).length };
    setWorkflow({ phase: "shortlist", search, currentJobId: null, lastError: "" });
    store.addActivity(`首次流程：已读取完整 JD 并分析 ${job.company} / ${job.title}`);
    res.json({ job, workflow: store.state.workflow });
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/apply/prepare", (_req, res) => {
  const size = Math.max(1, Math.min(5, Number(store.state.workflow.batchSize) || 3));
  const eligible = [...store.state.jobs]
    .filter((job) => job.status === "analyzed" && Number(job.score) >= 70 && job.greeting && job.url)
    .sort((left, right) => right.score - left.score)
    .slice(0, size);
  if (!eligible.length) return res.status(400).json({ error: "还没有读取完整 JD 且达到 70 分的岗位。先逐个分析候选岗位。" });
  const batch = eligible.map((job) => ({ jobId: job.id, status: "ready" }));
  setWorkflow({ phase: "ready-to-apply", batch, lastError: "" });
  store.addActivity(`首次流程：已准备 ${batch.length} 个高匹配投递，等待逐条确认`);
  res.json({ batch, jobs: eligible, workflow: store.state.workflow });
});

app.post("/api/workflow/apply/open-next", async (_req, res) => {
  try {
    const entry = store.state.workflow.batch.find((item) => item.status === "ready");
    if (!entry) return res.status(400).json({ error: "当前批次没有待处理岗位" });
    const job = store.state.jobs.find((item) => item.id === entry.jobId);
    if (!job?.url) return res.status(400).json({ error: "岗位链接不可用" });
    await bridge.execute({ kind: "openBossJob", url: job.url });
    entry.status = "opened";
    store.save();
    setWorkflow({ phase: "apply-review", currentJobId: job.id, lastError: "" });
    store.addActivity(`首次流程：已打开待投岗位 ${job.company} / ${job.title}`);
    res.json({ job, workflow: store.state.workflow });
  } catch (error) {
    try { failWorkflow(error); } catch { /* persisted above */ }
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/autopilot/analyze", async (_req, res) => {
  if (String(store.state.workflow.autopilot.status).startsWith("running-")) return res.status(409).json({ error: "已经有一个托管任务在运行" });
  try {
    const result = await startAutopilotFromCurrentList();
    res.status(202).json({ ...result, workflow: store.state.workflow });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/autopilot/run", async (req, res) => {
  if (req.body?.approved !== true) return res.status(400).json({ error: "需要本人明确批准本批自动投递" });
  if (String(store.state.workflow.autopilot.status).startsWith("running-")) return res.status(409).json({ error: "已经有一个托管任务在运行" });
  try {
    const result = startAutomaticJobSearch(req.body?.targetApplications);
    res.status(202).json({ ...result, workflow: store.state.workflow });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/workflow/autopilot/apply-selected", (req, res) => {
  if (req.body?.approved !== true) return res.status(400).json({ error: "需要本人明确批准本次所选岗位" });
  if (String(store.state.workflow.autopilot.status).startsWith("running-")) return res.status(409).json({ error: "已经有一个托管任务在运行" });
  const available = new Set(store.state.workflow.autopilot.rankedJobIds || []);
  const selectedIds = [...new Set(Array.isArray(req.body?.jobIds) ? req.body.jobIds.map(String) : [])]
    .filter((id) => available.has(id));
  if (!selectedIds.length) return res.status(400).json({ error: "请至少选择一个已完成评分的岗位" });
  const runId = crypto.randomUUID();
  store.update((state) => {
    state.workflow.phase = "autopilot-running";
    state.workflow.batch = selectedIds.map((jobId) => ({ jobId, status: "approved" }));
  });
  setAutopilot({
    status: "running-apply",
    runId,
    stage: "applying",
    message: `已批准 ${selectedIds.length} 个岗位，开始逐条定制沟通`,
    selectedJobIds: selectedIds,
    selected: selectedIds.length,
    sent: 0,
    currentJobId: null,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    completedAt: null
  });
  store.addActivity(`用户已选择并批准投递 ${selectedIds.length} 个岗位`);
  queueMicrotask(() => runAutopilotApply(runId, selectedIds));
  res.status(202).json({ runId, selected: selectedIds.length, workflow: store.state.workflow });
});

app.post("/api/workflow/autopilot/stop", (_req, res) => {
  if (!String(store.state.workflow.autopilot.status).startsWith("running-")) return res.json({ workflow: store.state.workflow });
  setAutopilot({ stopRequested: true, message: "正在完成当前安全边界并停止…" });
  store.addActivity("用户请求停止托管投递");
  res.status(202).json({ workflow: store.state.workflow });
});

app.get("/api/jobs", (_req, res) => res.json(store.state.jobs));
app.post("/api/jobs", (req, res) => {
  const job = mergeJobInput(req.body, { id: crypto.randomUUID(), capturedAt: new Date().toISOString(), score: null, analysis: null, greeting: "" });
  store.update((state) => state.jobs.unshift(job));
  store.addActivity(`已保存岗位：${job.company} / ${job.title}`);
  res.status(201).json(job);
});

app.patch("/api/jobs/:id", (req, res) => {
  const index = store.state.jobs.findIndex((job) => job.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "岗位不存在" });
  const updated = mergeJobInput(req.body, store.state.jobs[index]);
  store.update((state) => { state.jobs[index] = updated; });
  res.json(updated);
});

app.post("/api/jobs/capture-current", async (_req, res) => {
  try {
    const page = await bridge.execute({ kind: "inspect" });
    const duplicate = store.state.jobs.find((job) => job.url === page.url);
    if (duplicate) return res.json({ job: duplicate, duplicate: true });
    const job = jobFromPage(page);
    store.update((state) => state.jobs.unshift(job));
    store.addActivity(`从 Chrome 捕获岗位：${job.title}`);
    res.status(201).json({ job, duplicate: false });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/jobs/discover-current", async (_req, res) => {
  try {
    const page = await bridge.execute({ kind: "inspect" });
    const candidates = jobCandidatesFromPage(page);
    const known = new Set(store.state.jobs.map((job) => job.url));
    const added = candidates.filter((job) => !known.has(job.url));
    if (added.length) store.update((state) => state.jobs.unshift(...added));
    store.addActivity(`从当前列表发现 ${added.length} 个新岗位`);
    res.json({ added, duplicates: candidates.length - added.length, page: { title: page.title, url: page.url } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/jobs/:id/analyze", async (req, res) => {
  const job = store.state.jobs.find((entry) => entry.id === req.params.id);
  if (!job) return res.status(404).json({ error: "岗位不存在" });
  try {
    const analysis = await ai.analyzeJob(job);
    store.update(() => {
      job.analysis = analysis;
      job.score = analysis.score;
      job.greeting = analysis.greeting;
      job.status = analysis.verdict === "跳过" ? "skipped" : "analyzed";
      job.updatedAt = new Date().toISOString();
    });
    store.addActivity(`完成岗位分析：${job.company} / ${job.title}`);
    res.json(job);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/jobs/:id/queue-greeting", (req, res) => {
  const job = store.state.jobs.find((entry) => entry.id === req.params.id);
  if (!job) return res.status(404).json({ error: "岗位不存在" });
  const value = String(req.body?.value || job.greeting || "").trim();
  if (!value) return res.status(400).json({ error: "该岗位还没有招呼语" });
  const item = bridge.stage({
    kind: "type",
    selector: req.body?.selector,
    value,
    reason: `为 ${job.company} 的 ${job.title} 填写定制招呼语`
  });
  res.status(202).json(item);
});

app.post("/api/browser/command", async (req, res) => {
  try {
    if (CONTROLLED.has(req.body?.kind)) return res.status(202).json(bridge.stage(req.body));
    res.json(await bridge.execute(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/browser/plan", async (req, res) => {
  const instruction = String(req.body?.instruction || "").trim().slice(0, 1200);
  if (!instruction) return res.status(400).json({ error: "请描述希望在当前页面完成的事情" });
  try {
    const page = await bridge.execute({ kind: "inspect" });
    const plan = await ai.planBrowserTask(instruction, page);
    const items = plan.actions.map((action) => bridge.stage(action));
    if (items.length) store.addActivity(`已生成浏览器操作计划：${plan.summary || instruction}`);
    res.status(202).json({ ...plan, items });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/boss/draft-reply", async (_req, res) => {
  try {
    const page = await bridge.execute({ kind: "inspect" });
    if (page.adapter !== "boss-zhipin" || page.pageType !== "chat" || !page.boss?.chat) {
      return res.status(400).json({ error: "当前不是可识别的 BOSS 直聘沟通页面" });
    }
    const reply = await ai.draftBossReply(page.boss.chat);
    let item = null;
    if (!reply.needsConfirmation && reply.draft && page.boss.chat.composer?.selector) {
      item = bridge.stage({
        kind: "type",
        selector: page.boss.chat.composer.selector,
        value: reply.draft,
        reason: `为 ${page.boss.chat.recruiter || "当前招聘方"} 填写经事实边界检查的回复草稿`
      });
    }
    store.addActivity(reply.needsConfirmation ? "BOSS 回复需要本人决定" : "已生成 BOSS 安全回复草稿");
    res.status(202).json({ reply, item, chat: { recruiter: page.boss.chat.recruiter, jobTitle: page.boss.chat.jobTitle, company: page.boss.chat.company } });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/actions/:id/approve", async (req, res) => {
  try { res.json(await bridge.approve(req.params.id)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post("/api/actions/:id/reject", (req, res) => {
  try { res.json(bridge.reject(req.params.id)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post("/api/automation/pause", (_req, res) => {
  bridge.paused = true;
  store.addActivity("已暂停浏览器操作");
  res.json(statePayload());
});
app.post("/api/automation/resume", (_req, res) => {
  bridge.paused = false;
  store.addActivity("已恢复浏览器操作");
  res.json(statePayload());
});

app.get("/api/export", (_req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename="jobdeck-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(store.publicState());
});

app.use(express.static(path.join(root, "web"), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, max-age=0")
}));
app.use((_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.sendFile(path.join(root, "web", "index.html"));
});

server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  const access = multiUserMode ? " (multi-user login required)" : remoteMode ? " (access token required)" : "";
  process.stderr.write(`JobDeck is ready at http://${DEFAULT_HOST}:${DEFAULT_PORT}${access}\n`);
});

export { app, bridge, server, store };
