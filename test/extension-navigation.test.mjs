import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");

function loadWorker({ allowedOrigins = ["https://www.zhipin.com"] } = {}) {
  const updates = [];
  const noopListener = { addListener() {} };
  const context = {
    URL,
    clearInterval() {},
    clearTimeout() {},
    console,
    encodeURIComponent,
    importScripts() {},
    setInterval() { return 1; },
    setTimeout() { return 1; },
    WebSocket: class {},
    chrome: {
      action: {
        async setBadgeBackgroundColor() {},
        async setBadgeText() {}
      },
      alarms: {
        create() {},
        onAlarm: noopListener
      },
      permissions: {
        async contains({ origins }) {
          return origins.includes("https://www.zhipin.com/*");
        }
      },
      runtime: {
        onInstalled: noopListener,
        onMessage: noopListener,
        onStartup: noopListener
      },
      sidePanel: {
        async setPanelBehavior() {}
      },
      storage: {
        local: {
          async get(defaults) {
            return { ...defaults, allowedOrigins, token: "" };
          },
          async set() {}
        },
        onChanged: noopListener
      },
      tabs: {
        async get(tabId) {
          return { id: tabId, url: "" };
        },
        async update(tabId, update) {
          updates.push({ tabId, ...update });
          return { id: tabId, ...update };
        }
      }
    }
  };
  context.WebSocket.OPEN = 1;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { execute: context.execute, updates };
}

test("navigation authorizes the target origin when a new tab has no URL yet", async () => {
  const { execute, updates } = loadWorker();
  const result = await execute({
    kind: "navigate",
    tabId: 42,
    url: "https://www.zhipin.com/web/geek/jobs?query=AI%20Agent&city=101010100"
  });

  assert.equal(result.id, 42);
  assert.deepEqual(updates, [{
    tabId: 42,
    url: "https://www.zhipin.com/web/geek/jobs?query=AI%20Agent&city=101010100"
  }]);
});

test("navigation still rejects an unapproved target origin", async () => {
  const { execute, updates } = loadWorker({ allowedOrigins: [] });

  await assert.rejects(() => execute({
    kind: "navigate",
    tabId: 42,
    url: "https://www.zhipin.com/web/geek/jobs"
  }), /目标站点尚未授权/);
  assert.equal(updates.length, 0);
});
