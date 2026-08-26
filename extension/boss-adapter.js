function jobdeckBossChatSnapshot({ compact, visible, selectorFor }) {
  const geometry = (element) => {
    if (!element) return {};
    const rect = element.getBoundingClientRect();
    return {
      point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
      bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  };
  const firstVisibleWithin = (root, selectors) => {
    if (!root) return null;
    for (const selector of selectors) {
      const ownMatch = root.matches?.(selector) && visible(root) ? root : null;
      const element = ownMatch || [...root.querySelectorAll(selector)].find(visible);
      if (element) return element;
    }
    return null;
  };
  const firstVisible = (selectors) => firstVisibleWithin(document, selectors);
  const firstTextWithin = (root, selectors, limit = 8000) => {
    if (!root) return "";
    for (const selector of selectors) {
      const element = root.matches?.(selector) && visible(root)
        ? root
        : [...root.querySelectorAll(selector)].find(visible);
      const text = compact(element?.innerText || element?.textContent || "", limit);
      if (text) return text;
    }
    return "";
  };
  const selectedConversation = firstVisible([
    "[data-conversation-id][aria-selected='true']",
    "[data-conversation-id].active",
    "[data-chat-id][aria-selected='true']",
    "[data-chat-id].active",
    "[data-boss-id][aria-selected='true']",
    "[data-boss-id].active",
    "[class*='chat-item'][class*='active']",
    "[class*='conversation-item'][class*='active']"
  ]);
  const composerSelectors = [
    "textarea[placeholder*='消息']",
    "textarea[placeholder*='回复']",
    "[contenteditable='true'][role='textbox']",
    "textarea",
    "[contenteditable='true']"
  ];
  const messageListSelectors = [
    ".chat-record",
    ".message-list",
    "[class*='message-list']",
    "[class*='chat-record']",
    "[role='log']"
  ];
  const messageProbeSelectors = [
    "[data-message-id]",
    "[data-msg-id]",
    "[data-messageid]",
    ".message-item",
    ".chat-message",
    ".chat-record > li"
  ];
  const chatPanelSelector = [
    "[data-conversation-panel]",
    "[data-chat-panel]",
    "[role='main'][class*='chat']",
    ".chat-conversation",
    ".chat-dialog",
    ".chat-container",
    "[class*='conversation-content']",
    "[class*='chat-content']",
    "[class*='message-panel']"
  ].join(",");
  const panelMessageList = (panel) => firstVisibleWithin(panel, messageListSelectors)
    || (messageProbeSelectors.some((selector) => firstVisibleWithin(panel, [selector])) ? panel : null);
  const panelComposer = (panel) => firstVisibleWithin(panel, composerSelectors);
  const controlledPanel = (() => {
    if (!selectedConversation) return null;
    const target = [
      selectedConversation.getAttribute("aria-controls"),
      selectedConversation.getAttribute("data-target"),
      selectedConversation.getAttribute("href")
    ].find(Boolean);
    if (!target) return null;
    const id = String(target).replace(/^#/, "").trim();
    if (!id) return null;
    const panel = document.getElementById?.(id);
    return panel && visible(panel) && panelComposer(panel) && panelMessageList(panel) ? panel : null;
  })();
  const composerPanels = [...document.querySelectorAll(composerSelectors.join(","))]
    .filter(visible)
    .flatMap((composerCandidate) => {
      let node = composerCandidate.parentElement;
      while (node) {
        if (node.matches?.(chatPanelSelector) && panelComposer(node) && panelMessageList(node)) return [node];
        node = node.parentElement;
      }
      return [];
    });
  const visiblePanels = [...document.querySelectorAll(chatPanelSelector)]
    .filter(visible)
    .filter((panel) => panelComposer(panel) && panelMessageList(panel));
  const panelCandidates = [...new Set([...composerPanels, ...visiblePanels])]
    // If both a broad page container and its actual conversation panel match,
    // keep the smallest descendant that still owns the composer and messages.
    .filter((panel, _index, panels) => !panels.some((other) => other !== panel && panel.contains(other)));
  const chatPanel = controlledPanel || (panelCandidates.length === 1 ? panelCandidates[0] : null);
  const scopeReliable = Boolean(chatPanel);
  const scopeReason = scopeReliable ? "selected-chat-panel"
    : panelCandidates.length > 1 ? "ambiguous-chat-panel" : "missing-chat-panel";
  const composer = firstVisibleWithin(chatPanel, composerSelectors);
  const composerValue = composer
    ? compact("value" in composer ? composer.value : composer.innerText || composer.textContent || "", 1200)
    : "";

  // BOSS currently mixes several message-container families in the same
  // conversation (especially across historical and newly appended bubbles).
  // Collect every family, normalize descendants back to their message root,
  // then de-duplicate in DOM order so send verification sees the full chat.
  const primaryMessageSelectors = [
    "[data-message-id]",
    "[data-msg-id]",
    "[data-messageid]",
    ".message-item",
    ".chat-message",
    ".chat-record > li",
    "[class*='message-item']:not([class*='content'])"
  ];
  const fallbackMessageSelectors = [
    "[class*='message-content']",
    "[class*='bubble-content']",
    "[class*='bubble']"
  ];
  const messageRoots = [
    "[data-message-id]",
    "[data-msg-id]",
    "[data-messageid]",
    ".message-item",
    ".chat-message",
    ".chat-record > li"
  ].join(",");
  const messageList = panelMessageList(chatPanel);
  const visibleFor = (selector) => messageList
    ? [...messageList.querySelectorAll(selector)].filter(visible)
    : [];
  const messageElements = [...new Set(
    [...primaryMessageSelectors, ...fallbackMessageSelectors]
      .flatMap((selector) => visibleFor(selector))
      .map((element) => element.closest(messageRoots) || element)
  )]
    .filter(visible)
    // Broad fallback selectors can yield both an outer bubble and its content
    // node. Keep the leaf unless the outer node is a recognized message root;
    // recognized roots carry the durable message identity when available.
    .filter((element, _index, elements) => element.matches(messageRoots)
      || !elements.some((other) => other !== element && element.contains(other)))
    .sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

  const chatRoot = messageList || chatPanel;
  const chatRect = chatRoot?.getBoundingClientRect();
  const stableMessageId = (element) => {
    for (const attr of ["data-message-id", "data-msg-id", "data-messageid"]) {
      const value = element.getAttribute(attr);
      if (value) return { id: `${attr}:${value}`, source: "attribute" };
    }
    if (element.id) return { id: `id:${element.id}`, source: "element-id" };
    return { id: `selector:${selectorFor(element)}`, source: "selector" };
  };
  const messageContent = (element) => [
      ".message-content",
      "[class*='message-content']",
      ".bubble-content",
      "[class*='bubble-content']"
    ].map((selector) => element.querySelector(selector)).find((candidate) => candidate && visible(candidate)) || element;
  const messageText = (element) => {
    const content = messageContent(element);
    return compact(content?.innerText || content?.textContent || element.innerText || element.textContent || "", 1200);
  };
  const systemMessage = (element, text) => {
    const roleElement = element.closest("[role], [data-type], [data-message-type], [data-kind]") || element;
    const hint = compact([
      roleElement.getAttribute("role"),
      roleElement.getAttribute("data-type"),
      roleElement.getAttribute("data-message-type"),
      roleElement.getAttribute("data-kind"),
      String(roleElement.className || ""),
      String(element.className || "")
    ].filter(Boolean).join(" "), 800);
    if (/(?:^|[-_\s])(system|notice|notification|status|platform|competition|pk-card)(?:$|[-_\s])/i.test(hint)) return true;
    return /(?:你与该职位竞争者\s*PK\s*情况|竞争者\s*PK|优秀竞争者|查看详细分析|平台安全提示|系统通知|系统消息)/i.test(text);
  };
  const messageFrom = (element) => {
    const roleElement = element.closest("[data-from], [data-direction], [data-owner]") || element;
    const explicitRole = compact([
      roleElement.getAttribute("data-from"),
      roleElement.getAttribute("data-direction"),
      roleElement.getAttribute("data-owner")
    ].filter(Boolean).join(" "), 240);
    if (/candidate|self|mine|my(?:-|_|\b)|right|sent|outgoing|from-me/i.test(explicitRole)) return "candidate";
    if (/recruiter|boss|other|left|received|incoming|from-other/i.test(explicitRole)) return "recruiter";
    const roleHint = compact([
      roleElement.getAttribute("aria-label"),
      String(roleElement.className || ""),
      String(element.parentElement?.className || "")
    ].filter(Boolean).join(" "), 600);
    if (/candidate|self|mine|my(?:-|_|\b)|sent|outgoing|from-me|item-myself|message-self/i.test(roleHint)) return "candidate";
    if (/recruiter|other|received|incoming|from-other|friend|item-friend|message-receive/i.test(roleHint)) return "recruiter";

    // Geometry is only evidence when a compact bubble is very clearly pinned
    // to one side of the active conversation. Full-width/central cards are not
    // recruiter messages and must remain unknown.
    const rect = messageContent(element).getBoundingClientRect();
    if (!chatRect || !rect.width || rect.width > chatRect.width * 0.72) return "unknown";
    const leftGap = Math.max(0, rect.left - chatRect.left);
    const rightGap = Math.max(0, chatRect.right - rect.right);
    const separation = Math.max(36, chatRect.width * 0.12);
    if (leftGap - rightGap >= separation && rightGap <= leftGap * 0.3) return "candidate";
    if (rightGap - leftGap >= separation && leftGap <= rightGap * 0.3) return "recruiter";
    return "unknown";
  };

  const records = messageElements.flatMap((element) => {
    const text = messageText(element);
    if (!text) return [];
    const identity = stableMessageId(element);
    return [{
      element,
      id: identity.id,
      idSource: identity.source,
      from: systemMessage(element, text) ? "system" : messageFrom(element),
      text
    }];
  });
  const deduped = [];
  const identityRank = (record) => record.idSource === "attribute" ? 3
    : record.idSource === "element-id" ? 2 : 1;
  for (const record of records) {
    const duplicateIndex = deduped.findIndex((existing) => {
      if (existing.id === record.id) return true;
      const nested = existing.element.contains(record.element) || record.element.contains(existing.element);
      if (!nested || existing.from !== record.from) return false;
      return existing.text === record.text
        || existing.text.includes(record.text)
        || record.text.includes(existing.text);
    });
    if (duplicateIndex < 0) {
      deduped.push(record);
    } else if (identityRank(record) > identityRank(deduped[duplicateIndex])) {
      // Keep the chronological slot, but prefer a durable attribute/id over a
      // selector-derived identity for restart-safe reply de-duplication.
      deduped[duplicateIndex] = record;
    }
  }
  const latestSenderUnknown = deduped.at(-1)?.from === "unknown";
  // The server intentionally ignores unknown senders. Suppress older known
  // messages while an ambiguous newest bubble is visible, otherwise it could
  // answer a stale recruiter question as if the ambiguous bubble did not exist.
  const safeRecords = latestSenderUnknown ? [deduped.at(-1)] : deduped;
  const messages = safeRecords.filter(Boolean).slice(-30).map(({ id, idSource, from, text }) => ({ id, idSource, from, text }));
  const transcript = messages.length ? "" : firstTextWithin(chatPanel, [
    ".chat-record",
    "[class*='message-list']",
    "[class*='chat-content']"
  ], 8000);

  let conversationId = "";
  let conversationIdSource = "";
  for (const attr of ["data-conversation-id", "data-chat-id", "data-boss-id", "data-friend-id"]) {
    const value = selectedConversation?.getAttribute(attr) || chatPanel?.getAttribute(attr);
    if (!value) continue;
    conversationId = compact(value, 240);
    conversationIdSource = attr;
    break;
  }
  if (!conversationId) {
    try {
      const chatUrl = new URL(location.href);
      for (const key of ["conversationId", "chatId", "bossId", "encryptBossId", "friendId", "securityId"]) {
        const value = chatUrl.searchParams.get(key);
        if (!value) continue;
        conversationId = compact(value, 240);
        conversationIdSource = `query:${key}`;
        break;
      }
    } catch {
      // The visible recruiter/job identity remains available as a fallback.
    }
  }

  const recruiter = firstTextWithin(chatPanel, [".chat-info .name", ".user-name", "[class*='chat-header'] [class*='name']"], 160);
  const jobTitle = firstTextWithin(chatPanel, [".chat-job", ".job-name", "[class*='job-title']"], 180);
  const company = firstTextWithin(chatPanel, [".company-name", "[class*='company-name']"], 180);
  const stableBossJobUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== "https:" || !/(^|\.)zhipin\.com$/i.test(url.hostname)) return "";
      if (!/(?:job_detail|\/job\/)/i.test(url.pathname)) return "";
      // Query parameters frequently contain short-lived tracking/security
      // values.  The pathname is the stable job identity used to associate a
      // chat with the saved full JD.
      return `${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  };
  const jobLinkRoots = [
    firstVisibleWithin(chatPanel, [".chat-info", ".chat-header", "[class*='chat-header']", "[class*='chat-info']"]),
    firstVisibleWithin(chatPanel, [".chat-job", ".job-name", "[class*='job-title']"])?.closest("header, section, article, div")
  ].filter(Boolean);
  const scopedJobLinks = jobLinkRoots.flatMap((root) => [
    ...(root.matches?.("a[href]") ? [root] : []),
    ...root.querySelectorAll("a[href]")
  ]);
  const panelJobLinks = chatPanel
    ? [...chatPanel.querySelectorAll("a[href*='job_detail'], a[href*='/job/']")].filter(visible)
    : [];
  const jobLinks = [...new Set([...scopedJobLinks, ...panelJobLinks])]
    .flatMap((anchor) => {
      const url = stableBossJobUrl(anchor.href || anchor.getAttribute("href"));
      if (!url) return [];
      const context = compact((anchor.closest("header, section, article, li, [class*='chat']") || anchor).innerText, 600);
      const identityMatch = Boolean(
        (jobTitle && context.includes(jobTitle))
        || (company && context.includes(company))
      );
      const scoped = jobLinkRoots.some((root) => root === anchor || root.contains(anchor));
      return [{ url, identityMatch, scoped }];
    });
  const preferredJobUrls = [...new Set(
    jobLinks.filter((item) => item.scoped || item.identityMatch).map((item) => item.url)
  )];
  const allJobUrls = [...new Set(jobLinks.map((item) => item.url))];
  // A chat page can retain links from several conversations.  Never guess
  // between conflicting job identities: the server can safely report
  // `missing-jd` instead of replying against the wrong JD.
  const jobUrl = preferredJobUrls.length === 1
    ? preferredJobUrls[0]
    : preferredJobUrls.length === 0 && allJobUrls.length === 1 ? allJobUrls[0] : "";

  return {
    recruiter,
    jobTitle,
    company,
    jobUrl,
    conversationId,
    conversationIdSource,
    scopeReliable,
    scopeReason,
    senderReliable: !latestSenderUnknown,
    messages,
    transcript,
    composer: composer ? {
      selector: selectorFor(composer),
      tag: composer.tagName.toLowerCase(),
      valuePreview: composerValue,
      ...geometry(composer)
    } : null
  };
}

function bossInspectPage() {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const compact = (value, limit = 500) => String(value || "")
    .replace(/[\uE031-\uE03A]/g, (character) => String(character.codePointAt(0) - 0xE031))
    .replace(/\s+/g, " ").trim().slice(0, limit);
  const labelOf = (element) => {
    if (element instanceof HTMLInputElement && ["button", "submit"].includes(element.type)) return element.value.trim();
    return compact(element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.textContent || "", 180);
  };
  const cssEscape = (value) => window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const selectorFor = (element) => {
    if (element.id) return `#${cssEscape(element.id)}`;
    for (const attr of ["data-testid", "data-e2e", "name", "aria-label", "placeholder"]) {
      const value = element.getAttribute(attr);
      if (value) return `${element.tagName.toLowerCase()}[${attr}="${value.replace(/"/g, "\\\"")}"]`;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const stableClasses = [...node.classList].filter((name) => !/active|selected|hover|\d{3,}|^css-/i.test(name)).slice(0, 2);
      if (stableClasses.length) part += stableClasses.map((name) => `.${cssEscape(name)}`).join("");
      const siblings = [...node.parentElement?.children || []].filter((item) => item.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const firstText = (selectors, limit = 8000) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const value = compact(element?.innerText || element?.textContent || "", limit);
      if (value) return value;
    }
    return "";
  };
  const firstElement = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && visible(element)) return element;
    }
    return null;
  };
  const textWithin = (root, selectors, limit = 8000) => {
    if (!root) return "";
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = compact(element?.innerText || element?.textContent || "", limit);
      if (value) return value;
    }
    return "";
  };
  const safeUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  };

  const pathname = location.pathname;
  const pageType = /\/web\/geek\/chat|\/web\/chat/.test(pathname) ? "chat"
    : /\/web\/geek\/resume|\/web\/user/.test(pathname) ? "resume"
      : /\/job_detail\//.test(pathname) ? "job-detail"
        : /\/web\/geek\/jobs|\/c\d+/.test(pathname) ? "job-list"
          : "other";

  const interactives = [...document.querySelectorAll("button, a[href], input, textarea, select, [role='button'], [contenteditable='true']")]
    .filter(visible)
    .slice(0, 220)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(), label: labelOf(element), selector: selectorFor(element),
        type: element.getAttribute("type") || undefined,
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        valuePreview: "value" in element ? String(element.value || "").slice(0, 600) : undefined,
        point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
        bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    })
    .filter((item) => item.label || item.tag === "input" || item.tag === "textarea");

  const linkElements = [...document.querySelectorAll("a[href]")].filter(visible).slice(0, 260);
  const links = linkElements.flatMap((element) => {
    const href = safeUrl(element.href);
    if (!href) return [];
    const container = element.closest("li, article, [class*='job-card'], [class*='job-list']") || element.parentElement;
    return [{ href, label: labelOf(element), context: compact(container?.innerText || "", 900) }];
  });

  const cardSelectors = [
    ".job-card-wrapper", ".job-list-box li", ".rec-job-list li", "[class*='job-card']", "[class*='job-list'] li"
  ];
  const cardElements = [...new Set(cardSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(visible).slice(0, 80);
  const jobCards = [];
  const cardUrls = new Set();
  for (const card of cardElements) {
    const anchor = card.querySelector("a[href*='job_detail'], a[href*='/job/'], a[href]");
    const url = safeUrl(anchor?.href);
    const context = compact(card.innerText, 1200);
    if (!url || cardUrls.has(url) || !/(?:K|薪|工程师|开发|算法|Agent|AI|LLM)/i.test(context)) continue;
    cardUrls.add(url);
    const textIn = (selectors) => {
      for (const selector of selectors) {
        const value = compact(card.querySelector(selector)?.innerText || "", 180);
        if (value) return value;
      }
      return "";
    };
    const anchorRect = anchor?.getBoundingClientRect();
    const classHint = `${String(card.className || "")} ${String(card.getAttribute("aria-selected") || "")}`;
    jobCards.push({
      url,
      title: textIn([".job-name", ".job-title", "[class*='job-name']", "[class*='job-title']"]) || labelOf(anchor),
      company: textIn([".company-info .company-name a", ".company-info .company-name", ".company-info h3", ".company-info a", "[class*='company-info'] [class*='name']", "[class*='company-info'] a", ".company-name", "[class*='company-name']", "[class*='company'] [class*='name']", "[class*='company'] a"]),
      salary: textIn([".salary", ".job-salary", "[class*='salary']"]) || context.match(/\d{1,3}\s*[-–—]\s*\d{1,3}K(?:·\d+薪)?/i)?.[0] || "",
      location: textIn([".job-area", ".job-location", "[class*='area']", "[class*='location']"]) || context.match(/北京|深圳|上海|杭州|广州|成都|武汉|南京|苏州|远程/)?.[0] || "",
      context,
      selector: selectorFor(anchor || card),
      selected: /active|selected|current|cur\b|true/i.test(classHint),
      point: anchorRect ? { x: Math.round(anchorRect.left + anchorRect.width / 2), y: Math.round(anchorRect.top + anchorRect.height / 2) } : undefined,
      bounds: anchorRect ? { x: Math.round(anchorRect.left), y: Math.round(anchorRect.top), width: Math.round(anchorRect.width), height: Math.round(anchorRect.height) } : undefined
    });
  }

  let job;
  const detailRoot = pageType === "job-list" ? firstElement([
    ".job-detail-box", ".job-detail-container", ".job-detail-content", ".job-detail-wrap", "[class*='job-detail-container']"
  ]) : document;
  const detailText = compact(detailRoot?.innerText || "", 24_000);
  if (pageType === "job-detail" || (pageType === "job-list" && detailRoot && /职位描述|岗位职责|任职要求/.test(detailText))) {
    const bodyText = detailText || compact(document.body?.innerText || "", 24_000);
    const title = textWithin(detailRoot, ["h1.job-name", "h2.job-name", ".job-name", ".job-title", ".name h1", ".name h2", "[class*='job-name']"], 180);
    const selectedCard = jobCards.find((card) => card.selected)
      || jobCards.find((card) => title && compact(card.title, 120).includes(compact(title, 120)));
    job = {
      title: title || selectedCard?.title || compact(document.querySelector("h1")?.innerText, 180),
      company: textWithin(detailRoot, [".company-info .name", ".company-name", "[class*='company-name']", ".sider-company h3"], 180) || selectedCard?.company || "",
      salary: textWithin(detailRoot, [".salary", ".job-salary", "[class*='salary']"], 80) || bodyText.match(/\d{1,3}\s*[-–—]\s*\d{1,3}K(?:·\d+薪)?/i)?.[0] || selectedCard?.salary || "",
      location: textWithin(detailRoot, [".text-desc", ".job-address", ".location-address", "[class*='job-location']"], 160) || bodyText.match(/北京|深圳|上海|杭州|广州|成都|武汉|南京|苏州|远程/)?.[0] || selectedCard?.location || "",
      description: textWithin(detailRoot, [".job-sec-text", ".job-detail-section", ".job-detail", "[class*='job-detail']"], 18_000) || bodyText,
      recruiter: textWithin(detailRoot, [".boss-name", ".boss-info-attr", "[class*='boss-name']"], 160),
      url: selectedCard?.url || location.href
    };
  }

  let chat;
  if (pageType === "chat") {
    chat = jobdeckBossChatSnapshot({ compact, visible, selectorFor });
  }

  let resume;
  if (pageType === "resume") {
    const sectionSelectors = [".resume-item", ".resume-section", "[class*='resume-item']", "[class*='resume-section']"];
    const sectionElements = [...new Set(sectionSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter(visible).slice(0, 40);
    const sections = sectionElements.map((element) => compact(element.innerText, 2400)).filter(Boolean);
    const keyFor = (text) => /个人优势/.test(text) ? "personalAdvantage"
      : /期望职位|求职意向/.test(text) ? "targetRoles"
        : /工作经历/.test(text) ? "workExperience"
          : /项目经历/.test(text) ? "projectExperience"
            : /教育经历/.test(text) ? "education"
              : /专业技能/.test(text) ? "skills" : "other";
    const sectionDetails = sectionElements.map((element) => {
      const rect = element.getBoundingClientRect();
      const text = compact(element.innerText, 2400);
      const rawLabel = String(element.innerText || "").split("\n").map((line) => line.trim()).find(Boolean) || text.slice(0, 40);
      const controlCandidates = [...element.querySelectorAll("button, a, [role='button'], [class*='edit'], [class*='add'], [class*='modify']")];
      const controls = controlCandidates.flatMap((control) => {
        const hint = compact(`${labelOf(control)} ${control.getAttribute("title") || ""} ${control.getAttribute("aria-label") || ""} ${String(control.className || "")}`, 240);
        if (!/编辑|添加|修改|edit|add|modify/i.test(hint)) return [];
        const controlRect = control.getBoundingClientRect();
        return [{
          label: hint || "编辑",
          selector: selectorFor(control),
          unique: document.querySelectorAll(selectorFor(control)).length === 1,
          visible: visible(control),
          bounds: { x: Math.round(controlRect.left), y: Math.round(controlRect.top), width: Math.round(controlRect.width), height: Math.round(controlRect.height) }
        }];
      }).slice(0, 12);
      const recordElements = [...new Set([
        ...element.querySelectorAll(":scope > .item-primary > ul > li"),
        ...element.querySelectorAll(":scope > .item-primary > ul > div > li")
      ])].filter(visible).slice(0, 16);
      const recordDetails = recordElements.map((record) => {
        const recordRect = record.getBoundingClientRect();
        const recordControls = [...record.querySelectorAll("button, a, [role='button'], [class*='edit'], [class*='modify']")].flatMap((control) => {
          const hint = compact(`${labelOf(control)} ${control.getAttribute("title") || ""} ${control.getAttribute("aria-label") || ""} ${String(control.className || "")}`, 240);
          if (!/编辑|修改|edit|modify/i.test(hint)) return [];
          const controlRect = control.getBoundingClientRect();
          const selector = selectorFor(control);
          return [{
            label: hint || "编辑",
            selector,
            unique: document.querySelectorAll(selector).length === 1,
            visible: visible(control),
            bounds: { x: Math.round(controlRect.left), y: Math.round(controlRect.top), width: Math.round(controlRect.width), height: Math.round(controlRect.height) }
          }];
        }).slice(0, 4);
        const selector = selectorFor(record);
        return {
          text: compact(record.innerText, 1800),
          selector,
          unique: document.querySelectorAll(selector).length === 1,
          bounds: { x: Math.round(recordRect.left), y: Math.round(recordRect.top), width: Math.round(recordRect.width), height: Math.round(recordRect.height) },
          controls: recordControls
        };
      });
      return {
        key: keyFor(text),
        label: compact(rawLabel, 80),
        text,
        selector: selectorFor(element),
        unique: document.querySelectorAll(selectorFor(element)).length === 1,
        bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
        controls,
        recordDetails
      };
    });
    resume = { sections, sectionDetails, editableControls: interactives.filter((item) => /编辑|添加|修改|edit|add/i.test(item.label || "")).slice(0, 40) };
  }

  return JSON.stringify({
    adapter: "boss-zhipin",
    pageType,
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, scrollY, pageHeight: document.documentElement.scrollHeight },
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 24_000),
    interactives,
    links,
    boss: { job, jobCards, chat, resume }
  });
}

// Job-list pages are large enough that some Chrome builds return a null result
// for the full snapshot. This compact inspector contains only what the job
// runner needs: search controls, job cards, the visible detail and chat input.
function bossInspectLite() {
  const compact = (value, limit = 500) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const labelOf = (element) => element
    ? compact(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.textContent || element.value || "", 180)
    : "";
  const cssEscape = (value) => window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const selectorFor = (element) => {
    if (!element) return "";
    if (element.id) return `#${cssEscape(element.id)}`;
    for (const attr of ["data-testid", "data-e2e", "name", "aria-label", "placeholder"]) {
      const value = element.getAttribute(attr);
      if (value) return `${element.tagName.toLowerCase()}[${attr}="${String(value).replace(/"/g, "\\\"")}"]`;
    }
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const siblings = [...(node.parentElement?.children || [])].filter((item) => item.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const geometry = (element) => {
    if (!element) return {};
    const rect = element.getBoundingClientRect();
    return {
      point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
      bounds: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
  };
  const safeUrl = (value) => {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  };
  const firstText = (root, selectors, limit = 500) => {
    for (const selector of selectors) {
      const text = compact(root?.querySelector(selector)?.innerText || "", limit);
      if (text) return text;
    }
    return "";
  };

  const pathname = location.pathname;
  const pageType = /\/web\/geek\/chat|\/web\/chat/.test(pathname) ? "chat"
    : /\/job_detail\//.test(pathname) ? "job-detail"
      : /\/web\/geek\/jobs|\/c\d+/.test(pathname) ? "job-list" : "other";
  // BOSS renders the primary contact action as an anchor in some job-list
  // layouts.  Put communication actions first so the compact 140-element
  // budget cannot drop the visible "立即沟通" control behind job-card links.
  const communicationElements = [...document.querySelectorAll("button, a, [role='button'], [class*='chat'], [class*='communicate'], [class*='contact']")]
    .filter(visible)
    .filter((element) => /^(?:立即沟通|继续沟通|去沟通|进入沟通|打开聊天|留在此页|返回职位|关闭|取消|立即申请|投递简历|申请职位)$/i.test(labelOf(element)));
  const navigationElements = [...document.querySelectorAll("button, a, [role='button']")]
    .filter(visible)
    .filter((element) => /^(?:下一页|下页|Next|›|»|查看职位|返回职位列表|返回岗位列表)$/i.test(labelOf(element)));
  // A saved BOSS job expectation is a much more reliable entry point than
  // the city filter.  It already binds role + desired city (for example
  // "全栈工程师(深圳)"), while the city filter can silently fall back to the
  // browser/account location after a search or recommendation refresh.
  const supportedExpectationLocation = "全国|北京|深圳|上海|广州|杭州|成都|武汉|南京|苏州|天津|重庆|西安|长沙|郑州|石家庄|东莞|佛山|厦门|青岛|合肥|济南|福州|宁波|无锡|远程";
  const expectationPattern = new RegExp(`^(.{1,36})[（(](${supportedExpectationLocation})[）)]$`);
  const expectationElements = [...document.querySelectorAll("a, button, [role='button'], span, div")]
    .filter(visible)
    .flatMap((element) => {
      const label = compact(element.innerText || element.textContent || "", 60);
      const match = label.match(expectationPattern);
      if (!match) return [];
      const detail = geometry(element);
      if (!detail.point || detail.point.y > 320 || (detail.bounds?.width || 0) > 620) return [];
      const hint = compact(`${element.className || ""} ${element.getAttribute("aria-current") || ""} ${element.getAttribute("aria-selected") || ""}`, 180);
      return [{
        tag: element.tagName.toLowerCase(),
        label,
        role: compact(match[1], 40),
        location: match[2],
        selector: selectorFor(element),
        selected: /active|selected|current|cur\b|true/i.test(hint),
        hint,
        ...detail
      }];
    })
    .filter((item, index, items) => items.findIndex((other) => other.label === item.label && other.point?.x === item.point?.x && other.point?.y === item.point?.y) === index)
    .sort((left, right) => (left.bounds?.width || 9999) - (right.bounds?.width || 9999))
    .slice(0, 20);
  const interactiveElements = [...new Set([
    ...communicationElements,
    ...navigationElements,
    ...expectationElements.map((item) => document.elementFromPoint(item.point.x, item.point.y)).filter(Boolean),
    ...document.querySelectorAll("button, [role='button'], input, textarea, [contenteditable='true'], [class*='search-btn'], [class*='search-button'], a[href*='job_detail'], a[href*='/job/']")
  ])].filter(visible).slice(0, 140);
  const interactives = interactiveElements.map((element) => ({
    tag: element.tagName.toLowerCase(),
    label: labelOf(element),
    selector: selectorFor(element),
    type: element.getAttribute("type") || undefined,
    disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    valuePreview: "value" in element ? String(element.value || "").slice(0, 600) : undefined,
    ...geometry(element)
  }));

  const supportedLocation = /^(?:城市|全国|北京|深圳|上海|广州|杭州|成都|武汉|南京|苏州|天津|重庆|西安|长沙|郑州|石家庄|东莞|佛山|厦门|青岛|合肥|济南|福州|宁波|无锡|远程)$/;
  const locationElements = [...document.querySelectorAll("button, a, [role='button'], li, span, div")]
    .filter(visible)
    .flatMap((element) => {
      const rawLabel = compact(element.innerText || element.textContent || "", 40);
      const label = rawLabel
        .replace(/^[^\u4e00-\u9fff]+|[^\u4e00-\u9fff]+$/g, "")
        .replace(/市$/, "");
      if (!supportedLocation.test(label)) return [];
      const detail = geometry(element);
      const hint = compact(`${element.className || ""} ${element.getAttribute("data-value") || ""} ${element.getAttribute("data-code") || ""} ${rawLabel}`, 180);
      return [{ tag: element.tagName.toLowerCase(), label, rawLabel, selector: selectorFor(element), hint, ...detail }];
    })
    .filter((item, index, items) => items.findIndex((other) => other.label === item.label && other.point?.x === item.point?.x && other.point?.y === item.point?.y) === index)
    .slice(0, 120);
  const locationFilter = locationElements
    .filter((item) => item.point
      && item.point.x < 900
      && item.point.y > 40
      && item.point.y < 280
      && (item.bounds?.width || 9999) < 220)
    .sort((left, right) => {
      const rightHint = /cur-city-label|city|location|area|filter/i.test(right.hint) ? 1 : 0;
      const leftHint = /cur-city-label|city|location|area|filter/i.test(left.hint) ? 1 : 0;
      return rightHint - leftHint || (left.bounds?.width || 9999) - (right.bounds?.width || 9999);
    })[0] || null;

  const cardElements = [...new Set([
    ...document.querySelectorAll(".job-card-wrapper"),
    ...document.querySelectorAll(".job-list-box li"),
    ...document.querySelectorAll(".rec-job-list li"),
    ...document.querySelectorAll("[class*='job-card']")
  ])].filter(visible).slice(0, 50);
  const jobCards = [];
  const seen = new Set();
  for (const card of cardElements) {
    const anchor = card.querySelector("a[href*='job_detail'], a[href*='/job/']");
    const url = safeUrl(anchor?.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const context = compact(card.innerText, 900);
    const title = firstText(card, [".job-name", ".job-title", "[class*='job-name']", "[class*='job-title']"], 180) || labelOf(anchor);
    if (!/(?:AI|Agent|LLM|RAG|工程师|开发|后端|全栈|算法|研发|智能体)/i.test(`${title} ${context}`)) continue;
    jobCards.push({
      url,
      title,
      company: firstText(card, [".company-info .company-name a", ".company-info .company-name", ".company-info h3", ".company-info a", "[class*='company-info'] [class*='name']", "[class*='company-info'] a", ".company-name", "[class*='company-name']", "[class*='company'] [class*='name']", "[class*='company'] a"], 180),
      salary: firstText(card, [".salary", ".job-salary", "[class*='salary']"], 80) || context.match(/\d{1,3}\s*[-–—]\s*\d{1,3}K(?:·\d+薪)?/i)?.[0] || "",
      location: firstText(card, [".job-area", ".job-location", "[class*='area']", "[class*='location']"], 120) || context.match(/北京|深圳|上海|杭州|广州|成都|武汉|南京|苏州|远程/)?.[0] || "",
      context,
      selector: selectorFor(anchor),
      selected: /active|selected|current|cur\b|true/i.test(`${String(card.className || "")} ${card.getAttribute("aria-selected") || ""}`),
      ...geometry(anchor)
    });
  }

  const detailRoot = document.querySelector(".job-detail-box, .job-detail-container, .job-detail-content, .job-detail-wrap, [class*='job-detail-container']");
  const detailText = compact(detailRoot?.innerText || "", 16_000);
  const selectedCard = jobCards.find((card) => card.selected);
  const job = detailText && /职位描述|岗位职责|任职要求/.test(detailText) ? {
    title: firstText(detailRoot, ["h1.job-name", "h2.job-name", ".job-name", ".job-title", "[class*='job-name']"], 180) || selectedCard?.title || "",
    company: firstText(detailRoot, [".company-name", "[class*='company-name']", ".sider-company h3"], 180) || selectedCard?.company || "",
    salary: firstText(detailRoot, [".salary", ".job-salary", "[class*='salary']"], 80) || selectedCard?.salary || "",
    location: firstText(detailRoot, [".job-address", ".location-address", "[class*='job-location']"], 120) || selectedCard?.location || "",
    description: detailText,
    recruiter: firstText(detailRoot, [".boss-name", ".boss-info-attr", "[class*='boss-name']"], 120),
    url: selectedCard?.url || location.href
  } : null;

  const chat = pageType === "chat"
    ? jobdeckBossChatSnapshot({ compact, visible, selectorFor })
    : null;
  const links = jobCards.map((card) => ({
    href: card.url, label: card.title, context: card.context, selector: card.selector, point: card.point, bounds: card.bounds
  }));
  return JSON.stringify({
    adapter: "boss-zhipin",
    pageType,
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, scrollY, pageHeight: document.documentElement.scrollHeight },
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 18_000),
    interactives,
    links,
    boss: {
      job,
      jobCards,
      expectationOptions: expectationElements,
      activeExpectation: expectationElements.find((item) => item.selected) || null,
      locationFilter,
      locationOptions: locationElements,
      chat,
      resume: null
    }
  });
}

// Expose the read-only inspectors to the isolated content-script world.  The
// service worker deliberately receives the snapshot over runtime messaging
// instead of relying on executeScript's return value (which is missing on some
// Chrome 151 builds).
globalThis.__jobdeckBossInspectPage = bossInspectPage;
globalThis.__jobdeckBossInspectLite = bossInspectLite;
