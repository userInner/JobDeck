import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { BrowserBridge } from "./bridge.mjs";
import { Store } from "./store.mjs";

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
    if (cached && cached.expiresAt > Date.now()) return cached.tenant;
    const profile = await this.sub2api.profile(token);
    const id = accountId(profile);
    if (!id) throw new Error("账号信息缺少用户编号");
    const tenant = this.getOrCreate(id, profile);
    this.profileCache.set(digest, { tenant, expiresAt: cacheDeadline(token, this.profileCacheMs) });
    return tenant;
  }

  invalidateAccessToken(token) {
    if (token) this.profileCache.delete(tokenDigest(token));
  }

  fromDeviceToken(token) {
    return token ? this.deviceTokens.get(tokenDigest(token)) || null : null;
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

  middleware() {
    return async (req, res, next) => {
      if (!this.multiUser) return this.run(this.local, next);
      try {
        const authorization = String(req.headers.authorization || "");
        const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
        const device = String(req.headers["x-jobdeck-token"] || "").trim();
        const tenant = bearer ? await this.fromAccessToken(bearer) : this.fromDeviceToken(device);
        if (!tenant) return res.status(401).json({ error: "请先登录 JobDeck 账号", code: "AUTH_REQUIRED" });
        req.jobdeckTenant = tenant;
        return this.run(tenant, next);
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
      const protocolToken = protocols.find((item) => item.startsWith("token."))?.slice(6) || "";
      const suppliedToken = protocolToken || url.searchParams.get("token") || "";
      const tenant = this.multiUser ? this.fromDeviceToken(suppliedToken) : this.local;
      const expectedToken = tenant?.store?.secrets?.extensionToken || "";
      const supplied = Buffer.from(suppliedToken);
      const expected = Buffer.from(expectedToken);
      const tokenMatches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
      if (url.pathname !== "/extension" || !tenant || !tokenMatches || !origin.startsWith("chrome-extension://")) {
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
