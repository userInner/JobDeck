import assert from "node:assert/strict";
import test from "node:test";
import { AIService } from "../server/ai.mjs";
import { bossReplyPrompt, jobCompatibilityPrompt, recruiterGreetingPrompt, resumeOptimizationPrompt } from "../server/prompts.mjs";
import { normalizeRecruiterGreeting, recruiterGreetingIssues } from "../server/greeting.mjs";

test("resume optimization keeps employment, independent projects and open source separate", () => {
  const prompt = resumeOptimizationPrompt({ sections: ["个人优势"], text: "在线简历" }, { score: 64 }, {
    status: "已毕业",
    targetRoles: ["AI Agent 工程师"],
    locations: ["深圳"],
    salaryFloorK: 25,
    salaryUpperTargetK: 30,
    facts: ["独立开发示例 Agent 项目"],
    resumeText: ""
  });
  assert.match(prompt, /正式工作经历、独立项目和开源贡献必须明确分开/);
  assert.match(prompt, /不能改写成正式任职/);
  assert.match(prompt, /可直接粘贴/);
});

test("bulk compatibility mode uses a binary decision without score thresholds", () => {
  const prompt = jobCompatibilityPrompt({
    title: "Go + AI 后端工程师",
    company: "示例公司",
    description: "负责 Agent 工具调用与 Go 服务开发"
  }, {
    status: "已毕业",
    targetRoles: ["AI Agent 工程师"],
    locations: ["深圳"],
    salaryFloorK: 25,
    salaryUpperTargetK: 30,
    facts: ["独立开发示例 Agent 项目"],
    resumeText: ""
  });
  assert.match(prompt, /不要计算分数/);
  assert.match(prompt, /"matches": true \| false/);
  assert.match(prompt, /技术栈是否相符/);
  assert.match(prompt, /岗位和城市已经由用户在 BOSS 求职期望中确定/);
  assert.doesNotMatch(prompt, /目标岗位：AI Agent 工程师/);
  assert.doesNotMatch(prompt, /目标地点：深圳/);
  assert.doesNotMatch(prompt, /薪资底线：25K/);
  assert.match(prompt, /第一句必须点出这个 JD 独有的业务场景/);
  assert.match(prompt, /正式经历用“正式工作中”/);
  assert.match(prompt, /不要罗列完整技术栈/);
  assert.match(prompt, /"businessDomain"/);
  assert.match(prompt, /"needsDomainBridge"/);
  assert.match(prompt, /不得根据公司名称或常识猜测|不得猜测/);
});

test("recruiter greeting rules reject generic BOSS copy and normalize visible noise", () => {
  const normalized = normalizeRecruiterGreeting("**老板你好！** 非常想加入你们 😊\n可以看下我的简历，期待回复");
  assert.equal(normalized, "您好，非常想加入你们 可以看下我的简历，期待回复");
  assert.ok(recruiterGreetingIssues(normalized, { matchedStack: ["Go", "MCP"] }).length >= 3);
});

test("a concise JD-specific greeting passes the local quality gate", () => {
  const greeting = "您好，看到岗位重点是将合同审查与知识库能力落到企业法务流程。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批；这些工程经验可迁移到法务 AI 产品建设。如果方向合适，方便进一步沟通吗？";
  assert.deepEqual(recruiterGreetingIssues(greeting, {
    matchedStack: ["Go", "MCP"],
    businessDomain: "法务 AI",
    needsDomainBridge: true
  }), []);
});

test("cross-industry greeting quality gate requires the extracted JD domain bridge", () => {
  const analysis = {
    matchedStack: ["Go", "MCP"],
    businessDomain: "法律 AI",
    needsDomainBridge: true
  };
  const missingBridge = "您好，看到岗位重点是合同审查与企业知识库。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批。如果方向合适，方便进一步沟通吗？";
  assert.ok(recruiterGreetingIssues(missingBridge, analysis).some((issue) => issue.includes("跨行业业务迁移桥接")));

  const withBridge = "您好，看到岗位重点是合同审查与企业知识库。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批；这些工程经验可以迁移到法律 AI 产品建设。如果方向合适，方便进一步沟通吗？";
  assert.ok(!recruiterGreetingIssues(withBridge, analysis).some((issue) => issue.includes("跨行业业务迁移桥接")));

  assert.ok(!recruiterGreetingIssues(missingBridge, {
    ...analysis,
    needsDomainBridge: false
  }).some((issue) => issue.includes("跨行业业务迁移桥接")));
});

