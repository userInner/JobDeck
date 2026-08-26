import OpenAI from "openai";
import { agentRoutePrompt, agentStepPrompt, bossReplyPrompt, browserPlanPrompt, chatInstructions, jobAnalysisPrompt, jobCompatibilityPrompt, recruiterGreetingPrompt, resumeAuditPrompt, resumeOptimizationPrompt } from "./prompts.mjs";
import { normalizeRecruiterGreeting, recruiterGreetingIssues } from "./greeting.mjs";

function extractJson(text) {
  const clean = String(text).trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回可解析的岗位分析");
  return JSON.parse(clean.slice(start, end + 1));
}

function bossLatestInboundText(input) {
  if (input?.latestInbound) return String(input.latestInbound?.text || input.latestInbound).trim();
  const chat = input?.chat || input || {};
  const message = [...(chat.messages || [])].reverse().find((item) => item?.from === "recruiter");
  return String(message?.text || "").trim();
}

function sensitiveBossReplyCategory(text) {
  const value = String(text || "").replace(/\s+/g, " ");
  if (!value) return "";
  if (/(?:劳动|劳务|保密|竞业|雇佣|入职)合同|签(?:署|约)|协议|竞业|股权|期权/i.test(value)) return "contract";
  if (/(?:offer|录用通知)/i.test(value)) return "offer";
  if (/(?:身份证|护照|银行卡|证件|毕业证|学位证|住址|家庭地址|手机号|手机号码|电话号码|联系电话|微信号|加微信|个人邮箱|邮箱地址)/i.test(value)) return "privacy";
  if (/(?:当前|目前|期望|预期|最低|上一份|原来).{0,10}(?:薪资|薪酬|工资|月薪|年薪|待遇)|(?:薪资|薪酬|工资|月薪|年薪|待遇).{0,10}(?:多少|要求|期望|接受|范围)|税前|税后|涨幅/i.test(value)) return "salary";
  if (/(?:面试|沟通).{0,16}(?:时间|日期|哪天|几点|什么时候|何时|今晚|明天|后天|本周|下周|周[一二三四五六日天])|(?:时间|日期|哪天|几点|什么时候|何时|今晚|明天|后天|本周|下周|周[一二三四五六日天]).{0,16}(?:面试|沟通)/i.test(value)) return "interview-time";
  if (/(?:现在|稍后|待会儿?|晚点|今天|今晚|明天|明早|明晚|后天|本周|这周|下周|周末|周[一二三四五六日天]|星期[一二三四五六日天]|上午|下午|晚上|哪天|几点|什么时候|何时|\d{1,2}(?::|：|点|时)\d{0,2}).{0,12}(?:方便|有空|有时间|合适|可以|行)(?:吗|么|不|呢)?[?？。.!！]*$/i.test(value)) return "interview-time";
  if (/(?:方便|有空|有时间|合适|可以|行).{0,12}(?:现在|稍后|待会儿?|晚点|今天|今晚|明天|明早|明晚|后天|本周|这周|下周|周末|周[一二三四五六日天]|星期[一二三四五六日天]|上午|下午|晚上|哪天|几点|什么时候|何时|\d{1,2}(?::|：|点|时)\d{0,2})(?:吗|么|不|呢)?[?？。.!！]*$/i.test(value)) return "interview-time";
  if (/(?:电话|视频|语音|通话|call|phone|video).{0,16}(?:方便|有空|有时间|可以|可否|能否|能|行|安排|available|free)|(?:方便|有空|有时间|可以|可否|能否|是否|能|行|安排|available|free).{0,16}(?:电话|视频|语音|通话|call|phone|video)/i.test(value)) return "interview-time";
  if (/(?:最快|预计|可以|能够|何时|什么时候).{0,12}(?:到岗|入职)|(?:到岗|入职时间|离职周期|通知期|notice\s*period).{0,12}(?:多久|何时|什么时候|安排|承诺)?/i.test(value)) return "start-date";
  if (/(?:接受|可以|能否|是否).{0,12}(?:搬迁|异地|驻场|常驻|外派|调动)|(?:搬迁|异地|驻场|常驻|外派|调动).{0,12}(?:接受|可以|能否|是否)/i.test(value)) return "relocation";
  if (/(?:加班|工时|大小周|单双休|夜班|值班|工作时长|作息)/i.test(value)) return "work-hours";
  if (/试用期/i.test(value)) return "probation";
  return "";
}

