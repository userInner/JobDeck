import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const CHALLENGE_TTL_MS = 30 * 60 * 1000;

export class StarRewardError extends Error {
  constructor(message, status = 400, code = "STAR_REWARD_ERROR") {
    super(message);
    this.name = "StarRewardError";
    this.status = status;
    this.code = code;
  }
}

function accountId(profile) {
  return String(profile?.id ?? profile?.user_id ?? profile?.user?.id ?? "");
}

function safeSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

export class StarRewardService {
  constructor({
    sub2api,
    repository = process.env.GITHUB_REPOSITORY || "userInner/JobDeck",
    amount = Number(process.env.STAR_REWARD_USD || 5),
    githubToken = process.env.GITHUB_TOKEN || "",
    directory = process.env.JOBDECK_DATA_DIR || path.join(os.homedir(), ".jobdeck-local"),
    fetchImpl = globalThis.fetch,
    now = () => Date.now()
  } = {}) {
    this.sub2api = sub2api;
    this.repository = repository;
    this.amount = Number.isFinite(amount) && amount > 0 ? amount : 5;
    this.githubToken = String(githubToken).trim();
    this.fetch = fetchImpl;
    this.now = now;
    this.file = path.join(directory, "star-rewards.json");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.ledger = this.load();
  }

  get enabled() {
    return Boolean(this.sub2api?.rewardEnabled);
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { challenges: parsed.challenges || {}, rewards: parsed.rewards || [] };
    } catch {
      return { challenges: {}, rewards: [] };
    }
  }

  save() {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.ledger, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  githubHeaders() {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "JobDeck-Star-Rewards",
      ...(this.githubToken ? { Authorization: `Bearer ${this.githubToken}` } : {})
    };
  }

  async github(pathname) {
    const response = await this.fetch(`https://api.github.com${pathname}`, { headers: this.githubHeaders(), signal: AbortSignal.timeout(12_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 404) throw new StarRewardError("没有找到该 GitHub 用户或 Gist", 404, "GITHUB_NOT_FOUND");
      if (response.status === 403 || response.status === 429) throw new StarRewardError("GitHub 校验请求过于频繁，请稍后重试", 429, "GITHUB_RATE_LIMIT");
      throw new StarRewardError("暂时无法验证 GitHub 信息", 502, "GITHUB_ERROR");
    }
    return payload;
  }

  async authenticatedProfile(accessToken) {
    if (!accessToken) throw new StarRewardError("请先登录 AI 账号", 401, "ACCOUNT_REQUIRED");
    const profile = await this.sub2api.profile(accessToken);
    if (!accountId(profile)) throw new StarRewardError("账号信息缺少用户编号", 502, "ACCOUNT_INVALID");
    return profile;
  }

  async createChallenge(accessToken, username) {
    const profile = await this.authenticatedProfile(accessToken);
    const normalized = String(username || "").trim();
    if (!USERNAME_PATTERN.test(normalized)) throw new StarRewardError("GitHub 用户名格式不正确");
    const githubUser = await this.github(`/users/${encodeURIComponent(normalized)}`);
    const userId = accountId(profile);
    const previous = this.ledger.rewards.find((item) => String(item.sub2apiUserId) === userId || item.githubUserId === githubUser.id);
    if (previous?.status === "rewarded") throw new StarRewardError("该 AI 账号或 GitHub 账号已经领取过奖励", 409, "ALREADY_REWARDED");
    if (previous?.status === "pending" && (String(previous.sub2apiUserId) !== userId || previous.githubUserId !== githubUser.id)) {
      throw new StarRewardError("该 AI 账号或 GitHub 账号已有奖励正在处理", 409, "REWARD_PENDING");
    }

    const id = crypto.randomUUID();
    const token = crypto.randomBytes(18).toString("base64url");
    const proof = `jobdeck-star:${id}:${token}`;
    this.ledger.challenges[id] = {
      id,
      tokenHash: crypto.createHash("sha256").update(proof).digest("hex"),
      sub2apiUserId: userId,
      githubUserId: githubUser.id,
      githubUsername: githubUser.login,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + CHALLENGE_TTL_MS).toISOString()
    };
    for (const [challengeId, challenge] of Object.entries(this.ledger.challenges)) {
      if (new Date(challenge.expiresAt).getTime() < this.now() - CHALLENGE_TTL_MS) delete this.ledger.challenges[challengeId];
    }
    this.save();
    return { challengeId: id, proof, filename: "jobdeck-star-proof.txt", expiresAt: this.ledger.challenges[id].expiresAt };
  }

  gistId(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/(?:gist\.github\.com\/(?:[^/]+\/)?|^)([a-f\d]{20,64})(?:\/|$)/i);
    if (!match) throw new StarRewardError("请填写公开 Gist 的链接或 ID");
    return match[1];
  }

  async hasStar(username) {
    for (let page = 1; page <= 20; page += 1) {
      const starred = await this.github(`/users/${encodeURIComponent(username)}/starred?per_page=100&page=${page}`);
      if (!Array.isArray(starred)) return false;
      if (starred.some((repo) => String(repo.full_name).toLowerCase() === this.repository.toLowerCase())) return true;
      if (starred.length < 100) return false;
    }
    return false;
  }

  async claim(accessToken, { challengeId, gistUrl }) {
    const profile = await this.authenticatedProfile(accessToken);
    const userId = accountId(profile);
    const challenge = this.ledger.challenges[String(challengeId || "")];
    if (!challenge || challenge.sub2apiUserId !== userId) throw new StarRewardError("领取凭证不存在或不属于当前账号", 404, "CHALLENGE_NOT_FOUND");
    if (new Date(challenge.expiresAt).getTime() < this.now()) throw new StarRewardError("领取凭证已过期，请重新生成", 410, "CHALLENGE_EXPIRED");

    const gist = await this.github(`/gists/${this.gistId(gistUrl)}`);
    if (!gist.public) throw new StarRewardError("Gist 必须设为公开");
    if (gist.owner?.id !== challenge.githubUserId) throw new StarRewardError("Gist 不属于申请奖励的 GitHub 账号");
    const file = gist.files?.["jobdeck-star-proof.txt"];
    if (!file || file.truncated) throw new StarRewardError("Gist 中缺少完整的 jobdeck-star-proof.txt");
    const actualHash = crypto.createHash("sha256").update(String(file.content || "").trim()).digest("hex");
    if (actualHash !== challenge.tokenHash) throw new StarRewardError("Gist 中的一次性证明不匹配");
    if (!(await this.hasStar(challenge.githubUsername))) throw new StarRewardError(`请先公开 Star ${this.repository} 后再领取`, 409, "STAR_NOT_FOUND");

    const duplicate = this.ledger.rewards.find((item) => String(item.sub2apiUserId) === userId || item.githubUserId === challenge.githubUserId);
    if (duplicate?.status === "rewarded") throw new StarRewardError("该 AI 账号或 GitHub 账号已经领取过奖励", 409, "ALREADY_REWARDED");
    if (duplicate?.status === "pending" && (String(duplicate.sub2apiUserId) !== userId || duplicate.githubUserId !== challenge.githubUserId)) {
      throw new StarRewardError("该 AI 账号或 GitHub 账号已有奖励正在处理", 409, "REWARD_PENDING");
    }
    const rewardCode = `jobdeck-star-${safeSlug(this.repository)}-${challenge.githubUserId}-${safeSlug(userId)}`;
    const reward = duplicate || {
      id: crypto.randomUUID(), sub2apiUserId: userId, githubUserId: challenge.githubUserId,
      githubUsername: challenge.githubUsername, repository: this.repository, amount: this.amount,
      rewardCode, status: "pending", createdAt: new Date(this.now()).toISOString()
    };
    if (!duplicate) this.ledger.rewards.push(reward);
    reward.status = "pending";
    reward.lastAttemptAt = new Date(this.now()).toISOString();
    this.save();

    await this.sub2api.rewardUser({
      userId,
      amount: this.amount,
      rewardCode,
      notes: `JobDeck GitHub Star reward: ${challenge.githubUsername} starred ${this.repository}`
    });
    reward.status = "rewarded";
    reward.rewardedAt = new Date(this.now()).toISOString();
    delete this.ledger.challenges[challenge.id];
    this.save();
    return { amount: this.amount, repository: this.repository, githubUsername: challenge.githubUsername, rewardedAt: reward.rewardedAt };
  }
}