test("job compatibility preserves the extracted domain bridge decision for the quality gate", async () => {
  const service = new AIService({
    state: {
      provider: { mode: "responses", model: "test-model" },
      candidate: { facts: ["正式工作使用 Go", "独立开发 OnPeople"] }
    },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          matches: true,
          matchedRole: "法律 AI 全栈工程师",
          matchedStack: ["Go", "MCP"],
          hardGaps: ["无法律行业正式经历"],
          summary: "工程能力可迁移到法律 AI 产品",
          businessDomain: "法律 AI",
          needsDomainBridge: true,
          greeting: "您好，看到岗位重点是合同审查与企业知识库。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批；这些工程经验可以迁移到法律 AI 产品建设。如果方向合适，方便进一步沟通吗？"
        })
      })
    }
  });

  const analysis = await service.matchJob({
    title: "法律 AI 全栈工程师",
    company: "示例公司",
    description: "负责合同审查与法律知识库"
  });
  assert.equal(analysis.businessDomain, "法律 AI");
  assert.equal(analysis.needsDomainBridge, true);
  assert.deepEqual(recruiterGreetingIssues(analysis.greeting, analysis), []);
});

test("scored job analysis also preserves the extracted domain bridge decision", async () => {
  const service = new AIService({
    state: {
      provider: { mode: "responses", model: "test-model" },
      candidate: { facts: ["正式工作使用 Go", "独立开发 OnPeople"] }
    },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          score: 82,
          verdict: "推荐",
          dimensions: { roleFit: 85, experience: 72, stack: 88, location: 100, compensation: 80 },
          strengths: ["Go 与 Agent 工程能力"],
          gaps: ["无法律行业正式经历"],
          summary: "工程能力可迁移到法律 AI 产品",
          businessDomain: "法律 AI",
          needsDomainBridge: true,
          greeting: "您好，看到岗位重点是合同审查与企业知识库。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批；这些工程经验可以迁移到法律 AI 产品建设。如果方向合适，方便进一步沟通吗？"
        })
      })
    }
  });
  const analysis = await service.analyzeJob({
    title: "法律 AI 全栈工程师",
    company: "示例公司",
    description: "负责合同审查与法律知识库"
  });
  assert.equal(analysis.businessDomain, "法律 AI");
  assert.equal(analysis.needsDomainBridge, true);
});

test("a failed greeting rewrite cannot bypass the cross-industry quality gate", async () => {
  const service = new AIService({
    state: { candidate: { facts: ["正式工作使用 Go", "独立开发 OnPeople"] } }
  });
  service.structured = async () => ({
    greeting: "您好，看到岗位重点是合同审查与企业知识库。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批。如果方向合适，方便进一步沟通吗？"
  });
  const analysis = {
    matchedStack: ["Go", "MCP"],
    businessDomain: "法律 AI",
    needsDomainBridge: true,
    greeting: "老板你好，可以看下我的简历，期待回复"
  };
  await assert.rejects(
    service.ensureRecruiterGreeting({ title: "法律 AI 全栈工程师" }, analysis),
    /缺少“法律 AI”跨行业业务迁移桥接/
  );
});

test("a compliant second greeting rewrite passes the cross-industry quality gate", async () => {
  const service = new AIService({
    state: { candidate: { facts: ["正式工作使用 Go", "独立开发 OnPeople"] } }
  });
  const refined = "您好，看到岗位重点是合同审查与企业知识库。我的正式工作以 Go 后端为主，并独立开发 OnPeople 的模型接入、MCP 工具调用和权限审批；这些工程经验可以迁移到法律 AI 产品建设。如果方向合适，方便进一步沟通吗？";
  service.structured = async () => ({ greeting: refined });
  const result = await service.ensureRecruiterGreeting({ title: "法律 AI 全栈工程师" }, {
    matchedStack: ["Go", "MCP"],
    businessDomain: "法律 AI",
    needsDomainBridge: true,
    greeting: "老板你好，可以看下我的简历，期待回复"
  });
  assert.equal(result, refined);
});

