import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = 43121;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-smoke-"));
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: { ...process.env, JOBDECK_PORT: String(port), JOBDECK_DATA_DIR: directory },
  stdio: ["ignore", "ignore", "pipe"]
});

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error("本地服务未启动");
}

try {
  await waitForServer();
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
  if (!health.ok || health.service !== "jobdeck") throw new Error("健康检查内容不正确");
  const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((response) => response.json());
  if (!state.candidate || !state.workflow || !state.pairingToken || !Array.isArray(state.pendingActions)) throw new Error("状态接口缺少字段");
  process.stdout.write("JobDeck smoke test passed\n");
} finally {
  child.kill("SIGTERM");
  fs.rmSync(directory, { recursive: true, force: true });
}
