import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
const bossAdapter = await readFile(new URL("../extension/boss-adapter.js", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");

test("automatic BOSS workflow does not directly navigate, open job URLs, or mutate DOM controls", () => {
  const start = source.indexOf("async function openBossJobList");
  const end = source.indexOf("if (String(store.state.workflow.autopilot?.status)");
  assert.ok(start >= 0 && end > start, "automatic workflow source range is present");
  const workflow = source.slice(start, end);

  for (const forbidden of [
    /kind:\s*["']navigate["']/,
    /kind:\s*["']openBossJob["']/,
    /kind:\s*["']click["']/,
    /kind:\s*["']type["']/,
    /kind:\s*["']mouseMove["']/
  ]) {
    assert.doesNotMatch(workflow, forbidden);
  }
  assert.match(workflow, /kind:\s*["']computerClick["']/);
  assert.match(workflow, /kind:\s*["']computerType["']/);
  assert.match(workflow, /selectSavedBossExpectation\(runId, tab\.id, page, location, keyword\)/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("async function selectBossJobCard")), /selectExpectedBossLocation\(runId, tab\.id, page, location\)/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("async function selectBossJobCard")), /bossSearchInput\(page\)/);
});

test("automatic BOSS workflow tolerates a temporarily empty page inspection", () => {
  const start = source.indexOf("async function waitForBossPage");
  const end = source.indexOf("function bossSearchInput");
  assert.ok(start >= 0 && end > start, "page wait helper source range is present");
  const helper = source.slice(start, end);

  assert.match(helper, /if \(!lastPage\) continue;/);
  assert.match(helper, /if \(!lastPage\) \{/);
  assert.match(source, /page\?\.adapter === "boss-zhipin"/);
  assert.doesNotMatch(helper, /加载超时，已停止本批次/);
});

test("a single job detail timeout is recoverable and does not stop the whole batch", () => {
  assert.match(source, /function fatalAutopilotError/);
  assert.match(source, /async function recoverBossListAfterCandidateError/);
  assert.match(source, /if \(fatalAutopilotError\(error\)\) throw error/);
  assert.doesNotMatch(source, /本人处理\|验证码\|登录\|扩展\|已停止\|暂停\|无法返回职位列表/);
});

test("job detail selection retries and verifies multiple independent signals", () => {
  const start = source.indexOf("async function selectBossJobCard");
  const end = source.indexOf("function upsertDetailedJob", start);
  const selection = source.slice(start, end);
  assert.match(selection, /attempt === 0 \|\| attempt === 6 \|\| attempt === 12/);
  assert.match(selection, /bossJobDetailMatches/);
  assert.match(selection, /detailUrlMatches \|\| selectedCardMatches/);
});

test("compact BOSS inspection keeps the visible contact action", () => {
  assert.match(bossAdapter, /communicationElements/);
  assert.match(bossAdapter, /立即沟通\|继续沟通\|去沟通\|进入沟通\|打开聊天/);
  assert.match(bossAdapter, /留在此页\|返回职位\|关闭\|取消/);
  assert.match(bossAdapter, /立即申请\|投递简历\|申请职位/);
  assert.match(bossAdapter, /\.\.\.communicationElements/);
});

test("BOSS inspection exposes saved role and city expectations", () => {
  assert.match(bossAdapter, /expectationPattern/);
  assert.match(bossAdapter, /expectationOptions: expectationElements/);
  assert.match(bossAdapter, /activeExpectation/);
  assert.match(bossAdapter, /全栈工程师/);
});

test("Computer Use cursor remains visible between actions", () => {
  const cursorStart = serviceWorker.indexOf("const ensureCursor");
  const cursorEnd = serviceWorker.indexOf("const pulseCursor", cursorStart);
  const cursorSource = serviceWorker.slice(cursorStart, cursorEnd);
  assert.match(cursorSource, /opacity:\s*"1"/);
  assert.doesNotMatch(cursorSource, /setTimeout\(\(\)\s*=>\s*\{\s*cursor\.style\.opacity\s*=\s*"0"/);
});

test("automatic BOSS workflow re-observes and replans intermediate pages", () => {
  assert.match(source, /async function adaptiveBossComposer/);
  assert.match(source, /智能规划第/);
  assert.match(source, /await ai\.planBrowserTask/);
  assert.match(source, /SAFE_BOSS_TRANSITION/);
  assert.match(source, /kind:\s*"computerMove"/);
  assert.match(source, /kind:\s*"computerClick"/);
  assert.match(source, /平台只发送了默认招呼，尚未找到会话输入框；定制消息未发送且不会计入成功/);
  assert.doesNotMatch(source, /recordBossJobSent\(job, "platform-default"\)/);
  assert.doesNotMatch(source, /未重复发送定制消息/);
  assert.doesNotMatch(source.slice(source.indexOf("async function adaptiveBossComposer"), source.indexOf("function recordBossJobSent")), /bridge\.execute\(\{ kind: "click"/);
});

test("automatic job search is progress-driven until the requested verified-contact target", () => {
  const start = source.indexOf("async function runAutomaticJobSearch");
  const end = source.indexOf("async function startAutopilotFromCurrentList", start);
  const workflow = source.slice(start, end);
  assert.match(source, /DEFAULT_AUTO_APPLY_TARGET = 60/);
  assert.match(source, /Math\.min\(500, Math\.max\(1, requested\)\)/);
  assert.doesNotMatch(source, /Math\.max\(DEFAULT_AUTO_APPLY_TARGET/);
  assert.match(workflow, /autopilot\.sent < targetApplications/);
  assert.match(workflow, /plansWithoutProgress < plans\.length/);
  assert.match(source, /async function advanceBossJobResults/);
  assert.match(source, /kind: "computerBack"/);
  assert.match(source, /kind: "computerScroll"/);
  assert.doesNotMatch(workflow, /\.slice\(0, 6\)/);
  assert.match(workflow, /candidateMatchesExpectedLocation\(candidate, activeLocation\)/);
  assert.match(workflow, /candidateMatchesExpectedLocation\(job, activeLocation\)/);
  assert.match(workflow, /await verifyAutopilotProvider\(runId\)/);
  assert.match(source, /正在验证 Sub2API 模型与账号分组/);
  assert.match(source, /API Key is not assigned to any group/);
});

test("saved BOSS expectations require the visible city filter to actually change", () => {
  const start = source.indexOf("async function selectSavedBossExpectation");
  const end = source.indexOf("async function selectExpectedBossLocation", start);
  const selection = source.slice(start, end);
  assert.match(selection, /currentLocation === expectation\.location/);
  assert.match(selection, /locationFilter\?\.label !== expectation\.location/);
  assert.match(selection, /selectExpectedBossLocation\(runId, tabId, nextPage, expectation\.location\)/);
  assert.match(selection, /Clicking the expectation again opens BOSS's mixed recommendation feed/);
  assert.doesNotMatch(selection, /filterMatches \|\| cardsMatch/);
});

test("BOSS city controls accept 市 suffixes and a wider real-Chrome filter strip", () => {
  assert.match(bossAdapter, /\.replace\(\/市\$\/, ""\)/);
  assert.match(bossAdapter, /item\.point\.x < 900/);
  assert.match(bossAdapter, /item\.point\.y < 280/);
});

test("Computer Use activates the controlled Chrome tab before visible input", () => {
  assert.match(serviceWorker, /await chrome\.tabs\.update\(tab\.id, \{ active: true \}\)/);
});

test("Chrome Computer Use can go back through real browser history", () => {
  assert.match(serviceWorker, /action\.kind === "computerBack"/);
  assert.match(serviceWorker, /key: "ArrowLeft"/);
  assert.match(serviceWorker, /modifiers: 1/);
});