test("greeting rewrite prompt carries the JD, evidence boundary and failed-quality reason", () => {
  const prompt = recruiterGreetingPrompt({
    title: "AI 全栈工程师",
    company: "示例法务科技",
    description: "负责合同审查和企业知识库"
  }, {
    facts: ["独立开发 OnPeople"]
  }, {
    matchedStack: ["Go", "MCP"]
  }, "老板你好", ["包含平台默认或空泛话术"]);
  assert.match(prompt, /合同审查和企业知识库/);
  assert.match(prompt, /独立开发 OnPeople/);
  assert.match(prompt, /包含平台默认或空泛话术/);
  assert.match(prompt, /90 到 150 字/);
});

test("greeting rules prefer verified OnPeople and Cherry Studio evidence when relevant", () => {
  const prompt = recruiterGreetingPrompt({
    title: "AI Agent 全栈工程师",
    company: "示例公司",
    description: "建设 Agent Runtime、工具调用与桌面工作台"
  }, {
    facts: [
      "独立开发基于 OpenAI Codex App Server 的 OnPeople Agent 工作台",
      "Cherry Studio GitHub 5 万+ Star、前 30 贡献者"
    ]
  }, { matches: true }, "原始招呼");

  assert.match(prompt, /OpenAI Codex App Server/);
  assert.match(prompt, /5 万\+ Star、前 30 贡献者/);
  assert.match(prompt, /不要把这些事实套用给其他候选人/);
});

test("cross-industry greetings bridge verified engineering evidence to the JD domain", () => {
  const prompt = recruiterGreetingPrompt({
    title: "法律 AI 全栈工程师",
    company: "示例法务科技",
    description: "建设合同审查、企业知识库和智能法务工作流"
  }, {
    facts: ["正式工作使用 Go 开发分布式后端", "独立开发 OnPeople Agent 工作台"]
  }, { matchedStack: ["Go", "Agent"] }, "原始招呼");

  assert.match(prompt, /这些工程经验可以迁移到法律 AI 产品建设/);
  assert.match(prompt, /从 JD 提取具体业务领域/);
  assert.match(prompt, /不得暗示候选人已有该行业经验/);
});

test("BOSS reply prompt is driven by the latest recruiter question and the full JD", () => {
  const prompt = bossReplyPrompt({
    chat: {
      recruiter: "蒋女士",
      jobTitle: "AI 全栈工程师",
      company: "示例科技",
      messages: [
        { from: "candidate", text: "您好，岗位方向与我的实践匹配。" },
        { from: "recruiter", text: "你有 Telegram Bot 和行情机器人经验吗？" }
      ]
    },
    latestInbound: { from: "recruiter", text: "你有 Telegram Bot 和行情机器人经验吗？" },
    job: {
      title: "AI 全栈工程师",
      company: "示例科技",
      location: "深圳",
      salary: "25-40K",
      description: "负责交易行情机器人、Agent 工具调用和 Go 服务的产品化交付。"
    }
  }, {
    status: "已毕业",
    facts: [
      "正式工作以 Web3 与 Go 分布式后端为主",
      "独立开发 OnPeople Agent 工作台",
      "参与 Cherry Studio 开源贡献",
      "具备 Telegram Bot 和交易行情机器人开发经验"
    ]
  });

  assert.match(prompt, /你有 Telegram Bot 和行情机器人经验吗/);
  assert.match(prompt, /交易行情机器人、Agent 工具调用和 Go 服务/);
  assert.match(prompt, /先直接回答问题/);
  assert.match(prompt, /OnPeople 必须写成“独立开发/);
  assert.match(prompt, /Cherry Studio 必须写成“开源贡献/);
  assert.match(prompt, /只有 routine 可以 needsConfirmation=false/);
  assert.match(prompt, /"action": "reply" \| "ignore"/);
});

test("BOSS reply prompt remains compatible with the original chat-only call", () => {
  const prompt = bossReplyPrompt({
    recruiter: "招聘方",
    jobTitle: "Go 工程师",
    messages: [{ from: "recruiter", text: "主要使用过哪些消息队列？" }]
  }, { facts: ["正式工作使用 RabbitMQ"] });

  assert.match(prompt, /主要使用过哪些消息队列/);
  assert.match(prompt, /岗位标题：Go 工程师/);
  assert.match(prompt, /未获取到完整 JD/);
});

