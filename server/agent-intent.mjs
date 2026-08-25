const capabilityQuestion = /(?:能不能|是否可以|可不可以|可以吗|怎么(?:做|实现|设计|使用)|如何(?:实现|设计)|例如|假如|如果只是)/;
const explicitJobCommand = /(?:帮我|请|开始|继续|立即|直接|替我|去).{0,32}(?:找.{0,24}(?:工作|岗位|职位)|搜索岗位|投递|海投|申请岗位|沟通岗位|沟通职位)/;
const declarativeJobGoal = /(?:^|[，。；;\s])我(?:要|想|准备|正在)?找(?:.{0,120})(?:工作|岗位|职位|工程师)/;

export function isJobSearchExecutionIntent(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (explicitJobCommand.test(value)) return true;
  if (capabilityQuestion.test(value) || /[?？]\s*$/.test(value)) return false;
  return declarativeJobGoal.test(value);
}

export function requestedApplicationTarget(text) {
  const value = String(text || "");
  const patterns = [
    /(?:至少|最低|目标(?:为|是)?|完成|投递|沟通|申请|找)[^\d]{0,12}(\d{1,3})\s*(?:份|个|条)(?:\s*(?:工作|岗位|职位|投递|沟通))?/,
    /(\d{1,3})\s*(?:份|个|条)\s*(?:工作|岗位|职位|投递|沟通)/
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (!match) continue;
    const target = Number.parseInt(match[1], 10);
    if (Number.isFinite(target)) return Math.max(1, Math.min(500, target));
  }
  return null;
}
