import { decodeBossPrivateText } from "./jobs.mjs";

const MATCHING_SECTIONS = new Set([
  "targetRoles",
  "personalAdvantage",
  "workExperience",
  "projectExperience",
  "openSource",
  "skills"
]);

function compactEvidence(value) {
  return decodeBossPrivateText(value)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function bossResumeEvidence(page, limit = 18_000) {
  const details = Array.isArray(page?.boss?.resume?.sectionDetails)
    ? page.boss.resume.sectionDetails
    : [];
  const preferred = details
    .filter((section) => MATCHING_SECTIONS.has(section?.key))
    .map((section) => compactEvidence(section?.text))
    .filter(Boolean);
  const fallback = Array.isArray(page?.boss?.resume?.sections)
    ? page.boss.resume.sections.map(compactEvidence).filter(Boolean)
    : [];
  const source = preferred.length ? preferred : fallback;
  const unique = source.filter((text, index) => source.indexOf(text) === index);
  return unique.join("\n\n").slice(0, limit);
}

export function hasCandidateEvidence(candidate) {
  const facts = Array.isArray(candidate?.facts)
    ? candidate.facts.map((fact) => compactEvidence(fact)).filter(Boolean)
    : [];
  return facts.length > 0 || compactEvidence(candidate?.resumeText).length >= 300;
}
