import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = Number(process.env.JOBDECK_PORT || 43120);
export const DEFAULT_HOST = "127.0.0.1";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function createDefaultState() {
  return {
    version: 2,
    candidate: {
      displayName: "候选人",
      status: "",
      github: "",
      resumePath: path.join(PROJECT_ROOT, "assets", "resume.pdf"),
      targetRoles: [],
      locations: [],
      salaryFloorK: 0,
      salaryUpperTargetK: 0,
      facts: [],
      resumeText: ""
    },
    provider: {
      mode: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-5.4",
      configured: false
    },
    jobs: [],
    conversations: [],
    actions: [],
    activity: [],
    workflow: {
      version: 1,
      phase: "not-started",
      startedAt: null,
      updatedAt: null,
      lastError: "",
      resumeTabId: null,
      resumeAuditStatus: "idle",
      resumeAuditMessage: "",
      resumeAuditRunId: null,
      resumeAudit: null,
      resumeOptimizationStatus: "idle",
      resumeOptimizationMessage: "",
      resumeOptimizationRunId: null,
      resumeOptimization: null,
      resumeApply: {
        status: "idle",
        runId: null,
        message: "",
        appliedFields: [],
        skippedFields: [],
        verifiedFieldKeys: [],
        updatedFieldKeys: [],
        optimizationGeneratedAt: null,
        startedAt: null,
        completedAt: null
      },
      resumeDecision: null,
      search: {
        keyword: "AI Agent",
        discovered: 0,
        analyzed: 0
      },
      batch: [],
      batchSize: 3,
      autopilot: {
        status: "idle",
        runId: null,
        stage: "",
        autoApply: false,
        autoApplyLimit: null,
        targetApplications: 60,
        message: "",
        discovered: 0,
        analyzed: 0,
        selected: 0,
        sent: 0,
        currentJobId: null,
        rankedJobIds: [],
        selectedJobIds: [],
        stopRequested: false,
        startedAt: null,
        completedAt: null
      },
      agent: {
        status: "idle",
        runId: null,
        goal: "",
        sourceText: "",
        scopes: [],
        plan: [],
        message: "",
        currentTool: null,
        waitFor: null,
        steps: [],
        noProgressCount: 0,
        stopRequested: false,
        startedAt: null,
        updatedAt: null,
        completedAt: null
      }
    },
    settings: {
      requireApproval: true,
      maxActionsPerBatch: 5,
      followUpHours: 24,
      avoidBulkTemplates: true
    }
  };
}
