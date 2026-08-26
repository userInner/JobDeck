import crypto from "node:crypto";

const FULL_JD_MIN_LENGTH = 120;

export function normalizeBossText(value, limit = 20_000) {
  return String(value || "")
    .replace(/[\uE031-\uE03A]/g, (character) => String(character.codePointAt(0) - 0xE031))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function canonicalWebUrl(value) {
  const raw = normalizeBossText(value, 1600);
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://www.zhipin.com");
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch {
    return "";
  }
}

function identityText(value) {
  return normalizeBossText(value, 300)
    .toLocaleLowerCase("zh-CN")
    .replace(/[（(]?j\d+[）)]?/gi, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function meaningfulIdentity(value) {
  const normalized = identityText(value);
  return /^(?:|未知|未知公司|待识别公司|公司待识别|待识别岗位)$/.test(normalized) ? "" : normalized;
}

function normalizedMessages(chat = {}) {
  return (Array.isArray(chat.messages) ? chat.messages : []).flatMap((message, index) => {
    const text = normalizeBossText(message?.text, 4000);
    const from = message?.from === "candidate"
      ? "candidate"
      : message?.from === "recruiter"
        ? "recruiter"
        : message?.from === "system"
          ? "system"
          : "unknown";
    if (!text) return [];
    return [{
      id: normalizeBossText(message?.id, 500),
      idSource: normalizeBossText(message?.idSource, 80),
      from,
      text,
      index
    }];
  });
}

export function bossConversationIdentity(chat = {}) {
  const conversationId = normalizeBossText(chat.conversationId, 500);
  if (conversationId) return `conversation-id:${conversationId}`;

  const jobUrl = canonicalWebUrl(chat.jobUrl);
  const recruiter = meaningfulIdentity(chat.recruiter);
  const company = meaningfulIdentity(chat.company);
  const jobTitle = meaningfulIdentity(chat.jobTitle);
  if (jobUrl && recruiter) {
    return [
      `job-url:${jobUrl}`,
      `recruiter:${recruiter}`,
      `company:${company}`,
      `job-title:${jobTitle}`
    ].join("|");
  }
  if (recruiter && company && jobTitle) {
    return `recruiter:${recruiter}|company:${company}|job-title:${jobTitle}`;
  }
  return "";
}

export function bossConversationKey(chat = {}) {
  const stableIdentity = bossConversationIdentity(chat);
  if (!stableIdentity) return "";
  return `boss:${digest(stableIdentity).slice(0, 32)}`;
}

export function bossMessageFingerprint(chat = {}, message) {
  const messages = normalizedMessages(chat);
  const target = message || messages.at(-1);
  if (!target) return "";
  const conversationKey = bossConversationKey(chat);
  if (!conversationKey) return "";
  const text = normalizeBossText(target.text, 4000);
  const id = normalizeBossText(target.id, 500);
  const idSource = normalizeBossText(target.idSource, 80);
  const hasDurableId = Boolean(id && /^(?:attribute|element-id)$/i.test(idSource));
  const occurrence = messages
    .filter((item) => item.index <= Number(target.index ?? Number.MAX_SAFE_INTEGER))
    .filter((item) => item.from === target.from && item.text === text)
    .length;
  const messageIdentity = hasDurableId ? `id:${id}` : `text:${text}|occurrence:${Math.max(occurrence, 1)}`;
  return `boss-message:${digest(`${conversationKey}|${target.from}|${messageIdentity}`)}`;
}

export function isBossRejectionOnly(value) {
  const text = normalizeBossText(value, 2000);
  if (!text) return false;
  const rejection = /(?:很遗憾|暂不合适|暂时不合适|不太合适|不匹配|暂不考虑|暂时不考虑|已招到|已招满|职位已关闭|岗位已关闭|停止招聘|感谢(?:您|你的)?投递|感谢关注|祝(?:您|你).{0,12}(?:求职|工作).{0,8}(?:顺利|成功))/i.test(text);
  if (!rejection) return false;
  const continuedConversation = /(?:是否|能否|可以|方便|意向|有兴趣|聊聊|沟通|其他岗位|另一个岗位|推荐.*岗位|\?|？)/i.test(text);
  return !continuedConversation;
}

function composerText(chat = {}) {
  const composer = chat.composer || {};
  return normalizeBossText(
    composer.valuePreview ?? composer.value ?? composer.text ?? composer.textContent ?? "",
    4000
  );
}

function fingerprintSet(value) {
  const output = new Set();
  const visit = (item, key = "") => {
    if (typeof item === "string") {
      const normalized = normalizeBossText(item, 500);
      if (normalized) output.add(normalized);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry) => visit(entry));
      return;
    }
    if (!item || typeof item !== "object") return;
    const direct = item.fingerprint || item.messageFingerprint || item.id;
    if (direct) visit(direct);
    for (const [entryKey, entryValue] of Object.entries(item)) {
      if (/^boss-message:[a-f0-9]{64}$/i.test(entryKey)) output.add(entryKey);
      if (entryValue === true && /^boss-message:[a-f0-9]{64}$/i.test(entryKey)) output.add(entryKey);
    }
  };
  visit(value);
  return output;
}

export function bossRecruiterMessageState(chat = {}, autoReply = {}) {
  const messages = normalizedMessages(chat);
  const latest = messages.at(-1) || null;
  const conversationKey = bossConversationKey(chat);
  if (!conversationKey) {
    return {
      status: "blocked",
      reason: "当前聊天缺少足够的会话身份，无法安全自动回复",
      conversationKey: "",
      fingerprint: "",
      message: latest
    };
  }
  if (!latest) {
    return { status: "waiting", reason: "没有提取到可处理的对话消息", conversationKey, fingerprint: "", message: null };
  }

  const fingerprint = bossMessageFingerprint(chat, latest);
  const base = { conversationKey, fingerprint, message: latest };
  if (latest.from !== "candidate" && latest.from !== "recruiter") {
    return { ...base, status: "blocked", reason: "最后一条记录是平台通知或来源不明，无法安全自动回复" };
  }
  if (latest.from === "candidate") {
    return { ...base, status: "waiting", reason: "最后一条消息由候选人发送，等待招聘方回复" };
  }
  if (isBossRejectionOnly(latest.text)) {
    return { ...base, status: "ignored", reason: "招聘方消息仅为拒绝或职位关闭通知" };
  }
  if (composerText(chat)) {
    return { ...base, status: "blocked", reason: "输入框已有未发送内容，避免覆盖用户草稿" };
  }

  const processed = fingerprintSet(autoReply.processed);
  for (const value of [autoReply.lastFingerprint, autoReply.processedFingerprint]) {
    if (value) processed.add(normalizeBossText(value, 500));
  }
  if (processed.has(fingerprint)) {
    return { ...base, status: "duplicate", reason: "该招聘方消息已经处理过" };
  }

  const pending = fingerprintSet(autoReply.pending);
  for (const value of [autoReply.pendingFingerprint, autoReply.inFlightFingerprint]) {
    if (value) pending.add(normalizeBossText(value, 500));
  }
  if (pending.has(fingerprint)) {
    return { ...base, status: "duplicate", reason: "该招聘方消息正在处理中", pending: true };
  }

  return { ...base, status: "eligible", reason: "发现一条尚未处理的招聘方消息" };
}

function hasFullDescription(job) {
  return normalizeBossText(job?.description, 30_000).length >= FULL_JD_MIN_LENGTH;
}

function updatedAtValue(job) {
  const value = Date.parse(job?.updatedAt || job?.capturedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function richestJob(jobs) {
  return [...jobs].sort((left, right) => (
    normalizeBossText(right?.description, 30_000).length - normalizeBossText(left?.description, 30_000).length
    || updatedAtValue(right) - updatedAtValue(left)
  ))[0] || null;
}

function distinctJobGroups(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = canonicalWebUrl(job?.url)
      || `${identityText(job?.title)}|${identityText(job?.company)}`;
    const group = groups.get(key) || [];
    group.push(job);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function resolved(job, matchedBy) {
  return { status: "resolved", matchedBy, job };
}

function ambiguous(jobs, matchedBy) {
  return {
    status: "ambiguous",
    matchedBy,
    reason: "存在多个可能的完整职位描述，无法安全确定当前对话对应的岗位",
    candidates: distinctJobGroups(jobs).map(richestJob)
  };
}

export function resolveBossReplyJob(chat = {}, jobs = []) {
  const allJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const completeJobs = allJobs.filter(hasFullDescription);
  const jobUrl = canonicalWebUrl(chat.jobUrl);

  if (jobUrl) {
    const urlMatches = completeJobs.filter((job) => canonicalWebUrl(job.url) === jobUrl);
    if (urlMatches.length) return resolved(richestJob(urlMatches), "job-url");

    // A URL exposed by the active BOSS conversation is the strongest job
    // identity we have. Falling back to a same-title historical job here can
    // produce a polished reply for the wrong role, so require the authoritative
    // URL to be hydrated instead.
    const incompleteUrlMatch = allJobs.some((job) => canonicalWebUrl(job.url) === jobUrl);
    return {
      status: "missing",
      matchedBy: "none",
      reason: incompleteUrlMatch
        ? `已找到对应岗位，但完整 JD 少于 ${FULL_JD_MIN_LENGTH} 个字符`
        : "当前对话对应的完整 JD 尚未读取",
      candidates: []
    };
  }

  const title = meaningfulIdentity(chat.jobTitle);
  const company = meaningfulIdentity(chat.company);
  if (title && company) {
    const identityMatches = completeJobs.filter((job) => (
      meaningfulIdentity(job.title) === title && meaningfulIdentity(job.company) === company
    ));
    const groups = distinctJobGroups(identityMatches);
    if (groups.length === 1) return resolved(richestJob(groups[0]), "title-company");
    if (groups.length > 1) return ambiguous(identityMatches, "title-company");
  }

  return {
    status: "missing",
    matchedBy: "none",
    reason: "没有找到能与当前对话唯一对应的完整 JD",
    candidates: []
  };
}
