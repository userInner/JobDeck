# JobDeck × Sub2API 账号与 Star 奖励需求规格

文档状态：Draft 1.0  
目标版本：JobDeck 0.16 / Sub2API 对接版本  
项目仓库：`userInner/JobDeck`  
账号服务：`https://sub2api.aibro.vip`  
默认奖励：5 USD AI 额度

## 1. 背景

JobDeck 是一个由 Web 工作台、Chrome 扩展和 AI 模型服务组成的求职 Agent。用户需要在 JobDeck 中完成 AI 账号注册、登录、额度查看与模型调用；同时，项目希望向真实 Star GitHub 仓库的用户发放一次性 5 USD AI 额度。

账号、余额、API Key 与用量账单由 Sub2API 管理。JobDeck 不自建密码数据库，不保存用户密码，也不在浏览器中暴露 Sub2API 管理密钥。

## 2. 目标

### 2.1 必须实现

1. 用户可通过邮箱、邮箱验证码和密码完成注册。
2. 用户可通过邮箱和密码登录，不接入任何 OAuth。
3. 支持 Access Token、Refresh Token、退出登录和当前用户查询。
4. JobDeck 可读取当前账号余额。
5. JobDeck 服务端可为通过 GitHub Star 验证的账号一次性增加 5 USD 余额。
6. 奖励接口必须支持幂等、审计、重复领取防护和失败重试。
7. 管理密钥只能用于服务端到服务端调用。
8. 用户能够创建供 JobDeck 模型调用使用的 Sub2API API Key。

### 2.2 不在本期范围

1. Google、GitHub、OIDC、Telegram 等 OAuth 登录。
2. Sub2API 直接验证 GitHub Star 或接管 GitHub 身份证明。
3. Sub2API 控制 Chrome、BOSS 直聘或 JobDeck 浏览器扩展。
4. Sub2API 保存用户简历、岗位、招聘消息或浏览器数据。
5. 自动接受 Offer、协议或其他招聘承诺。

## 3. 系统边界

```text
用户浏览器
  ├─ JobDeck Web：登录表单、余额、领取奖励
  └─ Chrome 扩展：求职页面操作
          │
          │ HTTPS
          ▼
JobDeck 服务端
  ├─ 转发注册、登录和用户查询
  ├─ 验证 GitHub Star 与公开 Gist
  ├─ 保存奖励流水
  └─ 使用管理密钥请求发放奖励
          │
          │ HTTPS / Bearer Token / Admin API Key
          ▼
Sub2API
  ├─ 用户与密码
  ├─ Access/Refresh Token
  ├─ API Key
  ├─ 余额与用量
  └─ 充值、幂等与账务审计
```

职责划分：

| 能力 | JobDeck | Sub2API |
| --- | --- | --- |
| 邮箱与密码表单 | 展示、转发 | 校验、存储、认证 |
| 邮箱验证码 | 发起请求 | 生成、发送、校验 |
| 用户 Token | 浏览器会话暂存 | 签发、刷新、撤销 |
| GitHub Star | 验证 | 不负责 |
| 防重复领取 | 业务侧初筛 | 最终幂等兜底 |
| 余额发放 | 发起服务端请求 | 原子入账、记录流水 |
| 模型 API Key | 引导创建、使用 | 生成、撤销、计费 |
| AI 用量 | 展示或消费 | 扣费、账单、余额一致性 |

### 3.1 当前能力与待办判断

根据当前 Sub2API 路由和公开配置的初步核对：

| 能力 | 当前判断 | Sub2API 本期工作 |
| --- | --- | --- |
| 邮箱注册/登录 | 已有 | 保证接口契约并补集成测试 |
| 邮箱验证码 | 已有且已启用 | 确认频率限制和稳定错误码 |
| Token 刷新/退出 | 已有 | 确认轮换、撤销和幂等语义 |
| 当前用户资料 | 已有 | 固定 `user_id` 与余额字段 |
| 用户 API Key | 已有 | 确认创建时只返回一次完整 Key |
| 管理端创建并兑换 | 已有 | 重点确认事务与 `Idempotency-Key` 语义 |
| 奖励结果查询 | 未确认 | 建议新增按 `external_ref` 查询接口 |
| 管理密钥最小权限 | 未确认 | 建议增加 JobDeck 专用 Scope |
| GitHub Star 验证 | 不需要提供 | 由 JobDeck 完成 |

因此本需求不是要求 Sub2API 重做整套认证系统；主要工作是稳定现有契约、补强奖励幂等和审计，并提供可恢复的奖励查询能力。

