import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [bossAdapter, sidepanelHtml, sidepanel, serviceWorker, serverIndex] = await Promise.all([
  readFile(new URL("../extension/boss-adapter.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/sidepanel.html", import.meta.url), "utf8"),
  readFile(new URL("../extension/sidepanel.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../server/index.mjs", import.meta.url), "utf8")
]);

test("BOSS chat snapshots expose only an unambiguous stable job URL", () => {
  assert.match(bossAdapter, /const stableBossJobUrl/);
  assert.match(bossAdapter, /url\.protocol !== "https:"/);
  assert.match(bossAdapter, /zhipin\\\.com/);
  assert.match(bossAdapter, /job_detail\|\\\/job\\\//);
  assert.match(bossAdapter, /return `\$\{url\.origin\}\$\{url\.pathname\}`/);
  assert.match(bossAdapter, /preferredJobUrls\.length === 1/);
  assert.match(bossAdapter, /preferredJobUrls\.length === 0 && allJobUrls\.length === 1/);
  assert.match(bossAdapter, /jobUrl,/);
});

test("BOSS chat snapshots merge every message selector family in DOM order", () => {
  const start = bossAdapter.indexOf("const primaryMessageSelectors");
  const end = bossAdapter.indexOf("const chatRoot", start);
  assert.ok(start >= 0 && end > start, "message collection source is present");
  const collection = bossAdapter.slice(start, end);

  assert.match(collection, /\.\.\.primaryMessageSelectors, \.\.\.fallbackMessageSelectors/);
  assert.match(collection, /\.flatMap\(\(selector\) => visibleFor\(selector\)\)/);
  assert.match(collection, /new Set\(/);
  assert.match(collection, /compareDocumentPosition/);
  assert.doesNotMatch(collection, /break;/);

  const recordsStart = bossAdapter.indexOf("const deduped = []", end);
  const recordsEnd = bossAdapter.indexOf("const messages =", recordsStart);
  const dedupe = bossAdapter.slice(recordsStart, recordsEnd);
  assert.match(dedupe, /identityRank/);
  assert.match(dedupe, /idSource === "attribute"/);
  assert.match(dedupe, /deduped\[duplicateIndex\] = record/);
});

test("BOSS chat snapshots preserve platform cards as a blocking system record", () => {
  assert.match(bossAdapter, /systemMessage\(element, text\) \? "system" : messageFrom\(element\)/);
  assert.doesNotMatch(bossAdapter, /if \(systemMessage\(element, text\)\) return \[\]/);
  assert.match(bossAdapter, /latestSenderUnknown/);
});

test("the BOSS chat action names the complete JD-aware automatic reply", () => {
  assert.match(sidepanelHtml, />按 JD 检查并自动回复<\/button>/);
});

test("the side panel presents every automatic-reply outcome", () => {
  for (const status of [
    "sent",
    "needs-confirmation",
    "waiting",
    "ignored",
    "duplicate",
    "missing-jd",
    "busy",
    "error"
  ]) {
    assert.ok(sidepanel.includes(`${JSON.stringify(status)}:`) || sidepanel.includes(`${status}:`), `${status} is presented`);
  }
  assert.match(sidepanel, /button\.disabled = true/);
  assert.match(sidepanel, /finally \{\s*button\.disabled = false/);
});

test("the background worker checks authorized BOSS chats about every 30 seconds", () => {
  assert.match(serviceWorker, /BOSS_AUTO_REPLY_ALARM/);
  assert.match(serviceWorker, /periodInMinutes: 0\.5/);
  assert.match(serviceWorker, /chrome\.tabs\.query\(\{\}\)/);
  assert.match(serviceWorker, /isBossChatUrl\(tab\.url\)/);
  assert.match(serviceWorker, /hasSiteAccess\(originOf\(tab\.url\)\)/);
  assert.match(serviceWorker, /\/api\/boss\/draft-reply/);
  assert.match(serviceWorker, /"X-JobDeck-Token": config\.token/);
  assert.match(serviceWorker, /const target = bossReplyRequestTarget\(page, tab\.id\)/);
  assert.match(serviceWorker, /body: JSON\.stringify\(\{ source: "extension-poll", \.\.\.target \}\)/);
});

test("background reply preflight binds the request to one tab, conversation and message snapshot", () => {
  const targetStart = serviceWorker.indexOf("function bossReplyRequestTarget");
  const targetEnd = serviceWorker.indexOf("async function recordBossAutoReplyPoll", targetStart);
  assert.ok(targetStart >= 0 && targetEnd > targetStart, "reply target builder is present");
  const target = serviceWorker.slice(targetStart, targetEnd);
  assert.match(target, /tabId: Number\(tabId\)/);
  assert.match(target, /conversationId: normalizedBossReplyTargetText\(chat\.conversationId/);
  assert.match(target, /fingerprint: bossReplyTargetFingerprint\(chat\)/);
  assert.match(target, /target\.tabId.*target\.conversationId.*target\.fingerprint/s);

  const pollStart = serviceWorker.indexOf("async function pollBossAutoReply");
  const pollEnd = serviceWorker.indexOf("const delay =", pollStart);
  const poll = serviceWorker.slice(pollStart, pollEnd);
  assert.ok(poll.indexOf("inspectBossTab(tab.id, false)") < poll.indexOf("bossReplyRequestTarget(page, tab.id)"));
  assert.ok(poll.indexOf("bossReplyRequestTarget(page, tab.id)") < poll.indexOf("/api/boss/draft-reply"));
});

test("automatic reply polling never starts while the user has composer text", () => {
  const start = serviceWorker.indexOf("async function pollBossAutoReply");
  const end = serviceWorker.indexOf("const delay =", start);
  assert.ok(start >= 0 && end > start, "poll helper source is present");
  const poll = serviceWorker.slice(start, end);
  const composerGuard = poll.indexOf("if (composerValue)");
  const request = poll.indexOf("/api/boss/draft-reply");
  assert.ok(composerGuard >= 0 && request > composerGuard, "composer guard runs before the API request");
  assert.match(poll.slice(composerGuard, request), /return;/);
  assert.match(poll, /bossAutoReplyPollInFlight/);
});

test("the server drafts from the resolved full JD and verifies a real Computer Use send", () => {
  const start = serverIndex.indexOf("async function processCurrentBossReply");
  const end = serverIndex.indexOf("const SAFE_BOSS_TRANSITION", start);
  assert.ok(start >= 0 && end > start, "automatic reply workflow source is present");
  const flow = serverIndex.slice(start, end);

  assert.match(flow, /let resolution = resolvedReplyJob\(chatState\)/);
  assert.match(flow, /ai\.draftBossReply\(\{ chat, job, latestInbound: chatState\.message \}\)/);
  assert.match(flow, /reply\.needsConfirmation/);
  assert.match(flow, /sendVerifiedBossReply\(\{ page, tabId, chatState, job, reply: reply\.draft, replyTarget \}\)/);

  const sendStart = serverIndex.indexOf("async function sendVerifiedBossReply");
  const sendEnd = serverIndex.indexOf("async function processCurrentBossReply", sendStart);
  const send = serverIndex.slice(sendStart, sendEnd);
  assert.match(send, /kind: "computerMove"/);
  assert.match(send, /kind: "computerClick"/);
  assert.match(send, /kind: "computerType"/);
  assert.match(send, /bossReplySendWasVerified/);
  assert.match(send, /输入框已有其他内容，未覆盖用户草稿/);
  assert.ok((send.match(/assertBossReplyTarget\(/g) || []).length >= 5, "target identity is rechecked around browser side effects");
  assert.match(send, /bossReplyTargetMatches\(candidatePage, lockedTarget, tabId\)/);
  assert.match(send, /requireLatest: false/);
});

test("a missing reply JD is hydrated from the authoritative chat job URL before drafting", () => {
  const hydrateStart = serverIndex.indexOf("async function hydrateReplyJobFromChat");
  const hydrateEnd = serverIndex.indexOf("async function sendVerifiedBossReply", hydrateStart);
  assert.ok(hydrateStart >= 0 && hydrateEnd > hydrateStart, "reply JD hydration helper is present");
  const hydrate = serverIndex.slice(hydrateStart, hydrateEnd);

  assert.match(hydrate, /kind:\s*["']openBossJob["']/);
  assert.match(hydrate, /url:\s*chatState\.chat\.jobUrl/);
  assert.match(hydrate, /kind:\s*["']inspect["'],\s*tabId:\s*opened\.id/);
  assert.match(hydrate, /sameJobUrl\(/);
  assert.match(hydrate, /upsertDetailedJob\(/);
  assert.match(hydrate, /kind:\s*["']activateTab["']/);
  assert.match(hydrate, /waitForBossReplyChat\(/);
  assert.match(hydrate, /bossRecruiterMessageState\(/);
  assert.match(hydrate, /fingerprint/);

  const flowStart = serverIndex.indexOf("async function processCurrentBossReply");
  const flowEnd = serverIndex.indexOf("const SAFE_BOSS_TRANSITION", flowStart);
  const flow = serverIndex.slice(flowStart, flowEnd);
  const resolution = flow.indexOf("resolvedReplyJob(chatState)");
  const hydration = flow.indexOf("hydrateReplyJobFromChat({ page, tabId, chatState, replyTarget })");
  const missingReturn = flow.indexOf('replyResult(status, resolution.reason');
  assert.ok(resolution >= 0, "reply job resolution runs first");
  assert.ok(hydration > resolution, "missing full JD triggers safe hydration");
  assert.ok(missingReturn > hydration, "the workflow returns missing-jd only after hydration was attempted");
});

test("automatic replies recover safely without duplicating a prior send", () => {
  assert.match(serverIndex, /autoReply\.pending\?\.phase === "drafting"/);
  assert.match(serverIndex, /pending\.phase === "send-clicked"/);
  assert.match(serverIndex, /为避免重复回复，已暂停并等待本人检查/);
  assert.match(serverIndex, /rememberAutoReplyBinding\(bossConversationKey\(verified\.page\.boss\.chat\), job\.id\)/);
});

test("the HTTP reply endpoint executes the verified workflow instead of staging a draft", () => {
  const start = serverIndex.indexOf('app.post("/api/boss/draft-reply"');
  const end = serverIndex.indexOf('app.post("/api/actions/:id/approve"', start);
  assert.ok(start >= 0 && end > start, "reply endpoint source is present");
  const route = serverIndex.slice(start, end);
  assert.match(route, /normalizeBossReplyTarget\(rawTarget\)/);
  assert.match(route, /source === "background" && !target/);
  assert.match(route, /processCurrentBossReply\(\{ source, target \}\)/);
  assert.doesNotMatch(route, /bridge\.stage/);
});

test("the server never discovers a different chat after an explicit reply target is supplied", () => {
  const inspectStart = serverIndex.indexOf("async function inspectBossReplyChat");
  const inspectEnd = serverIndex.indexOf("async function waitForBossReplyChat", inspectStart);
  const inspect = serverIndex.slice(inspectStart, inspectEnd);
  assert.match(inspect, /kind: "inspect", tabId: target\.tabId/);
  assert.match(inspect, /assertBossReplyTarget\(page, target, target\.tabId, "预检"\)/);

  const flowStart = serverIndex.indexOf("async function processCurrentBossReply");
  const flowEnd = serverIndex.indexOf("const SAFE_BOSS_TRANSITION", flowStart);
  const flow = serverIndex.slice(flowStart, flowEnd);
  assert.match(flow, /const requestedTarget = normalizeBossReplyTarget\(target\)/);
  assert.match(flow, /inspectBossReplyChat\(requestedTarget\)/);
  assert.match(flow, /const replyTarget = requestedTarget \|\| bossReplyTargetFromPage\(page, tabId\)/);
  assert.match(flow, /assertBossReplyTarget\(page, replyTarget, tabId, "读取招聘方消息"\)/);
  assert.match(flow, /replyTarget,/);
});