test("BOSS reply prompt never treats a platform card as the latest recruiter question", () => {
  const prompt = bossReplyPrompt({
    recruiter: "招聘方",
    jobTitle: "AI 工程师",
    messages: [
      { from: "recruiter", text: "你做过 Telegram Bot 吗？" },
      { from: "system", text: "你与该职位竞争者 PK 情况" }
    ]
  }, { facts: ["具备 Telegram Bot 开发经验"] });

  assert.match(prompt, /招聘方最新消息（必须直接回应）：\n你做过 Telegram Bot 吗/);
  assert.match(prompt, /招聘方：你做过 Telegram Bot 吗/);
  assert.match(prompt, /平台通知：你与该职位竞争者 PK 情况/);
  assert.doesNotMatch(prompt, /招聘方最新消息（必须直接回应）：\n你与该职位竞争者 PK 情况/);
});

test("AI reply fallback selects recruiter text rather than a newer system card", async () => {
  let capturedPrompt = "";
  const service = new AIService({
    state: { provider: { mode: "responses", model: "test-model" }, candidate: { facts: [] } },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async (request) => {
        capturedPrompt = String(request.input || "");
        return {
          output_text: JSON.stringify({
            action: "reply",
            needsConfirmation: false,
            category: "routine",
            reason: "可由已核实事实回答",
            draft: "有，做过 Telegram Bot。"
          })
        };
      }
    }
  });

  await service.draftBossReply({
    messages: [
      { from: "recruiter", text: "你做过 Telegram Bot 吗？" },
      { from: "system", text: "你与该职位竞争者 PK 情况" }
    ]
  });

  assert.match(capturedPrompt, /招聘方最新消息（必须直接回应）：\n你做过 Telegram Bot 吗/);
  assert.doesNotMatch(capturedPrompt, /招聘方最新消息（必须直接回应）：\n你与该职位竞争者 PK 情况/);
});

test("routine JD-aware BOSS replies are eligible for automatic sending", async () => {
  const service = new AIService({
    state: {
      provider: { mode: "responses", model: "test-model" },
      candidate: { facts: ["正式工作使用 Go 和 RabbitMQ", "独立开发 OnPeople"] }
    },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          action: "reply",
          needsConfirmation: false,
          category: "routine",
          reason: "可由已核实技术事实回答",
          draft: "有，正式工作中使用 Go 和 RabbitMQ 处理异步任务；岗位提到的 Agent 工具链方面，我也在独立开发的 OnPeople 中实现了工具调用与失败恢复。"
        })
      })
    }
  });

  const result = await service.draftBossReply({
    chat: { messages: [{ from: "recruiter", text: "你有消息队列和 Agent 工具调用经验吗？" }] },
    latestInbound: { from: "recruiter", text: "你有消息队列和 Agent 工具调用经验吗？" },
    job: { title: "Go + AI 后端工程师", description: "负责 RabbitMQ 异步任务与 Agent 工具链" }
  });

  assert.equal(result.action, "reply");
  assert.equal(result.category, "routine");
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.autoSend, true);
  assert.match(result.draft, /正式工作中/);
  assert.match(result.draft, /独立开发的 OnPeople/);
});

test("sensitive recruiter questions cannot be auto-sent even when the model says routine", async () => {
  const cases = [
    ["方便说一下你的期望薪资吗？", "salary"],
    ["明天下午三点面试可以吗？", "interview-time"],
    ["请发一下你的手机号。", "privacy"],
    ["这个 offer 你是否接受？", "offer"],
    ["能签竞业协议吗？", "contract"],
    ["最快什么时候可以到岗？", "start-date"],
    ["是否接受驻场？", "relocation"],
    ["能接受大小周吗？", "work-hours"],
    ["试用期可以接受吗？", "probation"]
  ];
  const service = new AIService({
    state: { provider: { mode: "responses", model: "test-model" }, candidate: { facts: [] } },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          action: "reply",
          needsConfirmation: false,
          category: "routine",
          reason: "模型误判为常规问题",
          draft: "可以。"
        })
      })
    }
  });

  for (const [question, category] of cases) {
    const result = await service.draftBossReply({
      chat: { messages: [{ from: "recruiter", text: question }] },
      latestInbound: { from: "recruiter", text: question },
      job: { title: "AI 工程师", description: "负责 AI 应用研发和交付" }
    });
    assert.equal(result.category, category, question);
    assert.equal(result.needsConfirmation, true, question);
    assert.equal(result.autoSend, false, question);
    assert.match(result.reason, /需要本人确认/, question);
  }
});