## 4. 用户流程

### 4.1 注册

1. 用户输入邮箱。
2. JobDeck 请求 Sub2API 发送验证码。
3. 用户输入验证码和至少 6 位密码。
4. JobDeck 请求 Sub2API 注册。
5. 注册成功后自动登录，或由注册接口直接返回登录 Token。
6. JobDeck 查询用户资料和余额。

### 4.2 登录

1. 用户输入邮箱和密码。
2. Sub2API 返回 Access Token、Refresh Token 和有效期。
3. Access Token 与 Refresh Token 仅保存在当前浏览器会话中。
4. Access Token 过期时，JobDeck 使用 Refresh Token 刷新一次。
5. 刷新失败后清除本地会话并要求重新登录。

### 4.3 创建模型 API Key

1. 登录用户请求创建名为 `JobDeck` 的 API Key。
2. Sub2API 仅在创建成功时返回一次完整密钥。
3. JobDeck 将密钥保存到用户自己的本地 JobDeck 服务，不进入网页日志或奖励流水。
4. 用户可在 Sub2API 撤销该 Key。

### 4.4 Star 奖励

1. 用户先登录 Sub2API 账号。
2. 用户填写 GitHub 用户名。
3. JobDeck 查询 GitHub 公共用户信息并生成 30 分钟有效的一次性证明。
4. 用户在本人 GitHub 账号下创建公开 Gist：
   - 文件名：`jobdeck-star-proof.txt`
   - 内容：JobDeck 生成的一次性证明原文。
5. JobDeck 验证：
   - Gist 为公开状态；
   - Gist 所有者 ID 与申请 GitHub 用户 ID 相同；
   - 一次性证明完全一致且未过期；
   - GitHub 用户公开 Star 列表包含 `userInner/JobDeck`；
   - GitHub 账号未领取过；
   - Sub2API 用户账号未领取过。
6. JobDeck 生成稳定的 `external_ref` 或兑换码，并调用 Sub2API 管理奖励接口。
7. Sub2API 原子增加 5 USD 余额并记录账务流水。
8. JobDeck 回读用户资料或余额，向用户显示领取结果。

## 5. Sub2API 接口要求

统一要求：

- Base URL：`https://sub2api.aibro.vip`
- JSON 编码：UTF-8
- 成功响应建议：`{ "code": 0, "message": "ok", "data": ... }`
- 失败响应建议：`{ "code": "STABLE_ERROR_CODE", "message": "可安全展示的信息" }`
- 所有远程请求必须使用 HTTPS。
- 时间使用 ISO 8601 UTC，金额不得用二进制浮点直接参与核心账务计算。

### 5.1 公共配置

```http
GET /api/v1/settings/public
```

最低返回字段：

```json
{
  "code": 0,
  "data": {
    "site_name": "OnPeople",
    "registration_enabled": true,
    "email_verify_enabled": true
  }
}
```

验收要求：不得返回管理密钥、SMTP 密码、JWT Secret、数据库信息或内部服务地址。

### 5.2 发送邮箱验证码

```http
POST /api/v1/auth/send-verify-code
Content-Type: application/json
```

请求：

```json
{
  "email": "user@example.com"
}
```

建议响应：

```json
{
  "code": 0,
  "data": {
    "message": "verification code sent",
    "countdown": 60
  }
}
```

要求：

- 同邮箱、同 IP、同设备设置频率限制。
- 不通过返回内容泄露邮箱是否已经注册。
- 验证码必须有有效期、单次使用并限制错误次数。
- 邮件发送失败不得生成可继续注册的有效验证码。

### 5.3 注册

```http
POST /api/v1/auth/register
Content-Type: application/json
```

请求：

```json
{
  "email": "user@example.com",
  "password": "user-password",
  "verify_code": "123456"
}
```

要求：

- 邮箱标准化为小写并去除首尾空格。
- 邮箱唯一。
- 密码至少 6 位；生产环境建议至少 8 位，并阻止常见弱密码。
- 密码使用 Argon2id 或 bcrypt 等安全算法加盐哈希，不得可逆存储。
- 注册与验证码消费必须保持一致性。
- `registration_enabled=false` 时返回稳定错误码。
- 注册成功可返回 Token；如果只返回用户信息，JobDeck 会继续调用登录接口。

### 5.4 登录

```http
POST /api/v1/auth/login
Content-Type: application/json
```

请求：

