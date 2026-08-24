const DEFAULT_TIMEOUT_MS = 15_000;

export class Sub2APIError extends Error {
  constructor(message, status = 502, code = "SUB2API_ERROR") {
    super(message);
    this.name = "Sub2APIError";
    this.status = status;
    this.code = code;
  }
}

function normalizeBaseURL(value) {
  const url = new URL(String(value || "https://sub2api.aibro.vip"));
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Sub2API 地址必须使用 HTTPS；HTTP 仅允许本机服务");
  }
  return url.href.replace(/\/$/, "");
}

export class Sub2APIClient {
  constructor({
    baseURL = process.env.SUB2API_BASE_URL || "https://sub2api.aibro.vip",
    adminAPIKey = process.env.SUB2API_ADMIN_API_KEY || "",
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    this.baseURL = normalizeBaseURL(baseURL);
    this.adminAPIKey = String(adminAPIKey).trim();
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  get rewardEnabled() {
    return Boolean(this.adminAPIKey);
  }

  get gatewayBaseURL() {
    return `${this.baseURL}/v1`;
  }

  async request(path, { method = "GET", body, token, admin = false, idempotencyKey } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    if (admin) {
      if (!this.adminAPIKey) throw new Sub2APIError("Star 奖励尚未配置", 503, "REWARD_DISABLED");
      headers["X-API-Key"] = this.adminAPIKey;
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let response;
    try {
      response = await this.fetch(`${this.baseURL}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new Sub2APIError(error.name === "TimeoutError" ? "账号服务响应超时" : "暂时无法连接账号服务");
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      const message = payload.message || payload.error || `账号服务请求失败（${response.status}）`;
      throw new Sub2APIError(String(message), response.status || 502, payload.code || "SUB2API_ERROR");
    }
    return Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  }

  publicSettings() {
    return this.request("/api/v1/settings/public");
  }

  sendVerifyCode(email) {
    return this.request("/api/v1/auth/send-verify-code", { method: "POST", body: { email } });
  }

  register(input) {
    return this.request("/api/v1/auth/register", { method: "POST", body: input });
  }

  login(email, password) {
    return this.request("/api/v1/auth/login", { method: "POST", body: { email, password } });
  }

  refresh(refreshToken) {
    return this.request("/api/v1/auth/refresh", { method: "POST", body: { refresh_token: refreshToken } });
  }

  logout(refreshToken) {
    return this.request("/api/v1/auth/logout", { method: "POST", body: { refresh_token: refreshToken } });
  }

  async profile(accessToken) {
    try {
      return await this.request("/api/v1/user/profile", { token: accessToken });
    } catch (error) {
      if (error.status !== 404) throw error;
      return this.request("/api/v1/auth/me", { token: accessToken });
    }
  }

  listAPIKeys(accessToken, { search = "JobDeck", pageSize = 50 } = {}) {
    const query = new URLSearchParams({ page: "1", page_size: String(pageSize), search });
    return this.request(`/api/v1/keys?${query}`, { token: accessToken });
  }

  createAPIKey(accessToken, { name = "JobDeck", idempotencyKey } = {}) {
    return this.request("/api/v1/keys", {
      method: "POST",
      token: accessToken,
      idempotencyKey,
      body: { name }
    });
  }

  updateAPIKey(accessToken, id, updates) {
    return this.request(`/api/v1/keys/${encodeURIComponent(String(id))}`, {
      method: "PUT",
      token: accessToken,
      body: updates
    });
  }

  async ensureAPIKey(accessToken, { name = "JobDeck", accountId = "account" } = {}) {
    const page = await this.listAPIKeys(accessToken, { search: name });
    const keys = Array.isArray(page) ? page : Array.isArray(page?.items) ? page.items : [];
    let key = keys.find((item) => String(item?.name || "").trim().toLowerCase() === name.toLowerCase());
    if (key && key.status !== "active") key = await this.updateAPIKey(accessToken, key.id, { status: "active" });
    if (!key) {
      key = await this.createAPIKey(accessToken, {
        name,
        idempotencyKey: `jobdeck-api-key-${accountId}`
      });
    }
    if (!key?.key) throw new Sub2APIError("账号 API Key 创建成功，但服务未返回密钥", 502, "API_KEY_MISSING");
    return key;
  }

  rewardUser({ userId, amount, rewardCode, notes }) {
    const numericUserId = Number(userId);
    if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
      throw new Sub2APIError("奖励账号编号无效", 502, "ACCOUNT_INVALID");
    }
    return this.request("/api/v1/admin/redeem-codes/create-and-redeem", {
      method: "POST",
      admin: true,
      idempotencyKey: rewardCode,
      body: { code: rewardCode, type: "balance", value: amount, user_id: numericUserId, notes }
    });
  }
}
