export function verificationReason(page) {
  const text = String(page?.text || "").slice(0, 5000);
  return text.match(/(?:验证码|安全验证|异常访问|访问过于频繁|请完成验证|滑动拼图|账号异常|操作频繁)/)?.[0] || "";
}

export function findPageControl(page, pattern, tags = []) {
  return (page?.interactives || []).find((item) => {
    if (tags.length && !tags.includes(item.tag)) return false;
    return pattern.test(String(item.label || "").trim()) && !item.disabled;
  });
}

export function autopilotCandidateIds(jobs, visibleIds, limit = 8) {
  const visible = new Set(visibleIds);
  return jobs
    .filter((job) => visible.has(job.id) && !["sent", "replied", "interview"].includes(job.status))
    .map((job) => job.id)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
}

export function rankAnalyzedJobs(jobs, candidateIds) {
  const candidates = new Set(candidateIds);
  return jobs
    .filter((job) => candidates.has(job.id) && job.analysis && job.greeting)
    .sort((left, right) => Number(right.score) - Number(left.score));
}