```json
{
  "email": "user@example.com",
  "password": "user-password"
}
```

响应：

```json
{
  "code": 0,
  "data": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_in": 3600,
    "token_type": "Bearer",
    "user": {
      "id": 123,
      "email": "user@example.com",
      "balance": 5.0
    }
  }
}
```

要求：

- 失败信息不得区分“邮箱不存在”和“密码错误”。
- 对 IP、账号和设备维度限流。
- Access Token 应短期有效。
- Refresh Token 可撤销、可轮换，服务端保存哈希或会话记录。
- 不在日志中记录密码和完整 Token。

### 5.5 刷新与退出

```http
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
```

请求：

```json
{
  "refresh_token": "..."
}
```

要求：

- 刷新成功后建议轮换 Refresh Token。
- 旧 Refresh Token 被复用时可撤销同一会话族。
- 退出登录后 Refresh Token 必须失效。
- 重复退出应保持幂等。

### 5.6 当前用户与余额

```http
GET /api/v1/user/profile
Authorization: Bearer <access_token>
```

最低返回：

```json
{
  "code": 0,
  "data": {
    "id": 123,
    "email": "user@example.com",
    "status": "active",
    "balance": 5.0
  }
}
```

要求：

- `id` 必须长期稳定且不可被用户修改。
- `balance` 的单位和精度必须在文档中固定为 USD。
- 封禁、删除或未激活账号必须返回明确状态。

### 5.7 API Key

建议保持以下接口：

```http
GET    /api/v1/keys
POST   /api/v1/keys
DELETE /api/v1/keys/:id
Authorization: Bearer <access_token>
```

创建请求示例：

```json
{
  "name": "JobDeck"
}
```

要求：

- 完整 Key 仅在创建成功时返回一次。
- 列表只显示 Key 前后缀、创建时间、最近使用时间和状态。
- 支持撤销，撤销后立即停止使用。
- API Key 仅能消费所属用户余额，不能调用管理接口。

### 5.8 管理端一次性奖励

推荐复用：

```http
POST /api/v1/admin/redeem-codes/create-and-redeem
X-API-Key: <admin_api_key>
Idempotency-Key: <stable_external_ref>
Content-Type: application/json
```

请求：

```json
{
  "code": "jobdeck-star-userinner-jobdeck-99123-123",
  "type": "balance",
  "value": 5,
  "user_id": 123,
  "notes": "JobDeck GitHub Star reward: octocat starred userInner/JobDeck"
}
```

成功响应至少包含：

```json
{
  "code": 0,
  "data": {
    "user_id": 123,
    "amount": 5,
    "balance_after": 12.5,
    "redeemed": true,
    "transaction_id": "txn_...",
    "external_ref": "jobdeck-star-userinner-jobdeck-99123-123"
  }
}
```

必须满足：

1. `user_id` 存在且状态允许入账。
2. `value` 为正数，并受服务端奖励上限约束。
3. 兑换码、`Idempotency-Key` 或 `external_ref` 全局唯一。
4. 创建奖励记录、更新余额、创建账务流水必须在同一数据库事务中完成。
5. 相同幂等键和相同参数重复调用必须返回第一次的结果，不得再次加款。
6. 相同幂等键但参数不同必须返回冲突，不得覆盖原记录。
7. 网络超时后 JobDeck 可以安全使用同一幂等键重试。
8. 响应不得返回管理密钥或其他用户信息。

## 6. 建议新增的奖励状态查询接口

为解决“Sub2API 已入账，但 JobDeck 在收到响应前网络中断”的不确定状态，建议新增：

```http
GET /api/v1/admin/rewards/by-external-ref/:external_ref
X-API-Key: <admin_api_key>
```

响应：

```json
{
  "code": 0,
  "data": {
    "external_ref": "jobdeck-star-userinner-jobdeck-99123-123",
    "status": "succeeded",
    "user_id": 123,
    "amount": 5,
    "balance_after": 12.5,
    "transaction_id": "txn_...",
    "created_at": "2026-08-24T08:00:00Z"
  }
}
```

允许状态：`pending`、`succeeded`、`failed`、`reversed`。不存在时返回 `404 REWARD_NOT_FOUND`。

如果现有 `create-and-redeem` 已能用同一幂等键稳定返回原结果，本接口可列为 P1；否则属于 P0。

## 7. 数据与账务要求

### 7.1 奖励流水最低字段

