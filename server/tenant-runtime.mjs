import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { BrowserBridge } from "./bridge.mjs";
import { Store } from "./store.mjs";

export const JOBDECK_AUTH_SCOPES = Object.freeze({
  STATE_READ: "state:read",
  BROWSER_OPERATE: "browser:operate",
  ACTIONS_DECIDE: "actions:decide",
  JOBS_MANAGE: "jobs:manage",
  MESSAGES_DRAFT: "messages:draft",
  TENANT_SETTINGS: "tenant:settings",
  REWARDS_CLAIM: "rewards:claim"
});

const DEVICE_SCOPES = Object.freeze([
  JOBDECK_AUTH_SCOPES.STATE_READ,
  JOBDECK_AUTH_SCOPES.BROWSER_OPERATE,
  JOBDECK_AUTH_SCOPES.ACTIONS_DECIDE,
  JOBDECK_AUTH_SCOPES.JOBS_MANAGE,
  JOBDECK_AUTH_SCOPES.MESSAGES_DRAFT
]);

const ACCOUNT_SCOPES = Object.freeze([
  ...DEVICE_SCOPES,
  JOBDECK_AUTH_SCOPES.TENANT_SETTINGS,
  JOBDECK_AUTH_SCOPES.REWARDS_CLAIM
]);

export function jobdeckAuthHasScope(auth, scope) {
  return Boolean(auth?.scopes?.includes(String(scope)));
}

const DEVICE_HTTP_SCOPE_RULES = Object.freeze([
  { method: "GET", pattern: /^\/state\/?$/, scope: JOBDECK_AUTH_SCOPES.STATE_READ },
  { method: "POST", pattern: /^\/browser\/(?:command|plan)\/?$/, scope: JOBDECK_AUTH_SCOPES.BROWSER_OPERATE },
  { method: "POST", pattern: /^\/automation\/(?:pause|resume)\/?$/, scope: JOBDECK_AUTH_SCOPES.BROWSER_OPERATE },
  { method: "POST", pattern: /^\/jobs\/(?:capture-current|discover-current)\/?$/, scope: JOBDECK_AUTH_SCOPES.JOBS_MANAGE },
  { method: "POST", pattern: /^\/boss\/draft-reply\/?$/, scope: JOBDECK_AUTH_SCOPES.MESSAGES_DRAFT },
  { method: "POST", pattern: /^\/actions\/[^/]+\/(?:approve|reject)\/?$/, scope: JOBDECK_AUTH_SCOPES.ACTIONS_DECIDE }
]);

export function jobdeckDeviceRequestScope(method, pathname) {
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  const normalizedPath = String(pathname || "/").split("?", 1)[0] || "/";
  return DEVICE_HTTP_SCOPE_RULES.find((rule) => (
    rule.method === normalizedMethod && rule.pattern.test(normalizedPath)
  ))?.scope || null;
}

