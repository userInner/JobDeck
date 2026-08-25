import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
const defaultsSource = await readFile(new URL("../server/defaults.mjs", import.meta.url), "utf8");
const bossAdapter = await readFile(new URL("../extension/boss-adapter.js", import.meta.url), "utf8");
const serviceWorker = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");

function extractNamedFunction(code, name) {
  const plain = code.indexOf(`function ${name}(`);
  const async_ = code.indexOf(`async function ${name}(`);
  const start = [plain, async_].filter((value) => value >= 0).sort((left, right) => left - right)[0] ?? -1;
  assert.ok(start >= 0, `${name} source is present`);
  const bodyStart = code.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    if (code[index] === "}") depth -= 1;
    if (depth === 0) return code.slice(start, index + 1);
  }
  throw new Error(`${name} source is incomplete`);
}

test("automatic BOSS workflow does not directly navigate, open job URLs, or mutate DOM controls", () => {
  const start = source.indexOf("async function openBossJobList");
  const end = source.indexOf("async function startAutopilotFromCurrentList", start);
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
  assert.match(workflow, /selectSavedBossExpectation\(runId, tab\.id, page, expectationLabel, \{ force: forceExpectation \}\)/);
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
  assert.match(selection, /titleMatches && companyMatches/);
  assert.doesNotMatch(selection, /titleMatches && companyMatches && changed/);
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
  assert.match(source, /沟通入口未生效，原岗位重试/);
  assert.match(source, /contactRetries < 2/);
  assert.doesNotMatch(source, /recordBossJobSent\(job, "platform-default"\)/);
  assert.doesNotMatch(source, /未重复发送定制消息/);
  assert.doesNotMatch(source.slice(source.indexOf("async function adaptiveBossComposer"), source.indexOf("function recordBossJobSent")), /bridge\.execute\(\{ kind: "click"/);
});

test("contact workflow follows a BOSS chat tab and never silently advances after an unverified apply", () => {
  assert.match(source, /async function inspectBossPageFollowingTabs/);
  assert.match(source, /preferredPageTypes = \[\]/);
  assert.match(source, /tabId = transition\.tabId/);
  assert.match(source, /BOSS_APPLY_NOT_VERIFIED/);
  assert.match(source, /投递链路未完整验证，已暂停而不是跳到下一个 JD/);
  const start = source.indexOf("async function contactCurrentMatchedJobForGoal");
  const end = source.indexOf("async function startAutopilotFromCurrentList", start);
  const contact = source.slice(start, end);
  assert.match(contact, /goalToolAttention\(unverified, \{ preserveCurrentJob: true \}\)/);
});

test("goal-driven job search exposes bounded prepare, inspect, and contact tools", () => {
  assert.doesNotMatch(source, /async function runAutomaticJobSearch/);
  assert.match(source, /async function prepareJobSearchGoal/);
  assert.match(source, /async function inspectNextJobForGoal/);
  assert.match(source, /async function contactCurrentMatchedJobForGoal/);
  assert.match(source, /name:\s*"prepare_job_search_goal"/);
  assert.match(source, /name:\s*"inspect_next_job_for_goal"/);
  assert.match(source, /name:\s*"contact_current_matched_job"/);
  assert.doesNotMatch(source, /name:\s*"search_and_apply_jobs"/);
  assert.doesNotMatch(source, /waitFor:\s*"job-search"/);
});

test("goal-driven inspection processes only one fresh card before replanning", () => {
  const start = source.indexOf("async function inspectNextJobForGoal");
  const end = source.indexOf("async function contactCurrentMatchedJobForGoal", start);
  assert.ok(start >= 0 && end > start, "atomic inspection helper source range is present");
  const workflow = source.slice(start, end);
  assert.match(workflow, /const candidateId = resumablePending\?\.id \|\| persisted\.candidateIds\[0\]/,
    "an interrupted inspection resumes the same JD; otherwise exactly one fresh card is selected");
  assert.match(workflow, /seenUrls/);
  assert.doesNotMatch(workflow, /for \(const candidateId of persisted\.candidateIds\)/);
  assert.match(workflow, /currentJobId/);
  assert.doesNotMatch(workflow, /applyCurrentBossJob/);
});

test("one temporarily empty result page stays retryable instead of becoming terminal", () => {
  const start = source.indexOf("async function inspectNextJobForGoal");
  const end = source.indexOf("async function contactCurrentMatchedJobForGoal", start);
  const workflow = source.slice(start, end);
  const emptyStart = workflow.indexOf("if (!candidateId)");
  const emptyEnd = workflow.indexOf("const candidate =", emptyStart);
  const emptyResult = workflow.slice(emptyStart, emptyEnd);

  assert.ok(emptyStart >= 0 && emptyEnd > emptyStart, "empty-result recovery branch is present");
  assert.match(defaultsSource, /planCooldowns:\s*\{\}/,
    "empty scans have a finite retry ledger instead of a terminal exhausted-plan set");
  assert.match(emptyResult, /planCooldowns/,
    "an empty observation schedules a retry for the same saved expectation");
  assert.doesNotMatch(emptyResult, /exhaustedPlanKeys/,
    "an empty observation must not permanently remove a saved expectation from the goal");
  assert.doesNotMatch(emptyResult, /goalToolAttention/,
    "an ordinary empty result page is not a human-attention condition");
});

test("a confirmed city context is not clicked again and a temporarily empty list is never permanently exhausted", () => {
  const start = source.indexOf("async function inspectNextJobForGoal");
  const end = source.indexOf("async function contactCurrentMatchedJobForGoal", start);
  const workflow = source.slice(start, end);
  const stableStart = workflow.indexOf("tabId = Number.isInteger(tabId)");
  const candidateStart = workflow.indexOf("const candidate =", stableStart);
  const stableContext = workflow.slice(stableStart, candidateStart);
  const emptyStart = stableContext.indexOf("if (!candidateId)");
  const emptyContext = stableContext.slice(emptyStart);

  assert.ok(stableStart >= 0 && candidateStart > stableStart, "the already-confirmed expectation branch is present");
  assert.doesNotMatch(stableContext, /openBossJobList|selectSavedBossExpectation|selectExpectedBossLocation/,
    "once the visible expectation and city match, inspecting or retrying the list must not click them again");
  assert.doesNotMatch(emptyContext, /forceExpectation|selectSavedBossExpectation|selectExpectedBossLocation/,
    "an empty snapshot is an observation, not permission to repeat expectation or city clicks");

  assert.match(emptyContext, /planCooldowns/,
    "the empty-list branch records a finite retry time rather than a permanent exhaustion marker");
  assert.doesNotMatch(emptyContext, /exhaustedPlanKeys|goalToolAttention/,
    "temporary empty observations across all expectations must not permanently stop an unfinished numeric goal");

  const keySource = extractNamedFunction(source, "autopilotPlanKey");
  const chooserSource = extractNamedFunction(source, "nextAutopilotPlan");
  const choose = new Function(`${keySource}\n${chooserSource}\nreturn nextAutopilotPlan;`)();
  const now = Date.now();
  const plans = [
    { expectationLabel: "全栈工程师（北京）", role: "全栈工程师", location: "北京" },
    { expectationLabel: "AI Agent 工程师（深圳）", role: "AI Agent 工程师", location: "深圳" }
  ];
  const selected = choose({
    plans,
    planIndex: 0,
    planCooldowns: {
      "0:全栈工程师（北京）:全栈工程师:北京": now + 30_000,
      "1:AI Agent 工程师（深圳）:AI Agent 工程师:深圳": now + 60_000
    }
  });
  assert.equal(selected.index, 0,
    "when every correct-city expectation is temporarily empty, the earliest retry remains selectable");
  assert.ok(selected.cooldownWaitMs > 0 && selected.cooldownWaitMs <= 30_000,
    "the retry is delayed for a finite interval, not exhausted forever");
});

test("a matched JD hands the runtime an explicit contact next action", () => {
  const start = source.indexOf("async function inspectNextJobForGoal");
  const end = source.indexOf("async function contactCurrentMatchedJobForGoal", start);
  const workflow = source.slice(start, end);
  const matchedStart = workflow.indexOf("if (analysis.matches === true && job.greeting)");
  const matchedEnd = workflow.indexOf("store.addActivity", matchedStart);
  const matched = workflow.slice(matchedStart, matchedEnd);

  assert.ok(matchedStart >= 0 && matchedEnd > matchedStart, "the matched-JD result branch is present");
  assert.match(matched, /return continueGoal\([\s\S]*?"contact_current_matched_job"/,
    "the next turn must contact the same matched JD instead of asking the model to rediscover the obvious next step");
  assert.match(extractNamedFunction(source, "continueGoal"),
    /requiredNextAction:\s*requiredGoalAction\(tool/,
    "the goal continuation serializes the contact tool as requiredNextAction");
});

test("restart/resume preserves the current JD and in-flight send checkpoint", () => {
  const resumeSource = extractNamedFunction(source, "resumeOrInitializeAutomaticJobSearchGoal");
  const pendingSendEvidence = {
    jobId: "job-1",
    before: { outboundCount: 2, matchingCount: 0, messageIds: ["old"] },
    sendOperationId: "send-op-1"
  };
  const state = {
    jobs: [{
      id: "job-1",
      title: "AI Agent 工程师",
      company: "甲公司",
      analysis: { matches: true },
      greeting: "您好，我的真实工程经历与该岗位要求匹配，想进一步沟通。"
    }],
    workflow: {
      phase: "goal-running",
      lastError: "",
      autopilot: {
        status: "recoverable",
        runId: "previous-run",
        targetApplications: 60,
        sent: 7,
        currentJobId: "job-1",
        goalContext: {
          currentJobPhase: "send-clicked",
          pendingSendEvidence
        }
      }
    }
  };
  const store = {
    state,
    update(callback) { return callback(this.state); },
    addActivity() {}
  };
  let resumedPatch = null;
  const setAutopilot = (patch) => {
    resumedPatch = patch;
    state.workflow.autopilot = { ...state.workflow.autopilot, ...patch };
    return state.workflow.autopilot;
  };
  const resume = new Function(
    "store",
    "setAutopilot",
    "recoverableAutomaticJobSearchGoal",
    "initializeAutomaticJobSearchGoal",
    "automaticApplicationTarget",
    `${resumeSource}; return resumeOrInitializeAutomaticJobSearchGoal;`
  )(
    store,
    setAutopilot,
    () => true,
    () => { throw new Error("a recoverable goal must not be replaced by a new goal"); },
    (value) => Number(value) || 60
  );

  const result = resume(60);
  assert.equal(result.resumed, true);
  assert.equal(result.runId, "previous-run", "resume keeps the original goal/run identity");
  assert.equal(resumedPatch.currentJobId, "job-1",
    "a restart must resume the same JD while an external send result is unresolved");
  assert.equal(state.workflow.autopilot.goalContext.currentJobPhase, "send-clicked");
  assert.deepEqual(state.workflow.autopilot.goalContext.pendingSendEvidence, pendingSendEvidence,
    "the before-send evidence and stable operation id must survive goal restart/re-entry");
});

test("send verification requires every readable chat identity field to match the JD", () => {
  const normalizeSource = extractNamedFunction(source, "normalizedResumeText");
  const identitySource = extractNamedFunction(source, "bossChatMatchesJob");
  const matches = new Function(
    `${normalizeSource}\n${identitySource}\nreturn bossChatMatchesJob;`
  )();
  const job = { title: "AI Agent 工程师", company: "甲公司" };

  assert.equal(matches({ boss: { chat: { jobTitle: "AI Agent 工程师", company: "甲公司" } } }, job), true);
  assert.equal(matches({ boss: { chat: { jobTitle: "AI Agent 工程师", company: "乙公司" } } }, job), false,
    "a matching title must not hide a readable company mismatch");
  assert.equal(matches({ boss: { chat: { jobTitle: "后端工程师", company: "甲公司" } } }, job), false,
    "a matching company must not hide a readable title mismatch");
  assert.equal(matches({ boss: { chat: { jobTitle: "", company: "甲公司" } } }, job), true,
    "unavailable identity fields are ignored, but every available field must agree");
});

test("finite plan cooldowns are keyed by full plan identity and always yield a future retry", () => {
  const nextStart = source.indexOf("function nextAutopilotPlan");
  const keyStart = source.indexOf("function autopilotPlanKey", nextStart);
  const nextPlan = source.slice(nextStart, keyStart);
  const keyEnd = source.indexOf("function goalToolAttention", keyStart);
  const planKey = source.slice(keyStart, keyEnd);

  assert.match(nextPlan, /context\.planCooldowns/);
  assert.match(nextPlan, /autopilotPlanKey\(plan, index\)/);
  assert.match(nextPlan, /cooldownWaitMs/);
  assert.doesNotMatch(nextPlan, /exhaustedPlanLabels|exhaustedPlanKeys/);
  assert.match(planKey, /index/);
  assert.match(planKey, /plan\.expectationLabel/);
  assert.match(planKey, /plan\.role/);
  assert.match(planKey, /plan\.location/);
});

test("a verified application receipt increments the goal exactly once", () => {
  const start = source.indexOf("function recordBossJobSent");
  const end = source.indexOf("async function applyCurrentBossJob", start);
  const record = source.slice(start, end);
  const guard = record.indexOf("if (!alreadyRecorded)");
  const guardEnd = record.indexOf("state.workflow.autopilot.message", guard);
  const guardedWrite = record.slice(guard, guardEnd);

  assert.ok(guard >= 0 && guardEnd > guard, "idempotency guard surrounds the receipt write");
  assert.match(record, /Boolean\(storedJob\.sentAt\)/);
  assert.match(record, /\["sent", "replied", "interview"\]\.includes\(storedJob\.status\)/);
  assert.match(guardedWrite, /storedJob\.sentReceipt\s*=/);
  assert.match(guardedWrite, /state\.workflow\.autopilot\.sent\s*=\s*Number\([^)]*\)\s*\+\s*1/);
  assert.equal((record.match(/state\.workflow\.autopilot\.sent\s*=/g) || []).length, 1,
    "there is only one counter mutation in the idempotent record helper");
  assert.match(record, /if \(newlyRecorded\) store\.addActivity\(message\)/);
  assert.match(record, /return \{ newlyRecorded, sent \}/);
});

test("city drift restores the expected list without counting an application", () => {
  const start = source.indexOf("async function inspectNextJobForGoal");
  const end = source.indexOf("async function contactCurrentMatchedJobForGoal", start);
  const workflow = source.slice(start, end);
  const driftStart = workflow.indexOf("if (!candidateMatchesExpectedLocation(job, activeLocation))");
  const driftEnd = workflow.indexOf("currentJobPhase: \"analysis-started\"", driftStart);
  const drift = workflow.slice(driftStart, driftEnd);

  assert.ok(driftStart >= 0 && driftEnd > driftStart, "city-drift branch is present");
  assert.match(drift, /restoreBossListAfterContact\(runId, tabId, job, \{ contacted: false \}\)/);
  assert.match(drift, /currentJobId:\s*null/);
  assert.match(drift, /lastAction:\s*"job-skipped-location"/);
  assert.doesNotMatch(drift, /recordBossJobSent/);
  assert.doesNotMatch(drift, /autopilot\.sent/);
  assert.doesNotMatch(drift, /status:\s*"complete"/);
});

test("goal-driven job search remains active until the requested verified-contact target", () => {
  const inspectStart = source.indexOf("async function inspectNextJobForGoal");
  const inspectEnd = source.indexOf("async function contactCurrentMatchedJobForGoal", inspectStart);
  const inspect = source.slice(inspectStart, inspectEnd);
  const contactStart = inspectEnd;
  const contactEnd = source.indexOf("async function startAutopilotFromCurrentList", contactStart);
  const contact = source.slice(contactStart, contactEnd);
  assert.match(source, /DEFAULT_AUTO_APPLY_TARGET = 60/);
  assert.match(source, /Math\.min\(500, Math\.max\(1, requested\)\)/);
  assert.doesNotMatch(source, /Math\.max\(DEFAULT_AUTO_APPLY_TARGET/);
  assert.match(contact, /sent\s*>?=\s*targetApplications|sent\s*>?=\s*target/);
  assert.match(contact, /status:\s*"complete"/);
  assert.match(source, /async function advanceBossJobResults/);
  assert.match(source, /kind: "computerBack"/);
  assert.match(source, /kind: "computerScroll"/);
  assert.match(inspect, /candidateMatchesExpectedLocation\(candidate, activeLocation\)/);
  assert.match(inspect, /candidateMatchesExpectedLocation\(job, activeLocation\)/);
  assert.match(source, /async function prepareJobSearchGoal[\s\S]*await verifyAutopilotProvider\(runId\)/);
  assert.match(source, /async function prepareJobSearchGoal[\s\S]*await ensureAutopilotCandidateEvidence\(runId\)/);
  assert.match(source, /正在验证 Sub2API 模型与账号分组/);
  assert.match(source, /API Key is not assigned to any group/);
});

test("atomic contact action exposes observable Computer Use click progress", () => {
  const start = source.indexOf("async function applyCurrentBossJob");
  const end = source.indexOf("function unverifiedBossApplicationError", start);
  const contact = source.slice(start, end);

  assert.match(contact, /findPageControl\(page, \/\^\(\?:立即沟通\|继续沟通/);
  assert.match(source, /鼠标正在移向/);
  assert.match(source, /已点击“/);
  assert.match(contact, /kind: "computerClick"/);
  assert.match(contact, /adaptiveBossComposer/);
  assert.match(contact, /waitForBoundBossChat/);
});

test("contact recovery remains on the same JD and reserves a new idempotent physical attempt", () => {
  const contact = extractNamedFunction(source, "applyCurrentBossJob");
  const composerStart = source.indexOf("async function adaptiveBossComposer");
  const composerEnd = source.indexOf("async function restoreBossListAfterContact", composerStart);
  const composer = source.slice(composerStart, composerEnd);

  assert.match(contact, /\["contact-clicking", "contact-clicked"\]\.includes\(persistedPhase\)/);
  assert.match(contact, /bossJobDetailMatches\(page, job\)/);
  assert.match(contact, /operationId:\s*operationIds\.contact/);
  assert.match(contact, /operationAttempt/);
  assert.match(source, /function reserveNextBossContactAttempt/);
  assert.match(composer, /reserveNextBossContactAttempt\(job\.id\)/);
  assert.match(composer, /bossChatMatchesJob\(candidatePage, job\) \|\| bossJobDetailMatches\(candidatePage, job\)/);
  assert.doesNotMatch(composer, /contactOperationId}:retry/);
});

test("extension deduplicates exact attempts but permits a verified contact retry", () => {
  assert.match(serviceWorker, /const operationAttempt =/);
  assert.match(serviceWorker, /const receiptKey = operationAttempt > 0/);
  assert.match(serviceWorker, /`\$\{operationId\}:attempt:\$\{operationAttempt\}`/);
  assert.match(serviceWorker, /receipts\[receiptKey\]/);
  assert.doesNotMatch(serviceWorker, /receipts\[operationId\] =/);
});

test("a tailored send is successful only after a new outbound message appears and the composer clears", () => {
  const start = source.indexOf("async function applyCurrentBossJob");
  const end = source.indexOf("function unverifiedBossApplicationError", start);
  const contact = source.slice(start, end);
  assert.ok(start >= 0 && end > start, "atomic contact helper source range is present");

  const sendClick = contact.indexOf("发送 ${job.company} / ${job.title} 的定制招呼语");
  const recordedOffset = contact.slice(sendClick).search(/recordBossJobSent\(job(?:,|\))/);
  const recorded = recordedOffset < 0 ? -1 : sendClick + recordedOffset;
  assert.ok(sendClick >= 0, "the visible send button is clicked");
  assert.ok(recorded > sendClick, "success is recorded only after the send click is verified");

  const verification = contact.slice(sendClick, recorded);
  assert.match(contact.slice(0, sendClick), /const before = reusablePending\?\.before \|\| outboundGreetingEvidence\(page, job\.greeting\)/,
    "candidate outbound state is captured before sending");
  assert.match(verification, /bossSendWasVerified\(before, value, job\.greeting, job, chatSession, chatSession\.tabId\)/,
    "the post-click wait uses the structured send verifier");
  assert.match(verification, /job\.greeting/,
    "the new outbound message must match the tailored greeting");

  const evidenceStart = source.indexOf("function candidateOutboundMessages");
  const evidenceEnd = source.indexOf("const SAFE_BOSS_TRANSITION", evidenceStart);
  const evidence = source.slice(evidenceStart, evidenceEnd);
  assert.match(evidence, /boss\?\.chat\?\.messages/,
    "verification reads structured chat messages rather than the page text");
  assert.match(evidence, /message\?\.from === "candidate"/,
    "verification considers only outbound candidate messages");
  assert.match(evidence, /if \(bossComposerValue\(page\)\) return false/,
    "a non-empty composer rejects send success");
  assert.match(evidence, /hasNewMatchingId/);
  assert.match(evidence, /matchingStableIds/);
  assert.match(evidence, /\["attribute", "element-id"\]\.includes\(message\.idSource\)/,
    "CSS-derived message ids cannot independently prove a successful send");
  assert.doesNotMatch(extractNamedFunction(source, "bossSendWasVerified"), /after\.matchingIds\.some/);
  assert.match(evidence, /after\.outboundCount > Number\(before\?\.outboundCount \|\| 0\)/);
  assert.match(evidence, /after\.matchingCount > Number\(before\?\.matchingCount \|\| 0\)/);

  const snapshotEnd = bossAdapter.indexOf("function bossInspectPage");
  const chatSnapshot = bossAdapter.slice(0, snapshotEnd);
  assert.match(chatSnapshot, /messages/);
  assert.match(chatSnapshot, /valuePreview: composerValue/,
    "BOSS chat snapshots expose the current composer value");
  assert.ok((bossAdapter.match(/jobdeckBossChatSnapshot\(\{ compact, visible, selectorFor \}\)/g) || []).length >= 2,
    "both full and compact BOSS inspectors reuse the verifiable chat snapshot");
});

test("pending send evidence is bound to the exact chat conversation", () => {
  const contact = extractNamedFunction(source, "applyCurrentBossJob");
  const session = extractNamedFunction(source, "bossChatSession");
  const matches = extractNamedFunction(source, "bossChatSessionMatches");

  assert.match(contact, /pending\.chatSession\?\.tabId/);
  assert.match(contact, /pendingSendEvidence:[\s\S]*chatSession/);
  assert.match(contact, /const reusablePending =[\s\S]*bossChatSessionMatches/);
  assert.match(contact, /bossSessionOperationId\(operationIds\.type, chatSession\)/);
  assert.match(contact, /bossSessionOperationId\(operationIds\.send, chatSession\)/);
  assert.match(contact, /waitForBoundBossChat/);
  assert.match(session, /conversationId/);
  assert.match(matches, /binding\.tabId/);
  assert.match(matches, /binding\.url/);
});

test("saved BOSS expectations are selected directly without a second city workflow", () => {
  const start = source.indexOf("async function selectSavedBossExpectation");
  const end = source.indexOf("async function selectExpectedBossLocation", start);
  const selection = source.slice(start, end);
  assert.match(selection, /bossExpectationContextMatches/);
  assert.match(selection, /waitForStableBossExpectation/);
  assert.doesNotMatch(selection, /selectExpectedBossLocation/);
  assert.doesNotMatch(selection, /filterMatches \|\| cardsMatch/);
});

test("verified contacts restore list context without forcing expectation or city reselection", () => {
  assert.match(source, /function bossExpectationContextMatches/);
  assert.match(source, /active\?\.label === expectationLabel/);
  assert.match(source, /visibleLocation === desiredLocation/);
  const restoreStart = source.indexOf("async function restoreBossListAfterContact");
  const recoverStart = source.indexOf("async function recoverBossListAfterCandidateError", restoreStart);
  const inspectStart = source.indexOf("async function inspectNextJobForGoal", recoverStart);
  const contactStart = source.indexOf("async function contactCurrentMatchedJobForGoal", inspectStart);
  const restore = source.slice(restoreStart, recoverStart);
  const recover = source.slice(recoverStart, inspectStart);
  const goalWorkflow = source.slice(inspectStart, source.indexOf("async function startAutopilotFromCurrentList", contactStart));
  assert.doesNotMatch(restore, /forceExpectation:\s*true/);
  assert.match(restore, /ensureBossRestoredListContext/);
  assert.match(source, /context\.activeExpectation/);
  assert.match(source, /context\.activeLocation/);
  const ensuredStart = source.indexOf("async function ensureBossRestoredListContext");
  const ensuredEnd = source.indexOf("async function restoreBossListAfterContact", ensuredStart);
  const ensured = source.slice(ensuredStart, ensuredEnd);
  assert.match(ensured, /kind: "inspect"/);
  assert.match(ensured, /forceExpectation: false/);
  assert.match(recover, /forceExpectation:\s*false/);
  assert.doesNotMatch(recover, /forceExpectation:\s*true/);
  assert.doesNotMatch(goalWorkflow, /forceExpectation:\s*true/);
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