| 字段 | 说明 |
| --- | --- |
| `id` | 内部唯一编号 |
| `external_ref` | JobDeck 生成的稳定幂等编号 |
| `source` | 固定为 `jobdeck_github_star` |
| `user_id` | Sub2API 用户编号 |
| `amount` | 5 USD |
| `currency` | `USD` |
| `balance_before` | 入账前余额 |
| `balance_after` | 入账后余额 |
| `status` | 处理状态 |
| `notes` | 可审计说明 |
| `created_at` | 创建时间 |
| `completed_at` | 完成时间 |

不建议把 GitHub Gist 原文、一次性证明或完整访问 Token写入账务表。若记录 GitHub 身份，只保存公开的用户 ID 和用户名。

### 7.2 金额精度

- 数据库存储使用定点数，例如 `DECIMAL(20, 8)`，或使用整数最小计费单位。
- 接口文档必须明确 5 表示 5 USD，而不是 5 分、5 Token 或内部积分。
- 加款与模型消费共用同一余额一致性策略，禁止出现负余额竞态。

## 8. 权限与密钥

建议为 JobDeck 单独创建管理凭证，而不是复用全权限管理员账号。

最低权限：

```text
user:read
reward:create_and_redeem
reward:read
```

禁止授予：

```text
user:delete
user:password_reset
admin:key_manage
system:settings_write
```

管理密钥要求：

- 仅配置在 JobDeck 服务端环境变量 `SUB2API_ADMIN_API_KEY`。
- 支持单独撤销和轮换。
- 支持来源 IP 白名单时，应允许配置 JobDeck 服务器出口 IP。
- 日志只显示凭证编号或后四位，不记录完整值。

## 9. 错误码

Sub2API 应返回稳定、机器可判断的错误码：

| HTTP | 错误码 | 场景 | JobDeck 行为 |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 字段错误 | 提示用户修改 |
| 400 | `VERIFY_CODE_INVALID` | 验证码错误 | 允许重试 |
| 401 | `INVALID_CREDENTIALS` | 登录失败 | 不区分邮箱/密码 |
| 401 | `TOKEN_EXPIRED` | Access Token 过期 | 刷新一次 |
| 403 | `ACCOUNT_DISABLED` | 账号不可用 | 停止流程 |
| 403 | `ADMIN_SCOPE_REQUIRED` | 管理密钥权限不足 | 管理员处理 |
| 409 | `EMAIL_ALREADY_EXISTS` | 邮箱已注册 | 引导登录 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同键不同参数 | 禁止继续重试 |
| 422 | `REWARD_NOT_ALLOWED` | 账号不允许奖励 | 展示原因 |
| 429 | `RATE_LIMITED` | 频率过高 | 按 Retry-After 等待 |
| 500 | `BALANCE_TRANSACTION_FAILED` | 账务事务失败 | 同键安全重试 |
| 503 | `SERVICE_UNAVAILABLE` | 服务不可用 | 稍后重试 |

错误信息不得暴露 SQL、堆栈、内部路径、密钥、Token 或其他用户数据。

## 10. 安全要求

1. 不实现 OAuth，不要求用户向 JobDeck 提供 GitHub Token。
2. GitHub 身份证明由公开 Gist 完成；Sub2API 只接受 JobDeck 服务端已验证的奖励请求。
3. 密码不写入 JobDeck 日志、数据库或浏览器持久存储。
4. 用户 Access Token 不得拥有管理权限。
5. 管理奖励接口不得允许浏览器跨域直接调用。
6. 注册、登录、发验证码和奖励接口都必须限流。
7. 奖励接口需要审计操作者、调用来源、用户、金额、幂等键和结果。
8. 所有日志需对邮箱、Token、API Key 和管理密钥脱敏。
9. 对重复领取的最终防线是 Sub2API 的幂等入账，而不是只相信 JobDeck 本地状态。
10. 备份恢复后仍必须保留幂等记录和账务流水。

## 11. 多用户说明

Sub2API 负责账号、余额和 API Key；JobDeck 自身已经按 Sub2API `user_id` 实现运行时多租户隔离：

- 简历、岗位、消息、模型密钥、Agent 状态和浏览器桥接会话使用独立租户目录与运行时；
- Web API 用 Sub2API Access Token 解析租户，Chrome 扩展使用每个账号独立生成的连接码；
- 后台 Agent 计时器重新进入所属租户上下文，导出只包含当前账号数据；
- 原始 `user_id` 不作为目录名，磁盘目录使用不可逆哈希标识。

