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
    const composer = firstElement(["textarea[placeholder*='消息']", "textarea", "[contenteditable='true']"]);
    const composerRect = composer?.getBoundingClientRect();
    const messageSelectors = [".message-item", ".chat-message", ".chat-record li", "[class*='message-item']", "[class*='message-content']", "[class*='bubble']"];
    const messageElements = [...new Set(messageSelectors.flatMap((selector) => [...document.querySelectorAll(selector)]))].filter(visible);
    const rawMessages = messageElements.slice(-30).flatMap((element) => {
      const text = compact(element.innerText || element.textContent || "", 1200);
      if (!text) return [];
      const className = String(element.className || "");
      const rect = element.getBoundingClientRect();
      const mine = /self|mine|my-|right|sent|send/i.test(className) || rect.left > innerWidth * 0.48;
      return [{ from: mine ? "candidate" : "recruiter", text }];
    });
    const messages = rawMessages.filter((message, index) => index === 0 || message.text !== rawMessages[index - 1].text);
    if (!messages.length) {
      const transcript = firstText([".chat-conversation", ".chat-record", "[class*='chat-content']"], 8000);
      if (transcript) messages.push({ from: "recruiter", text: transcript });
    }
    chat = {
      recruiter: firstText([".chat-info .name", ".user-name", "[class*='chat'] [class*='name']"], 160),
      jobTitle: firstText([".chat-job", ".job-name", "[class*='job-title']"], 180),
      company: firstText([".company-name", "[class*='company-name']"], 180),
      messages,
      composer: composer ? {
        selector: selectorFor(composer),
        tag: composer.tagName.toLowerCase(),
        point: { x: Math.round(composerRect.left + composerRect.width / 2), y: Math.round(composerRect.top + composerRect.height / 2) },
        bounds: { x: Math.round(composerRect.left), y: Math.round(composerRect.top), width: Math.round(composerRect.width), height: Math.round(composerRect.height) }
      } : null
    };
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

  const composer = [...document.querySelectorAll("textarea, [contenteditable='true']")].find(visible);
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
      chat: composer ? { composer: { selector: selectorFor(composer), tag: composer.tagName.toLowerCase(), ...geometry(composer) } } : null,
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