function accountId(profile) {
  return String(profile?.id ?? profile?.user_id ?? profile?.user?.id ?? "").trim();
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function tenantSlug(id) {
  return `tenant-${crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 32)}`;
}

function cacheDeadline(token, maximumMs) {
  const fallback = Date.now() + maximumMs;
  try {
    const encoded = String(token).split(".")[1];
    if (!encoded) return fallback;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const expiresAt = Number(payload.exp) * 1000;
    return Number.isFinite(expiresAt) ? Math.min(fallback, expiresAt) : fallback;
  } catch {
    return fallback;
  }
}

function jsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

export class TenantRuntimeManager {
  constructor({ directory, sub2api, multiUser = false, profileCacheMs = 60_000 } = {}) {
    this.directory = directory || path.join(os.homedir(), ".jobdeck-local");
    this.sub2api = sub2api;
    this.multiUser = Boolean(multiUser);
    this.profileCacheMs = profileCacheMs;
    this.context = new AsyncLocalStorage();
    this.tenants = new Map();
    this.deviceTokens = new Map();
    this.profileCache = new Map();
    this.providerReady = new Set();
    this.providerProvisioning = new Map();
    this.agentFactory = null;
    this.tenantInitializer = null;
    this.local = this.createTenant("local", { local: true });
    this.loadTenantIndex();
    this.store = this.contextProxy("store");
    this.bridge = this.contextProxy("bridge");
  }

  createTenant(id, { local = false, profile = null } = {}) {
    const tenantDirectory = local ? this.directory : path.join(this.directory, "tenants", tenantSlug(id));
    const store = new Store(tenantDirectory, { accessToken: local ? undefined : "" });
    const tenant = { id: String(id), directory: tenantDirectory, store, bridge: new BrowserBridge(store), profile, agentRuntime: null };
    this.tenants.set(String(id), tenant);
    this.deviceTokens.set(tokenDigest(store.secrets.extensionToken), tenant);
    this.initializeTenant(tenant);
    if (!local) {
      fs.mkdirSync(tenantDirectory, { recursive: true, mode: 0o700 });
      const metadata = { tenantId: String(id), updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(tenantDirectory, "tenant.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    }
    return tenant;
  }

  loadTenantIndex() {
    const root = path.join(this.directory, "tenants");
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tenantDirectory = path.join(root, entry.name);
      const metadata = jsonFile(path.join(tenantDirectory, "tenant.json"));
      const id = String(metadata?.tenantId || "").trim();
      if (!id || this.tenants.has(id)) continue;
      const store = new Store(tenantDirectory, { accessToken: "" });
      const tenant = { id, directory: tenantDirectory, store, bridge: new BrowserBridge(store), profile: null, agentRuntime: null };
      this.tenants.set(id, tenant);
      this.deviceTokens.set(tokenDigest(store.secrets.extensionToken), tenant);
      this.initializeTenant(tenant);
    }
  }

  contextProxy(key) {
    return new Proxy({}, {
      get: (_target, property) => {
        const value = this.current()[key][property];
        return typeof value === "function" ? value.bind(this.current()[key]) : value;
      },
      set: (_target, property, value) => {
        this.current()[key][property] = value;
        return true;
      }
    });
  }

  current() {
    return this.context.getStore() || this.local;
  }

  run(tenant, callback) {
    return this.context.run(tenant, callback);
  }

  getOrCreate(id, profile = null) {
    let tenant = this.tenants.get(String(id));
    if (!tenant) tenant = this.createTenant(id, { profile });
    if (profile) tenant.profile = profile;
    return tenant;
  }

  async fromAccessToken(token) {
    const digest = tokenDigest(token);
    const cached = this.profileCache.get(digest);
    if (cached && cached.expiresAt > Date.now()) {
      await this.ensureProvider(cached.tenant, token);
      return cached.tenant;
    }
    const profile = await this.sub2api.profile(token);
    const id = accountId(profile);
    if (!id) throw new Error("账号信息缺少用户编号");
    const tenant = this.getOrCreate(id, profile);
    await this.ensureProvider(tenant, token);
    this.profileCache.set(digest, { tenant, expiresAt: cacheDeadline(token, this.profileCacheMs) });
    return tenant;
  }

  async ensureProvider(tenant, token) {
    if (!this.multiUser || !this.sub2api?.ensureAPIKey || this.providerReady.has(tenant.id)) return tenant;
    const pending = this.providerProvisioning.get(tenant.id);
    if (pending) return pending;
    const provisioning = (async () => {
      const key = await this.sub2api.ensureAPIKey(token, { name: "JobDeck", accountId: tenant.id });
      tenant.store.setManagedProvider({
        mode: "openai-responses",
        baseURL: this.sub2api.gatewayBaseURL,
        model: process.env.JOBDECK_SUB2API_MODEL || "gpt-5.6-luna",
        apiKey: key.key,
        source: "sub2api",
        accountId: tenant.id,
        apiKeyId: key.id
      });
      this.providerReady.add(tenant.id);
      return tenant;
    })();
    this.providerProvisioning.set(tenant.id, provisioning);
    try {
      return await provisioning;
    } finally {
      this.providerProvisioning.delete(tenant.id);
    }
  }

  invalidateAccessToken(token) {
    if (token) this.profileCache.delete(tokenDigest(token));
  }

  fromDeviceToken(token) {
    return token ? this.deviceTokens.get(tokenDigest(token)) || null : null;
  }

  async resolveRequestAuth(req) {
    if (!this.multiUser) {
      return {
        tenant: this.local,
        auth: { kind: "local", tenantId: this.local.id, scopes: [...ACCOUNT_SCOPES] }
      };
    }
    const authorization = String(req?.headers?.authorization || "");
    const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
    const deviceToken = String(req?.headers?.["x-jobdeck-token"] || "").trim();
    if (bearer) {
      const tenant = await this.fromAccessToken(bearer);
      return { tenant, auth: { kind: "account", tenantId: tenant.id, scopes: [...ACCOUNT_SCOPES] } };
    }
    if (deviceToken) {
      const tenant = this.fromDeviceToken(deviceToken);
      if (tenant) return { tenant, auth: { kind: "device", tenantId: tenant.id, scopes: [...DEVICE_SCOPES] } };
    }
    return null;
  }

  setAgentFactory(factory) {
    this.agentFactory = factory;
  }

  initializeTenant(tenant) {
    if (this.tenantInitializer) this.run(tenant, () => this.tenantInitializer(tenant));
  }

  setTenantInitializer(initializer) {
    this.tenantInitializer = initializer;
    for (const tenant of this.tenants.values()) this.initializeTenant(tenant);
  }

  agentRuntime() {
    const tenant = this.current();
    if (!tenant.agentRuntime) {
      if (!this.agentFactory) throw new Error("求职 Agent 尚未初始化");
      tenant.agentRuntime = this.agentFactory(tenant);
    }
    return tenant.agentRuntime;
  }

  middleware({ allowedKinds = ["local", "account", "device"], requiredScopes = [] } = {}) {
    const allowed = new Set(allowedKinds.map(String));
    const required = [...new Set(requiredScopes.map(String))];
    return async (req, res, next) => {
      try {
        const resolved = await this.resolveRequestAuth(req);
        if (!resolved) return res.status(401).json({ error: "请先登录 JobDeck 账号", code: "AUTH_REQUIRED" });
        if (!allowed.has(resolved.auth.kind)) {
          return res.status(403).json({ error: "当前连接凭证不能访问此功能", code: "AUTH_KIND_FORBIDDEN" });
        }
        if (required.some((scope) => !jobdeckAuthHasScope(resolved.auth, scope))) {
          return res.status(403).json({ error: "当前连接凭证缺少所需权限", code: "AUTH_SCOPE_REQUIRED" });
        }
        req.jobdeckTenant = resolved.tenant;
        req.jobdeckAuth = resolved.auth;
        return this.run(resolved.tenant, next);
      } catch (error) {
        return res.status(Number.isInteger(error.status) ? error.status : 401).json({ error: "登录状态已失效，请重新登录", code: "AUTH_REQUIRED" });
      }
    };
  }

  attach(server) {
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const origin = String(req.headers.origin || "");
      const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((item) => item.trim());
      const protocolTokens = protocols.filter((item) => item.startsWith("token."));
      const suppliedToken = protocolTokens.length === 1 ? protocolTokens[0].slice(6) : "";
      const tenant = this.multiUser ? this.fromDeviceToken(suppliedToken) : this.local;
      const expectedToken = tenant?.store?.secrets?.extensionToken || "";
      const supplied = Buffer.from(suppliedToken);
      const expected = Buffer.from(expectedToken);
      const tokenMatches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      if (url.pathname !== "/extension" || !protocols.includes("jobdeck") || protocolTokens.length !== 1
        || !tenant || !tokenMatches || !extensionOrigin) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      tenant.bridge.acceptUpgrade(req, socket, head);
    });
  }

  close() {
    for (const tenant of this.tenants.values()) tenant.agentRuntime?.close?.();
  }
}