function isBossRejectionOnly(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || /[?？]/.test(value)) return false;
  return /(?:很遗憾|暂不合适|暂时不考虑|不太匹配|不符合|无法推进|不再推进|岗位已关闭|岗位已招满|停止招聘|感谢.{0,16}(?:投递|关注).{0,16}(?:未通过|不合适|不匹配))/i.test(value);
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

  async verifyProvider() {
    const provider = this.store.state.provider;
    const client = this.client();
    if (provider.mode === "compatible-chat") {
      await client.chat.completions.create({
        model: provider.model,
        messages: [{ role: "user", content: "Reply OK." }],
        max_tokens: 8
      });
      return true;
    }
    await client.responses.create({
      model: provider.model,
      input: "Reply OK.",
      max_output_tokens: 16,
      store: false
    });
    return true;
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
    const businessDomain = String(parsed.businessDomain || "").trim().slice(0, 80);
    const analysis = {
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
      businessDomain,
      needsDomainBridge: parsed.needsDomainBridge === true && Boolean(businessDomain),
      greeting: normalizeRecruiterGreeting(parsed.greeting).slice(0, 800)
    };
    analysis.greeting = await this.ensureRecruiterGreeting(job, analysis);
    return analysis;
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
    const businessDomain = String(parsed.businessDomain || "").trim().slice(0, 80);
    const analysis = {
      mode: "match-only",
      matches,
      verdict: matches ? "匹配" : "跳过",
      matchedRole: String(parsed.matchedRole || "").slice(0, 80),
      matchedStack: Array.isArray(parsed.matchedStack) ? parsed.matchedStack.slice(0, 5).map(String) : [],
      hardGaps: Array.isArray(parsed.hardGaps) ? parsed.hardGaps.slice(0, 3).map(String) : [],
      summary: String(parsed.summary || "").slice(0, 300),
      businessDomain,
      needsDomainBridge: parsed.needsDomainBridge === true && Boolean(businessDomain),
      greeting: matches ? normalizeRecruiterGreeting(parsed.greeting).slice(0, 800) : ""
    };
    if (matches) analysis.greeting = await this.ensureRecruiterGreeting(job, analysis);
    return analysis;
  }

  async ensureRecruiterGreeting(job, analysis) {
    let greeting = normalizeRecruiterGreeting(analysis?.greeting);
    let issues = recruiterGreetingIssues(greeting, analysis);
    if (!issues.length) return greeting;
    try {
      const parsed = await this.structured(
        recruiterGreetingPrompt(job, this.store.state.candidate, analysis, greeting, issues),
        "模型没有返回可用的定制招呼语"
      );
      const refined = normalizeRecruiterGreeting(parsed.greeting).slice(0, 800);
      if (refined) greeting = refined;
    } catch (error) {
      throw new Error(`定制招呼语质量重写失败：${error.message}`);
    }
    issues = recruiterGreetingIssues(greeting, analysis);
    if (issues.length) throw new Error(`定制招呼语未通过质量检查：${issues.join("；")}`);
    return greeting;
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

  async draftBossReply(input) {
    const payload = input?.chat ? input : { chat: input || {}, job: null, latestInbound: null };
    const latestInbound = bossLatestInboundText(payload);
    const provider = this.store.state.provider;
    const client = this.client();
    const prompt = bossReplyPrompt(payload, this.store.state.candidate);
    let text;
    if (provider.mode === "compatible-chat") {
      const response = await client.chat.completions.create({ model: provider.model, messages: [{ role: "user", content: prompt }] });
      text = response.choices[0]?.message?.content || "";
    } else {
      const response = await client.responses.create({ model: provider.model, input: prompt, store: false });
      text = response.output_text || "";
    }
    const parsed = extractJson(text);
    const categories = new Set([
      "routine",
      "salary",
      "interview-time",
      "privacy",
      "offer",
      "contract",
      "start-date",
      "relocation",
      "work-hours",
      "probation",
      "rejection",
      "unknown"
    ]);
    const sensitiveCategory = sensitiveBossReplyCategory(latestInbound);
    const deterministicRejection = isBossRejectionOnly(latestInbound);
    const action = deterministicRejection
      ? "ignore"
      : sensitiveCategory
        ? "reply"
        : parsed.action === "ignore" ? "ignore" : "reply";
    let category = deterministicRejection
      ? "rejection"
      : sensitiveCategory || (categories.has(parsed.category) ? parsed.category : "unknown");
    let draft = action === "ignore" ? "" : String(parsed.draft || "").trim().slice(0, 1200);
    if (action === "reply" && !draft && !sensitiveCategory) category = "unknown";
    const forcedConfirmation = action === "reply" && (category !== "routine" || !draft);
    const needsConfirmation = forcedConfirmation || (action === "reply" && Boolean(parsed.needsConfirmation));
    let reason = String(parsed.reason || "").slice(0, 200);
    if (deterministicRejection) reason = "检测到明确拒绝通知，无需回复";
    else if (sensitiveCategory) reason = `检测到 ${sensitiveCategory} 相关问题，需要本人确认`;
    else if (action === "reply" && !draft) reason = "模型未生成可安全发送的回复，需要本人确认";
    return {
      action,
      needsConfirmation,
      autoSend: action === "reply" && !needsConfirmation,
      category,
      reason,
      draft
    };
  }
}
