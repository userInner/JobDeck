import OpenAI from "openai";
import { agentRoutePrompt, agentStepPrompt, bossReplyPrompt, browserPlanPrompt, chatInstructions, jobAnalysisPrompt, jobCompatibilityPrompt, resumeAuditPrompt, resumeOptimizationPrompt } from "./prompts.mjs";

function extractJson(text) {
  const clean = String(text).trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回可解析的岗位分析");
  return JSON.parse(clean.slice(start, end + 1));
}

export class AIService {
  constructor(store) {
    this.store = store;
  }

  client() {
    const { apiKey } = this.store.secrets;
    const provider = this.store.state.provider;
    if (!apiKey) throw new Error("请先在设置中填写模型 API Key");
    return new OpenAI({ apiKey, baseURL: provider.baseURL || undefined });
  }

  async structured(prompt, errorMessage = "模型没有返回可解析的结构化结果") {
    const provider = this.store.state.provider;
    const client = this.client();
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: prompt }]
      });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    try { return extractJson(text); }
    catch { throw new Error(errorMessage); }
  }

  async routeAgentRequest(text, tools, activeTask = null) {
    const parsed = await this.structured(
      agentRoutePrompt(text, this.store.state.candidate, tools, activeTask),
      "模型没有正确判断本次消息是否需要执行"
    );
    const kind = parsed.kind === "agent" ? "agent" : "answer";
    return {
      kind,
      goal: kind === "agent" ? String(parsed.goal || text || "").slice(0, 1200) : "",
      message: String(parsed.message || "").slice(0, 500)
    };
  }

  async planAgentStep({ task, observation, tools }) {
    const parsed = await this.structured(
      agentStepPrompt({ task, observation, tools, candidate: this.store.state.candidate }),
      "模型没有返回可执行的 Agent 下一步"
    );
    const type = ["tool", "finish", "ask_user"].includes(parsed.type) ? parsed.type : "ask_user";
    return {
      type,
      tool: type === "tool" ? String(parsed.tool || "").slice(0, 100) : "",
      arguments: parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments) ? parsed.arguments : {},
      plan: Array.isArray(parsed.plan) ? parsed.plan.slice(0, 5).map((item) => String(item).slice(0, 300)) : [],
      message: String(parsed.message || "").slice(0, 600)
    };
  }

  async complete(messages, mode = "general") {
    const provider = this.store.state.provider;
    const instructions = chatInstructions(this.store.state.candidate, mode);
    const client = this.client();
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "system", content: instructions }, ...messages]
      });
      return response.choices[0]?.message?.content || "";
    }
    const response = await client.responses.create({
      model: provider.model,
      instructions,
      input: messages,
      store: false
    });
    return response.output_text || "";
  }

  async *stream(messages, mode = "general") {
    const provider = this.store.state.provider;
    const instructions = chatInstructions(this.store.state.candidate, mode);
    const client = this.client();
    if (provider.mode === "compatible-chat") {
      const stream = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "system", content: instructions }, ...messages],
        stream: true
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (typeof delta === "string" && delta) yield delta;
      }
      return;
    }
    const stream = await client.responses.create({
      model: provider.model,
      instructions,
      input: messages,
      store: false,
      stream: true
    });
    for await (const event of stream) {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
        yield event.delta;
      }
    }
  }

  async analyzeJob(job) {
    const provider = this.store.state.provider;
    const client = this.client();
    const prompt = jobAnalysisPrompt(job, this.store.state.candidate);
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: prompt }]
      });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    const parsed = extractJson(text);
    const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
    return {
      score: clamp(parsed.score),
      verdict: ["推荐", "谨慎", "跳过"].includes(parsed.verdict) ? parsed.verdict : "谨慎",
      dimensions: {
        roleFit: clamp(parsed.dimensions?.roleFit),
        experience: clamp(parsed.dimensions?.experience),
        stack: clamp(parsed.dimensions?.stack),
        location: clamp(parsed.dimensions?.location),
        compensation: clamp(parsed.dimensions?.compensation)
      },
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3) : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 3) : [],
      summary: String(parsed.summary || "").slice(0, 300),
      greeting: String(parsed.greeting || "").slice(0, 800)
    };
  }

  async matchJob(job) {
    const provider = this.store.state.provider;
    const client = this.client();
    const prompt = jobCompatibilityPrompt(job, this.store.state.candidate);
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: prompt }]
      });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    const parsed = extractJson(text);
    const matches = parsed.matches === true;
    return {
      mode: "match-only",
      matches,
      verdict: matches ? "匹配" : "跳过",
      matchedRole: String(parsed.matchedRole || "").slice(0, 80),
      matchedStack: Array.isArray(parsed.matchedStack) ? parsed.matchedStack.slice(0, 5).map(String) : [],
      hardGaps: Array.isArray(parsed.hardGaps) ? parsed.hardGaps.slice(0, 3).map(String) : [],
      summary: String(parsed.summary || "").slice(0, 300),
      greeting: matches ? String(parsed.greeting || "").slice(0, 800) : ""
    };
  }

  async auditBossResume(resume) {
    const provider = this.store.state.provider;
    const client = this.client();
    const prompt = resumeAuditPrompt(resume, this.store.state.candidate);
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: prompt }]
      });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    const parsed = extractJson(text);
    return {
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      firstScreen: String(parsed.firstScreen || "").slice(0, 300),
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 3).map(String) : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5).map(String) : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 5).map(String) : [],
      blockingFacts: Array.isArray(parsed.blockingFacts) ? parsed.blockingFacts.slice(0, 3).map(String) : []
    };
  }

  async optimizeBossResume(resume, audit) {
    const provider = this.store.state.provider;
    const client = this.client();
    const prompt = resumeOptimizationPrompt(resume, audit, this.store.state.candidate);
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: prompt }]
      });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    const parsed = extractJson(text);
    const allowedKeys = new Set(["targetRoles", "personalAdvantage", "workExperience", "projectExperience", "openSource", "skills"]);
    const fields = Array.isArray(parsed.fields) ? parsed.fields.slice(0, 5).flatMap((field) => {
      const key = String(field?.key || "");
      const replacement = String(field?.replacement || "").trim().slice(0, 4000);
      if (!allowedKeys.has(key) || !replacement) return [];
      return [{
        key,
        label: String(field?.label || key).slice(0, 60),
        currentSummary: String(field?.currentSummary || "").slice(0, 300),
        replacement,
        reason: String(field?.reason || "").slice(0, 300)
      }];
    }) : [];
    if (!fields.length) throw new Error("模型没有返回可用的简历替换稿");
    return {
      summary: String(parsed.summary || "").slice(0, 400),
      fields,
      factsToConfirm: Array.isArray(parsed.factsToConfirm) ? parsed.factsToConfirm.slice(0, 5).map((item) => String(item).slice(0, 300)) : []
    };
  }

  async planBrowserTask(instruction, page) {
    const provider = this.store.state.provider;
    const client = this.client();
    const prompt = browserPlanPrompt(instruction, page, this.store.state.candidate);
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: prompt }]
      });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    const parsed = extractJson(text);
    const selectors = new Set((page.interactives || []).map((item) => item.selector));
    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 3).flatMap((action) => {
      const kind = action?.kind === "click" ? "click" : action?.kind === "type" ? "type" : "";
      const selector = String(action?.selector || "");
      if (!kind || !selectors.has(selector)) return [];
      return [{ kind, selector, value: kind === "type" ? String(action.value || "").slice(0, 2000) : undefined, reason: String(action.reason || "AI 页面计划").slice(0, 300) }];
    }) : [];
    return { summary: String(parsed.summary || "").slice(0, 500), actions };
  }

  async draftBossReply(chat) {
    const provider = this.store.state.provider;
    const client = this.client();
    const prompt = bossReplyPrompt(chat, this.store.state.candidate);
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({ model: provider.model, messages: [{ role: "user", content: prompt }] });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    const parsed = extractJson(text);
    const categories = new Set(["routine", "salary", "interview-time", "privacy", "offer", "unknown"]);
    const category = categories.has(parsed.category) ? parsed.category : "unknown";
    const forcedConfirmation = category !== "routine";
    return {
      needsConfirmation: forcedConfirmation || Boolean(parsed.needsConfirmation),
      category,
      reason: String(parsed.reason || "").slice(0, 200),
      draft: String(parsed.draft || "").slice(0, 1200)
    };
  }
}
