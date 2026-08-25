import assert from "node:assert/strict";
import test from "node:test";
import { actionLabel, normalizeAction } from "../server/bridge.mjs";

test("browser action normalization clamps and limits inputs", () => {
  const action = normalizeAction({ kind: "scroll", amount: 99_999, direction: "down" });
  assert.equal(action.amount, 4000);
  assert.equal(actionLabel(action), "向下滚动");
});

test("browser action normalization rejects unknown actions", () => {
  assert.throws(() => normalizeAction({ kind: "evaluate" }), /不支持的浏览器动作/);
});

test("fixed BOSS workflow pages are safe browser actions", () => {
  assert.equal(normalizeAction({ kind: "openBossResume" }).kind, "openBossResume");
  const job = normalizeAction({ kind: "openBossJob", url: "https://www.zhipin.com/job_detail/example.html" });
  assert.equal(job.url, "https://www.zhipin.com/job_detail/example.html");
  assert.match(actionLabel(job), /打开 BOSS 岗位/);
});

test("browser actions preserve an explicit Chrome tab target", () => {
  const action = normalizeAction({ kind: "inspect", tabId: 123 });
  assert.equal(action.tabId, 123);
});

test("browser actions preserve a bounded physical operation attempt", () => {
  const action = normalizeAction({ kind: "computerClick", operationId: "boss:run:job:contact", operationAttempt: 3 });
  assert.equal(action.operationId, "boss:run:job:contact");
  assert.equal(action.operationAttempt, 3);
  assert.equal(normalizeAction({ kind: "computerClick", operationAttempt: 999 }).operationAttempt, 100);
});

test("mouse-style actions keep bounded viewport coordinates", () => {
  const move = normalizeAction({ kind: "mouseMove", x: 240, y: 360 });
  assert.deepEqual({ x: move.x, y: move.y }, { x: 240, y: 360 });
  const click = normalizeAction({ kind: "mouseClick", x: -10, y: 99_999 });
  assert.deepEqual({ x: click.x, y: click.y }, { x: 0, y: 10000 });
  assert.match(actionLabel(click), /鼠标点击/);
});

test("resume controls can use a visible section anchor without losing the real selector", () => {
  const action = normalizeAction({
    kind: "click",
    selector: ".resume-item .edit",
    anchorSelector: ".resume-item",
    reason: "用户已批准修改个人优势"
  });
  assert.equal(action.selector, ".resume-item .edit");
  assert.equal(action.anchorSelector, ".resume-item");
  assert.match(actionLabel(action), /点击/);
  const hover = normalizeAction({ kind: "hover", selector: ".resume-item" });
  assert.equal(hover.kind, "hover");
  assert.match(actionLabel(hover), /悬停/);
});

test("Computer Use actions preserve coordinates and replacement intent", () => {
  const click = normalizeAction({ kind: "computerClick", tabId: 9, x: 420, y: 315 });
  assert.deepEqual({ tabId: click.tabId, x: click.x, y: click.y }, { tabId: 9, x: 420, y: 315 });
  assert.match(actionLabel(click), /Computer Use 点击/);
  const type = normalizeAction({ kind: "computerType", value: "优化后的个人优势", replace: true });
  assert.equal(type.replace, true);
  assert.match(actionLabel(type), /Computer Use 输入/);
  const notice = normalizeAction({ kind: "computerNotice", tabId: 9, text: "个人优势已写入并验证" });
  assert.equal(notice.text, "个人优势已写入并验证");
  assert.match(actionLabel(notice), /状态提示/);
  const scroll = normalizeAction({ kind: "computerScroll", tabId: 9, x: 320, y: 640, amount: 720, direction: "down" });
  assert.deepEqual({ x: scroll.x, y: scroll.y, amount: scroll.amount, direction: scroll.direction }, { x: 320, y: 640, amount: 720, direction: "down" });
  assert.match(actionLabel(scroll), /Computer Use 向下滚动/);
  const keypress = normalizeAction({ kind: "computerKeypress", tabId: 9, key: "Escape" });
  assert.equal(keypress.key, "Escape");
  assert.match(actionLabel(keypress), /Computer Use 按键/);
});
