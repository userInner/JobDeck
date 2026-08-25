import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StarRewardError, StarRewardService } from "../server/star-rewards.mjs";

test("Star reward verifies account ownership, public gist and repository star exactly once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-star-"));
  const rewarded = [];
  let proof;
  const sub2api = {
    rewardEnabled: true,
    profile: async () => ({ id: 42, email: "user@example.com" }),
    rewardUser: async (input) => rewarded.push(input)
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/users/octocat")) return Response.json({ id: 7, login: "octocat" });
    if (url.includes("/gists/")) return Response.json({
      public: true,
      owner: { id: 7 },
      files: { "jobdeck-star-proof.txt": { content: proof, truncated: false } }
    });
    if (url.includes("/users/octocat/starred")) return Response.json([{ full_name: "userInner/JobDeck" }]);
    return Response.json({}, { status: 404 });
  };
  try {
    const service = new StarRewardService({ sub2api, directory, fetchImpl, repository: "userInner/JobDeck", amount: 5 });
    const challenge = await service.createChallenge("account-token", "octocat");
    proof = challenge.proof;
    const result = await service.claim("account-token", {
      challengeId: challenge.challengeId,
      gistUrl: "https://gist.github.com/octocat/0123456789abcdef0123"
    });
    assert.equal(result.amount, 5);
    assert.equal(rewarded.length, 1);
    assert.equal(rewarded[0].userId, "42");
    assert.match(rewarded[0].rewardCode, /^jobdeck-star-/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "star-rewards.json"), "utf8")).rewards[0].status, "rewarded");

    await assert.rejects(
      () => service.createChallenge("account-token", "octocat"),
      (error) => error instanceof StarRewardError && error.code === "ALREADY_REWARDED"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Star reward rejects a gist owned by a different GitHub account", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-star-"));
  let proof;
  const sub2api = { rewardEnabled: true, profile: async () => ({ id: 42 }), rewardUser: async () => assert.fail("must not reward") };
  const fetchImpl = async (url) => {
    if (url.endsWith("/users/octocat")) return Response.json({ id: 7, login: "octocat" });
    if (url.includes("/gists/")) return Response.json({ public: true, owner: { id: 99 }, files: { "jobdeck-star-proof.txt": { content: proof } } });
    return Response.json([]);
  };
  try {
    const service = new StarRewardService({ sub2api, directory, fetchImpl });
    const challenge = await service.createChallenge("token", "octocat");
    proof = challenge.proof;
    await assert.rejects(
      () => service.claim("token", { challengeId: challenge.challengeId, gistUrl: "0123456789abcdef0123" }),
      /Gist 不属于申请奖励的 GitHub 账号/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Star screenshot proof is stored for manual review and never credits automatically", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-star-"));
  const rewarded = [];
  const screenshot = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(512, 0x41)
  ]);
  const sub2api = {
    rewardEnabled: true,
    profile: async () => ({ id: 42, email: "user@example.com" }),
    rewardUser: async (input) => rewarded.push(input)
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/users/octocat")) return Response.json({ id: 7, login: "octocat" });
    if (url.includes("/users/octocat/starred")) return Response.json([{ full_name: "userInner/JobDeck" }]);
    return Response.json({}, { status: 404 });
  };
  try {
    const service = new StarRewardService({ sub2api, directory, fetchImpl, repository: "userInner/JobDeck", amount: 5 });
    const result = await service.claimScreenshot("account-token", { username: "octocat", screenshot });

    assert.equal(result.amount, 5);
    assert.equal(result.status, "pending_review");
    assert.equal(result.reviewRequired, true);
    assert.deepEqual(result.evidence, { type: "screenshot", mime: "image/png", bytes: screenshot.length });
    assert.equal(rewarded.length, 0);

    const ledger = JSON.parse(fs.readFileSync(path.join(directory, "star-rewards.json"), "utf8"));
    assert.equal(ledger.rewards[0].evidenceType, "screenshot");
    assert.equal(ledger.rewards[0].evidenceHash.length, 64);
    assert.equal(ledger.rewards[0].status, "pending_review");
    assert.equal(ledger.rewards[0].reviewRequired, true);
    const evidencePath = path.join(directory, "star-reward-evidence", ledger.rewards[0].evidenceFile);
    assert.deepEqual(fs.readFileSync(evidencePath), screenshot);
    assert.equal(fs.statSync(evidencePath).mode & 0o777, 0o600);

    await assert.rejects(
      () => service.claimScreenshot("account-token", { username: "octocat", screenshot }),
      (error) => error instanceof StarRewardError && error.code === "REWARD_PENDING"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Star reward rejects files that are not supported screenshots", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobdeck-star-"));
  const sub2api = {
    rewardEnabled: true,
    profile: async () => ({ id: 42 }),
    rewardUser: async () => assert.fail("must not reward")
  };
  try {
    const service = new StarRewardService({ sub2api, directory, fetchImpl: async () => Response.json({ id: 7, login: "octocat" }) });
    await assert.rejects(
      () => service.claimScreenshot("token", { username: "octocat", screenshot: Buffer.alloc(512, 0x41) }),
      (error) => error instanceof StarRewardError && error.code === "SCREENSHOT_INVALID"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
