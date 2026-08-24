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
