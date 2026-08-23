if (!globalThis.__jobdeckBossContentReady) {
  globalThis.__jobdeckBossContentReady = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "jobdeck-inspect-boss") return undefined;
    try {
      const inspect = message.lite
        ? globalThis.__jobdeckBossInspectLite
        : globalThis.__jobdeckBossInspectPage;
      if (typeof inspect !== "function") throw new Error("BOSS 页面读取器尚未加载");
      const raw = inspect();
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      sendResponse({ ok: true, data });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return true;
  });
}
