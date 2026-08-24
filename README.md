# JobDeck

JobDeck 是一个 self-hosted、local-Chrome 的 AI 求职 Agent。它把你自己掌控的 Web 工作台与用户自己的 Chrome 会话连接起来，让模型围绕最终目标持续执行“观察 → 规划 → 操作 → 验证”，而不是把求职过程写死成一组固定按钮。工作台既可在本机运行，也可部署到自己的服务器；浏览器操作始终由用户本机安装的扩展执行。

项目当前重点适配 BOSS 直聘，同时保留通用浏览器工具接口，便于继续增加其他招聘网站与求职动作。

![JobDeck 工作台](docs/images/dashboard.jpg)

## 能做什么

- 读取并审查在线简历，生成字段级优化稿。
- 通过 Chrome 扩展执行可见的点击、输入和保存，并回读页面验证结果。
- 根据目标岗位和期望城市发现职位、读取完整 JD、去重并判断技术匹配。
- 针对每份 JD 生成不同的招呼语，执行沟通后验证发送结果。
- 在 AI 对话中直接下达目标，例如“在我的期望城市寻找并沟通 30 个匹配岗位”。
- 保存岗位、沟通、浏览器操作与 Agent 进度，支持暂停和恢复。

JobDeck 不读取 Chrome 的 Cookie 数据库，也不创建独立的自动化浏览器。招聘网站的登录态、扩展和个人资料仍由用户自己的 Chrome 管理。

## Agent 工作方式

Agent 运行时维护一个动态工具注册表。模型每轮只能选择一个工具，读取真实结果后再决定下一步：

![JobDeck 求职 Agent](docs/images/agent.jpg)

```text
用户目标
   ↓
观察工作台、任务和 Chrome 页面
   ↓
模型选择一个已注册工具
   ↓
Chrome / 简历 / 岗位 / 沟通工具执行
   ↓
验证页面和任务进度
   └────────→ 未完成则重新规划
```

任务不会因为执行了固定数量的步骤而自动结束。只有达到可验证目标、用户暂停、需要本人决定，或遇到验证码、登录失效、页面歧义和平台限制时才停止。

## 本地启动

要求 Node.js 22 或更高版本。

```bash
npm install
npm start
```

打开 [http://127.0.0.1:43120](http://127.0.0.1:43120)。macOS 也可以双击 `scripts/start.command`。

## 安装 Chrome 扩展

1. 从 GitHub Releases 下载 `JobDeck-Chrome-Extension-*.zip` 并解压；开发者也可直接使用仓库的 `extension` 目录。
2. 打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择解压后的 `JobDeck-Chrome-Extension` 目录。
4. 固定“JobDeck 求职执行器”，打开侧边栏。
5. 启动本地工作台后，在侧边栏连接 JobDeck。
6. 首次访问招聘网站时，按站点授予访问权限。

使用远程工作台时，在扩展设置填写：

```text
Web 工作台：https://你的域名
执行通道：wss://你的域名/extension
访问令牌：服务器中的 JOBDECK_ACCESS_TOKEN
```

扩展通过 Chrome 的 `debugger` 权限调用输入协议。执行期间页面会显示 JobDeck 光标，Chrome 也会显示调试提示；任务暂停或单步完成后会释放控制。

## 首次配置

在工作台中完成三项设置：

1. 候选人事实：求职状态、目标岗位、期望城市、薪资边界、已核实经历与技术证据。
2. 本地简历：自行选择 PDF 或填写简历正文。个人附件默认不会进入 Git 仓库。
3. 模型连接：填写 OpenAI Responses 或 OpenAI-compatible Chat 接口、模型名称和 API Key。

默认接口地址是 `https://api.openai.com/v1`。也可以使用自建或兼容服务，但远程地址必须使用 HTTPS。

本机运行时，API Key 保存在：

```text
~/.jobdeck-local/secrets.json
```

密钥不会返回给 Web 页面或 Chrome 扩展。

## 部署到服务器

推荐使用带域名的 Linux 服务器。远程扩展连接必须使用 HTTPS/WSS；仓库中的 Caddy 会自动申请并续期证书，同时代理 WebSocket。

```bash
git clone https://github.com/userInner/JobDeck.git
cd JobDeck
cp .env.example .env
```

编辑 `.env`，把域名改成已经解析到服务器的域名，并生成访问令牌：

```bash
openssl rand -hex 32
```

然后启动：

```bash
docker compose --env-file .env -f deploy/compose.https.yaml up -d --build
```

服务器需要开放 TCP 80、TCP 443 和 UDP 443。运行数据保存在 Docker 的 `jobdeck_data` 卷中；更新代码后重新执行上述启动命令即可。建议同时备份该卷，并妥善保存 `.env`。

安全约束：

- 只要服务监听非回环地址，`JOBDECK_ACCESS_TOKEN` 就是必填项，且至少 24 个字符。
- 除健康检查外，所有 API 都需要访问令牌；Web 工作台会在首次进入时要求解锁。
- 扩展与服务端通过 WSS 连接，令牌放在 WebSocket 子协议中，不放在页面 URL。
- 不要把 `.env`、模型 API Key、简历或求职数据提交到 GitHub。

如果已经有 Nginx、Traefik 或 Cloudflare Tunnel，也可以只运行 Dockerfile 中的 JobDeck 服务并自行反向代理 `43120`；反向代理必须支持 WebSocket Upgrade。

## BOSS 直聘适配

专用适配器会识别以下页面：

- 在线简历：读取简历区块、生成优化稿、定位编辑入口并验证保存结果。
- 职位列表：按用户的求职期望进入对应职位与城市，提取候选卡片并本地去重。
- 职位详情：读取标题、公司、地点、薪资、招聘者与完整 JD。
- 沟通页面：读取最近消息、生成安全回复或发送经过授权的定制招呼。

页面结构变化时，Agent 会重新观察并尝试安全的替代动作；无法唯一判断控件时不会猜测点击。

## 安全边界

- 不读取 Chrome 个人资料目录、Cookies 数据库、系统钥匙串或其他扩展数据。
- 不填写密码、验证码、身份证、银行卡、助记词、私钥等敏感信息。
- 不绕过验证码、风控、频率限制或平台规则。
- 不把独立项目和开源贡献伪装成正式工作，也不虚构用户数、营收、团队规模和从业年限。
- 薪资谈判、具体面试时间、Offer、合同、隐私和重大承诺必须由本人确认。
- 对外发送和批量任务必须有明确授权；遇到异常会暂停并保留进度。

## 本地数据

本机运行时，数据默认保存在：

```text
~/.jobdeck-local/state.json
~/.jobdeck-local/secrets.json
```

删除该目录会清空本地状态。工作台支持导出不含密钥的数据。

## 开发与测试

```bash
npm run check
npm run smoke
```

主要目录：

```text
extension/   Chrome 扩展、Computer Use 与 BOSS 页面适配
server/      本地服务、Agent 运行时、模型和任务状态
web/         Web 工作台
test/        Node.js 回归测试
scripts/     启动与冒烟测试
deploy/      Docker Compose 与自动 HTTPS 配置
```

生成扩展安装包：

```bash
npm run package:extension
```

产物位于 `dist/`，发布到 GitHub Release，而不进入 Git 历史。

## 当前状态

JobDeck 仍处于早期开发阶段。招聘网站 DOM 和交互会频繁变化，提交 Issue 时请提供页面类型、可复现步骤、扩展版本和脱敏截图，不要上传简历、聊天记录、API Key 或其他个人信息。

## License

[MIT](LICENSE)
