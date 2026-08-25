import assert from "node:assert/strict";
import test from "node:test";
import { Sub2APIClient } from "../server/sub2api-client.mjs";

test("Sub2API client uses email login and unwraps the response envelope", async () => {
  const calls = [];
  const client = new Sub2APIClient({
    baseURL: "https://accounts.example.com/",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ code: 0, data: { access_token: "access", refresh_token: "refresh" } });
    }
  });
  const result = await client.login("user@example.com", "password");
  assert.equal(result.access_token, "access");
  assert.equal(calls[0].url, "https://accounts.example.com/api/v1/auth/login");
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: "user@example.com", password: "password" });
});

test("Sub2API reward call stays server-side and is idempotent", async () => {
  let request;
  const client = new Sub2APIClient({
    baseURL: "https://accounts.example.com",
    adminAPIKey: "admin-secret",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ code: 0, data: { redeemed: true } });
    }
  });
  await client.rewardUser({ userId: "42", amount: 5, rewardCode: "reward-42", notes: "verified" });
  assert.equal(request.options.headers["X-API-Key"], "admin-secret");
  assert.equal(request.options.headers["Idempotency-Key"], "reward-42");
  assert.deepEqual(JSON.parse(request.options.body), {
    code: "reward-42", type: "balance", value: 5, user_id: 42, notes: "verified"
  });
});

test("Sub2API client reuses the current user's active grouped JobDeck key", async () => {
  const calls = [];
  const client = new Sub2APIClient({
    baseURL: "https://accounts.example.com",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ code: 0, data: { items: [{ id: 7, name: "JobDeck", status: "active", group_id: 3, key: "sk-user-key" }] } });
    }
  });
  const key = await client.ensureAPIKey("user-access", { accountId: 42 });
  assert.equal(key.key, "sk-user-key");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer user-access");
});

test("Sub2API client creates a dedicated key when the user has none", async () => {
  const calls = [];
  const client = new Sub2APIClient({
    baseURL: "https://accounts.example.com",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/v1/groups/available")) {
        return Response.json({ code: 0, data: [{ id: 12, platform: "openai", status: "active", require_oauth_only: false }] });
      }
      if (options.method === "POST") return Response.json({ code: 0, data: { id: 9, name: "JobDeck", status: "active", group_id: 12, key: "sk-created" } });
      return Response.json({ code: 0, data: { items: [] } });
    }
  });
  const key = await client.ensureAPIKey("user-access", { accountId: 42 });
  assert.equal(key.key, "sk-created");
  assert.equal(calls[2].options.headers["Idempotency-Key"], "jobdeck-api-key-42");
  assert.deepEqual(JSON.parse(calls[2].options.body), { name: "JobDeck", group_id: 12 });
});

test("Sub2API client repairs an existing ungrouped JobDeck key", async () => {
  const calls = [];
  const client = new Sub2APIClient({
    baseURL: "https://accounts.example.com",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/v1/groups/available")) {
        return Response.json({ code: 0, data: [
          { id: 4, platform: "anthropic", status: "active", require_oauth_only: false },
          { id: 8, platform: "openai", status: "active", require_oauth_only: false }
        ] });
      }
      if (options.method === "PUT") {
        return Response.json({ code: 0, data: { id: 7, name: "JobDeck", status: "active", group_id: 8 } });
      }
      return Response.json({ code: 0, data: { items: [{ id: 7, name: "JobDeck", status: "active", group_id: null, key: "sk-user-key" }] } });
    }
  });
  const key = await client.ensureAPIKey("user-access", { accountId: 42 });
  assert.equal(key.key, "sk-user-key");
  assert.equal(key.group_id, 8);
  assert.deepEqual(JSON.parse(calls[2].options.body), { group_id: 8 });
});

test("Sub2API client reports a clear error when no OpenAI group is available", async () => {
  const client = new Sub2APIClient({
    baseURL: "https://accounts.example.com",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/v1/groups/available")) return Response.json({ code: 0, data: [] });
      return Response.json({ code: 0, data: { items: [] } });
    }
  });
  await assert.rejects(
    client.ensureAPIKey("user-access", { accountId: 42 }),
    (error) => error.code === "API_KEY_GROUP_UNAVAILABLE" && error.status === 403
  );
});
