import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeStateDefaults, Store } from "../server/store.mjs";

test("store persists state and keeps secrets out of public payload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-store-"));
  try {
    const store = new Store(directory);
    store.setProvider({ mode: "openai-responses", model: "test-model", baseURL: "https://api.openai.com/v1", apiKey: "secret-key" });
    store.addActivity("测试记录");
    const restored = new Store(directory);
    assert.equal(restored.state.provider.configured, true);
    assert.equal(restored.secrets.apiKey, "secret-key");
    assert.equal(restored.publicState().apiKey, undefined);
    assert.equal(restored.state.activity[0].label, "测试记录");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("deployment access token becomes the extension pairing token without entering public state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-store-"));
  const previous = process.env.JOBDECK_ACCESS_TOKEN;
  try {
    process.env.JOBDECK_ACCESS_TOKEN = "deployment-token-1234567890123456";
    const store = new Store(directory);
    assert.equal(store.secrets.extensionToken, process.env.JOBDECK_ACCESS_TOKEN);
    assert.equal(store.publicState().extensionToken, undefined);
  } finally {
    if (previous === undefined) delete process.env.JOBDECK_ACCESS_TOKEN;
    else process.env.JOBDECK_ACCESS_TOKEN = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("old state gains the first-run workflow without losing saved jobs", () => {
  const merged = mergeStateDefaults({ version: 2, jobs: [], workflow: { phase: "not-started", batch: [] } }, {
    version: 1,
    jobs: [{ id: "saved-job" }]
  });
  assert.equal(merged.version, 1);
  assert.equal(merged.jobs[0].id, "saved-job");
  assert.equal(merged.workflow.phase, "not-started");
});

test("store repairs salaries captured from the BOSS private font", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-store-"));
  try {
    fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify({
      jobs: [{ id: "private-font-job", salary: "\uE033\uE031-\uE034\uE036K", description: "月薪 \uE033\uE031K" }]
    }));
    const store = new Store(directory);
    assert.equal(store.state.jobs[0].salary, "20-35K");
    assert.equal(store.state.jobs[0].description, "月薪 20K");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
