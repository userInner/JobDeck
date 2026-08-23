function clean(value) {
  return String(value || "").trim();
}

function splitBlocks(value) {
  return clean(value).split(/\n\s*\n+/).map(clean).filter(Boolean);
}

function splitHeader(value) {
  return clean(value).split(/[｜|]/).map(clean).filter(Boolean);
}

function workEntries(field) {
  return splitBlocks(field?.replacement).flatMap((block) => {
    const lines = block.split("\n").map(clean).filter(Boolean);
    const header = splitHeader(lines.shift());
    if (!header[0] || !lines.length) return [];
    let content = lines.join("\n");
    let achievements = "";
    const achievementStart = content.search(/(?:^|[。；])完成托管钱包/);
    if (achievementStart >= 0) {
      achievements = content.slice(achievementStart).replace(/^[。；]/, "").trim();
      content = content.slice(0, achievementStart + (content[achievementStart] === "。" ? 1 : 0)).trim();
    }
    return [{
      match: header[0].replace(/（.*?）/g, "").trim(),
      content,
      achievements
    }];
  });
}

function splitProjectBlocks(value) {
  const lines = clean(value).split("\n");
  const blocks = [];
  let current = [];
  for (const rawLine of lines) {
    const line = clean(rawLine);
    if (!line) {
      if (current.length && current[current.length - 1] !== "") current.push("");
      continue;
    }
    const header = splitHeader(line);
    const startsRecord = header.length >= 2 && !/^[-•]/.test(line);
    if (startsRecord && current.length) {
      blocks.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) blocks.push(current.join("\n").trim());
  return blocks.filter(Boolean);
}

function projectEntry(block, fallbackNature = "", sourceKey = "projectExperience") {
  const lines = block.split("\n").map(clean).filter(Boolean);
  const header = splitHeader(lines.shift());
  if (!header[0] || !lines.length) return null;
  const body = lines.join("\n");
  const evidenceIndex = body.search(/(?:项目证据|技术栈|项目链接)：/);
  const description = clean(evidenceIndex >= 0 ? body.slice(0, evidenceIndex) : body);
  const achievements = clean(evidenceIndex >= 0 ? body.slice(evidenceIndex) : "");
  return {
    match: header[0],
    role: header[1] || fallbackNature,
    description,
    achievements,
    sourceKey
  };
}

function projectEntries(projectField, openSourceField) {
  const entries = splitProjectBlocks(projectField?.replacement).map((block) => projectEntry(block)).filter(Boolean);
  const openSource = splitProjectBlocks(openSourceField?.replacement).map((block) => projectEntry(block, "个人开源贡献", "openSource")).filter(Boolean);
  return [...openSource, ...entries];
}

export function buildResumeWritePlan(optimization, candidate = {}) {
  const fields = new Map((optimization?.fields || []).map((field) => [field.key, field]));
  const personal = clean(fields.get("personalAdvantage")?.replacement);
  const verifiedTelegram = (candidate.facts || []).some((fact) => /Telegram Bot|交易行情机器人/i.test(String(fact)));
  const requiresConfirmation = [];
  if (fields.has("targetRoles")) requiresConfirmation.push("期望职位、地点与薪资（BOSS 结构化选项需单独确认）");
  if (fields.has("workExperience")) requiresConfirmation.push("工作经历的公司、职位与日期（保留 BOSS 现值）");
  if (fields.has("projectExperience") || fields.has("openSource")) requiresConfirmation.push("项目名称、日期与独立链接字段（保留 BOSS 现值）");
  return {
    personalAdvantage: personal ? { replacement: personal } : null,
    workExperience: workEntries(fields.get("workExperience")),
    projectExperience: projectEntries(fields.get("projectExperience"), fields.get("openSource")),
    skills: verifiedTelegram ? { appendLines: ["Telegram Bot：通用机器人 Bot、交易行情机器人"] } : null,
    requiresConfirmation
  };
}
