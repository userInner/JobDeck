import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TenantRuntimeManager } from "../server/tenant-runtime.mjs";

function fakeAccounts() {
  const profiles = new Map([
    ["token-alice", { id: 101, email: "alice@example.com" }],
    ["token-bob", { id: 202, email: "bob@example.com" }]
  ]);
  return {
    async profile(token) {
      const profile = profiles.get(token);
      if (!profile) throw Object.assign(new Error("invalid token"), { status: 401 });
      return profile;
    }
  };
}

test("multi-user runtime isolates state, secrets and Chrome device tokens", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-tenants-"));
  try {
    const manager = new TenantRuntimeManager({ directory, sub2api: fakeAccounts(), multiUser: true, profileCacheMs: 60_000 });
    const alice = await manager.fromAccessToken("token-alice");
    const bob = await manager.fromAccessToken("token-bob");

    manager.run(alice, () => {
      manager.store.update((state) => {
        state.candidate.displayName = "Alice";
        state.jobs.push({ id: "alice-job", title: "AI Agent Engineer", company: "Alice Labs" });
      });
      manager.store.setProvider({ model: "alice-model", baseURL: "https://router.example/v1", apiKey: "alice-secret" });
    });
    manager.run(bob, () => {
      manager.store.update((state) => { state.candidate.displayName = "Bob"; });
      manager.store.setProvider({ model: "bob-model", baseURL: "https://router.example/v1", apiKey: "bob-secret" });
    });

    assert.notEqual(alice.directory, bob.directory);
    assert.notEqual(alice.store.secrets.extensionToken, bob.store.secrets.extensionToken);
    assert.equal(manager.fromDeviceToken(alice.store.secrets.extensionToken), alice);
    assert.equal(manager.fromDeviceToken(bob.store.secrets.extensionToken), bob);
    assert.equal(manager.fromDeviceToken("unknown-device-token"), null);

    manager.run(alice, () => {
      assert.equal(manager.store.state.candidate.displayName, "Alice");
      assert.equal(manager.store.state.jobs.length, 1);
      assert.equal(manager.store.secrets.apiKey, "alice-secret");
      assert.equal(manager.store.publicState().apiKey, undefined);
    });
    manager.run(bob, () => {
      assert.equal(manager.store.state.candidate.displayName, "Bob");
      assert.equal(manager.store.state.jobs.length, 0);
      assert.equal(manager.store.secrets.apiKey, "bob-secret");
    });
    manager.close();

    const restored = new TenantRuntimeManager({ directory, sub2api: fakeAccounts(), multiUser: true });
    const restoredAlice = await restored.fromAccessToken("token-alice");
    const restoredBob = await restored.fromAccessToken("token-bob");
    assert.equal(restoredAlice.store.state.candidate.displayName, "Alice");
    assert.equal(restoredAlice.store.state.jobs[0].id, "alice-job");
    assert.equal(restoredBob.store.state.candidate.displayName, "Bob");
    assert.equal(restoredBob.store.state.jobs.length, 0);
    assert.equal(restored.fromDeviceToken(restoredAlice.store.secrets.extensionToken), restoredAlice);
    restored.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("tenant initializer runs for restored and newly created accounts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-tenants-"));
  try {
    const first = new TenantRuntimeManager({ directory, sub2api: fakeAccounts(), multiUser: true });
    await first.fromAccessToken("token-alice");
    first.close();

    const restored = new TenantRuntimeManager({ directory, sub2api: fakeAccounts(), multiUser: true });
    const initialized = [];
    restored.setTenantInitializer((tenant) => initialized.push(tenant.id));
    await restored.fromAccessToken("token-bob");
    assert.ok(initialized.includes("101"));
    assert.ok(initialized.includes("202"));
    restored.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("multi-user runtime automatically connects each account to its own Sub2API key", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-tenants-"));
  const calls = [];
  const accounts = fakeAccounts();
  accounts.gatewayBaseURL = "https://accounts.example.com/v1";
  accounts.ensureAPIKey = async (token, options) => {
    calls.push({ token, options });
    return { id: options.accountId, key: `sk-${options.accountId}` };
  };
  try {
    const manager = new TenantRuntimeManager({ directory, sub2api: accounts, multiUser: true });
    const alice = await manager.fromAccessToken("token-alice");
    const bob = await manager.fromAccessToken("token-bob");
    assert.equal(alice.store.secrets.apiKey, "sk-101");
    assert.equal(bob.store.secrets.apiKey, "sk-202");
    assert.equal(alice.store.state.provider.baseURL, "https://accounts.example.com/v1");
    assert.equal(alice.store.state.provider.model, "gpt-5.6-luna");
    assert.equal(alice.store.state.provider.source, "sub2api");
    await manager.fromAccessToken("token-alice");
    assert.equal(calls.filter((call) => call.options.accountId === "101").length, 1);
    manager.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("multi-user middleware binds bearer and extension requests to the correct tenant", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-tenants-"));
  try {
    const manager = new TenantRuntimeManager({ directory, sub2api: fakeAccounts(), multiUser: true });
    const alice = await manager.fromAccessToken("token-alice");
    const bob = await manager.fromAccessToken("token-bob");
    const middleware = manager.middleware();
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; }
    };

    let bearerTenant;
    await middleware({ headers: { authorization: "Bearer token-alice" } }, response, () => {
      bearerTenant = manager.current();
    });
    assert.equal(bearerTenant, alice);

    let deviceTenant;
    await middleware({ headers: { "x-jobdeck-token": bob.store.secrets.extensionToken } }, response, () => {
      deviceTenant = manager.current();
    });
    assert.equal(deviceTenant, bob);

    await middleware({ headers: {} }, response, () => assert.fail("unauthorized request must not reach next"));
    assert.equal(response.statusCode, 401);
    assert.equal(response.payload.code, "AUTH_REQUIRED");
    manager.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