当前 JSON 存储部署为单服务副本设计。需要多副本横向扩容时，应把租户索引、任务租约和奖励账本迁移到共享数据库，并为后台任务增加分布式锁。

## 12. 可观测性

最低指标：

- 注册成功/失败数量；
- 登录成功/失败与限流数量；
- Token 刷新成功率；
- 奖励请求数量；
- 奖励成功、失败、幂等命中数量；
- 余额事务耗时；
- 账号服务 4xx/5xx 比例。

日志关联字段：`request_id`、`external_ref`、`user_id`、`transaction_id`。不得记录密码和完整 Token。

告警建议：

- 5 分钟内奖励失败率超过 5%；
- 单用户或单 IP 奖励请求异常升高；
- 相同幂等键出现参数冲突；
- 余额事务出现不一致或负数；
- 管理密钥认证连续失败。

## 13. 测试要求

### 13.1 认证

- 正常发送验证码、注册、登录、刷新和退出。
- 错误验证码、过期验证码、重复使用验证码。
- 重复邮箱、邮箱大小写与空格标准化。
- 弱密码和异常长输入。
- 登录爆破限流。
- Access Token 过期、Refresh Token 撤销和重复退出。

### 13.2 奖励

- 合法用户获得 5 USD。
- 相同幂等键连续请求 2 次，只加款 1 次。
- 首次请求已提交但客户端超时，使用同键重试仍只加款 1 次。
- 同键不同 `user_id` 或不同金额返回冲突。
- 不存在、封禁或删除用户不能入账。
- 两个并发请求同时奖励同一用户，只产生一笔成功流水。
- 数据库事务中途失败时余额和流水同时回滚。
- 服务重启、数据库恢复后幂等仍有效。

### 13.3 安全

- 普通用户 Token 调用管理奖励接口必须返回 403。
- 浏览器无法获取管理密钥。
- 响应和日志不泄露密码、Token 与内部错误。
- 超长 notes、code 和恶意 JSON 不得造成注入或服务异常。

## 14. 验收标准

以下项目全部满足才可上线：

- [ ] 邮箱注册、登录、刷新、退出全流程可用。
- [ ] 不存在 OAuth 依赖或强制跳转。
- [ ] 当前用户接口返回稳定用户 ID 和 USD 余额。
- [ ] 用户可创建、查看和撤销 JobDeck API Key。
- [ ] 服务端管理凭证支持最小权限和独立撤销。
- [ ] 奖励接口支持稳定幂等键。
- [ ] 同一奖励重试 10 次，余额只增加 5 USD。
- [ ] 入账和流水处于同一数据库事务。
- [ ] 奖励结果可以通过原幂等键重放或查询。
- [ ] 注册、登录、验证码和奖励接口均有限流。
- [ ] 管理密钥、密码和完整 Token 不出现在日志与响应中。
- [ ] 单元测试、集成测试和并发测试通过。
- [ ] Staging 环境完成一次真实注册、创建 Key、奖励、模型消费和余额核对。

## 15. 上线步骤

1. 在 Sub2API Staging 验证现有接口字段与本文一致。
2. 补充缺失的稳定错误码、幂等语义和奖励查询能力。
3. 创建 JobDeck 专用的最小权限管理密钥。
4. JobDeck Staging 配置：

   ```text
   SUB2API_BASE_URL=https://sub2api.aibro.vip
   SUB2API_ADMIN_API_KEY=***
   GITHUB_REPOSITORY=userInner/JobDeck
   STAR_REWARD_USD=5
   ```

5. 使用测试账号完成注册、登录和 API Key 创建。
6. 使用测试 GitHub 账号完成 Star、Gist 验证和 5 USD 入账。
7. 重复提交同一领取请求，确认没有二次入账。
8. 检查用户余额、账务流水、审计日志和指标。
9. 轮换测试管理密钥，配置生产密钥后上线。
10. 上线初期设置每日奖励总额告警和人工对账。

## 16. 双方需要确认的最终契约

Sub2API 开发开始前，需要确认以下四项：

1. `balance` 的单位是否明确为 USD，以及支持的小数精度。
2. `create-and-redeem` 对相同 `Idempotency-Key` 的精确行为。
3. 管理 API Key 是否能配置仅奖励相关的最小权限。
4. 是否提供按 `external_ref` 查询奖励结果的接口；如果不提供，重复调用是否稳定返回第一次的完整结果。

这四项确认后，JobDeck 侧不需要 OAuth，也不需要与 Sub2API 共享 GitHub 凭证，即可安全完成账号和 Star 奖励闭环。