test("implicit interview availability cannot be misclassified as routine", async () => {
  const questions = [
    "明天下午方便吗？",
    "明天下午可以吗？",
    "现在方便电话聊一下吗？",
    "今晚方便电话沟通吗？",
    "能接个电话吗？",
    "什么时候方便视频聊一下？",
    "Are you available for a phone call tomorrow?"
  ];
  const service = new AIService({
    state: { provider: { mode: "responses", model: "test-model" }, candidate: { facts: [] } },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          action: "reply",
          needsConfirmation: false,
          category: "routine",
          reason: "模型误判为常规问题",
          draft: "可以。"
        })
      })
    }
  });

  for (const question of questions) {
    const result = await service.draftBossReply({
      chat: { messages: [{ from: "recruiter", text: question }] },
      latestInbound: { from: "recruiter", text: question }
    });
    assert.equal(result.action, "reply", question);
    assert.equal(result.category, "interview-time", question);
    assert.equal(result.needsConfirmation, true, question);
    assert.equal(result.autoSend, false, question);
  }
});

test("model ignore cannot bypass deterministic sensitive questions", async () => {
  const cases = [
    ["方便说一下你的期望薪资吗？", "salary"],
    ["明天下午方便吗？", "interview-time"],
    ["请发一下你的手机号。", "privacy"],
    ["这个 offer 你是否接受？", "offer"],
    ["需要签署劳动合同。", "contract"],
    ["能签竞业协议吗？", "contract"],
    ["股权方案可以接受吗？", "contract"],
    ["最快什么时候可以到岗？", "start-date"],
    ["是否接受驻场？", "relocation"],
    ["能接受大小周吗？", "work-hours"],
    ["试用期可以接受吗？", "probation"]
  ];
  const service = new AIService({
    state: { provider: { mode: "responses", model: "test-model" }, candidate: { facts: [] } },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          action: "ignore",
          needsConfirmation: false,
          category: "routine",
          reason: "模型认为无需回复",
          draft: ""
        })
      })
    }
  });

  for (const [question, category] of cases) {
    const result = await service.draftBossReply({
      chat: { messages: [{ from: "recruiter", text: question }] },
      latestInbound: { from: "recruiter", text: question }
    });
    assert.equal(result.action, "reply", question);
    assert.equal(result.category, category, question);
    assert.equal(result.needsConfirmation, true, question);
    assert.equal(result.autoSend, false, question);
    assert.match(result.reason, /需要本人确认/, question);
  }
});

test("rejection-only messages are ignored even if the model drafts a reply", async () => {
  const service = new AIService({
    state: { provider: { mode: "responses", model: "test-model" }, candidate: { facts: [] } },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          action: "reply",
          needsConfirmation: false,
          category: "routine",
          reason: "建议礼貌回复",
          draft: "感谢您的回复。"
        })
      })
    }
  });

  const result = await service.draftBossReply({
    chat: { messages: [{ from: "recruiter", text: "很遗憾，本次岗位暂不合适。" }] },
    latestInbound: "很遗憾，本次岗位暂不合适。",
    job: { title: "AI 工程师", description: "负责 AI 应用研发" }
  });

  assert.equal(result.action, "ignore");
  assert.equal(result.category, "rejection");
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.autoSend, false);
  assert.equal(result.reason, "检测到明确拒绝通知，无需回复");
  assert.equal(result.draft, "");
});

test("explicit rejection remains ignored when it mentions a sensitive topic", async () => {
  const service = new AIService({
    state: { provider: { mode: "responses", model: "test-model" }, candidate: { facts: [] } },
    secrets: { apiKey: "test-key" }
  });
  service.client = () => ({
    responses: {
      create: async () => ({
        output_text: JSON.stringify({
          action: "ignore",
          needsConfirmation: false,
          category: "routine",
          reason: "模型认为无需回复",
          draft: ""
        })
      })
    }
  });

  const message = "很遗憾，您的期望薪资与岗位不匹配，无法继续推进。";
  const result = await service.draftBossReply({
    chat: { messages: [{ from: "recruiter", text: message }] },
    latestInbound: { from: "recruiter", text: message }
  });

  assert.equal(result.action, "ignore");
  assert.equal(result.category, "rejection");
  assert.equal(result.needsConfirmation, false);
  assert.equal(result.autoSend, false);
  assert.equal(result.draft, "");
});
