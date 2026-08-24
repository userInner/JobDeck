import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultState } from "./defaults.mjs";
import { decodeBossPrivateText } from "./jobs.mjs";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeStateDefaults(defaults, saved) {
  if (!isPlainObject(defaults) || !isPlainObject(saved)) return saved ?? structuredClone(defaults);
  const merged = structuredClone(defaults);
  for (const [key, value] of Object.entries(saved)) {
    merged[key] = isPlainObject(defaults[key]) && isPlainObject(value)
      ? mergeStateDefaults(defaults[key], value)
      : value;
  }
  return merged;
}

export class Store {
  constructor(directory = process.env.JOBDECK_DATA_DIR || path.join(os.homedir(), ".jobdeck-local"), options = {}) {
    this.directory = directory;
    this.stateFile = path.join(directory, "state.json");
    this.secretsFile = path.join(directory, "secrets.json");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const defaults = createDefaultState();
    this.state = mergeStateDefaults(defaults, this.loadJson(this.stateFile, defaults));
    this.state.version = defaults.version;
    this.state.jobs = this.state.jobs.map((job) => {
      const normalized = { ...job };
      for (const key of ["title", "company", "salary", "location", "description", "recruiter", "greeting"]) {
        if (typeof normalized[key] === "string") normalized[key] = decodeBossPrivateText(normalized[key]);
      }
      return normalized;
    });
    this.secrets = this.loadJson(this.secretsFile, {});
    const configuredAccessToken = String(options.accessToken ?? process.env.JOBDECK_ACCESS_TOKEN ?? "").trim();
    if (configuredAccessToken && this.secrets.extensionToken !== configuredAccessToken) {
      this.secrets.extensionToken = configuredAccessToken;
      this.saveSecrets();
    } else if (!this.secrets.extensionToken) {
      this.secrets.extensionToken = crypto.randomBytes(24).toString("base64url");
      this.saveSecrets();
    }
    this.save();
  }

  loadJson(file, fallback) {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return structuredClone(fallback); }
  }

  atomicWrite(file, value) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  save() {
    this.atomicWrite(this.stateFile, this.state);
  }

  saveSecrets() {
    this.atomicWrite(this.secretsFile, this.secrets);
  }

  publicState() {
    return structuredClone(this.state);
  }

  update(mutator) {
    const result = mutator(this.state);
    this.save();
    return result;
  }

  setProvider(input) {
    this.update((state) => {
      state.provider = {
        mode: input.mode || state.provider.mode,
        baseURL: input.baseURL || state.provider.baseURL,
        model: input.model || state.provider.model,
        configured: Boolean(input.apiKey || this.secrets.apiKey)
      };
    });
    if (input.apiKey) {
      this.secrets.apiKey = input.apiKey;
      this.saveSecrets();
    }
    return this.state.provider;
  }

  addActivity(label, status = "done", meta = {}) {
    return this.update((state) => {
      const item = { id: crypto.randomUUID(), label, status, meta, at: new Date().toISOString() };
      state.activity.unshift(item);
      state.activity = state.activity.slice(0, 200);
      return item;
    });
  }
}
