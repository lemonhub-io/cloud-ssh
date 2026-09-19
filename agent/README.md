# CloudSSH Agent

CloudSSH 的 P2P 网关：浏览器经 WebRTC `RTCDataChannel` 直连本进程，本进程用 `net.connect` 向目标 SSH 主机发起 TCP 连接。Cloudflare 侧只承担 offer/answer 信令与元数据协调，会话流量不经过 Worker。

## 拓扑

```text
Browser ── RTCDataChannel (ssh / sftp) ──► Agent ── net.connect ──► sshd
   ▲                                        ▲
   └──── signaling: WS ⇄ Worker/DO ─────────┘
        TURN: Cloudflare Realtime（可选 + 自建 TURN 兜底）
```

- 信令通道：`wss://<site>/api/agent/ws`，由 Agent 出站维持，带指数退避重连。
- 数据通道：`ssh` DataChannel 承载终端控制帧 + 二进制流；`sftp` DataChannel 承载 SFTP 子系统。
- SSH 协议栈复用 Worker 同一份 `src/ssh/*` 与 `SSHSession`，跳板链、主机指纹校验、keyboard-interactive、断线恢复语义与中继路径一致。

## 一键安装（推荐）

在 Web 端 **Agent** 面板创建 Agent 后，令牌下方直接给出内嵌令牌与站点地址的成品命令：

```bash
# Linux / macOS —— 免安装二进制 + 600 权限配置 + 开机自启（systemd --user / launchd）
curl -fsSL https://ssh.lemonhub.online/install.sh | sh -s -- --token <githubId>:<agentId>:<secret>

# Windows（PowerShell）—— exe + 登录计划任务
iex "& { $(irm https://ssh.lemonhub.online/install.ps1) } -Token '<githubId>:<agentId>:<secret>'"
```

- 二进制为 Node SEA 单文件可执行文件（linux/darwin/windows × x64/arm64），**目标机无需 Node.js**。
- 下载多镜像回退：`https://<site>/api/agent/download/<asset>` 本站代理 → GitHub Release `agent-latest` 直连，被墙与机房网络均可完成。
- **Agent 回连（信令 WS + 审计/OS 回传）默认指向自定义域名**（生产不使用 workers.dev）。注意：若 zone 安全设置对机房 IP 弹 CF 托管挑战（403 "Just a moment"），需在 Cloudflare Dashboard 调整（关闭 Bot Fight Mode，或为 `/api/agent/*`、`/install.*` 等机端路径加 WAF skip 规则），否则机端信令与下载可能被拦。
- 凭据写入 `~/.config/cloudssh-agent/agent.env`（0600）而非命令行；`--no-service` 可跳过自启、直接前台运行；`--server` 显式覆盖回连源。
- 二进制由 `.github/workflows/release-agent.yml` 在 `agent/**` 变更时自动构建（`agent/scripts/build-sea.sh`：esbuild 全量 CJS 打包 → sea blob → postject 注入各平台官方 node 二进制）。

## 手动运行（源码）

```bash
pnpm install && pnpm run build
node dist/agent.js \
  --server https://ssh.lemonhub.online \
  --token <githubId>:<agentId>:<secret> \
  --allowlist '*.corp.local,bastion.internal' \
  --max-sessions 8
```

未打包时也可 `pnpm exec tsx src/cli.ts ...` 直接跑源码。

### 参数与环境变量

| 参数 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--server` | `AGENT_SERVER` | `https://ssh.lemonhub.online` | 站点源（默认生产自定义域名） |
| `--token` | `AGENT_TOKEN` | — | 创建 Agent 时一次性返回的令牌 |
| `--signal-url` | `AGENT_SIGNAL_URL` | 由 server 推导 | 信令 WS 覆盖 |
| `--allowlist` | `AGENT_ALLOWLIST` | 不限制 | 目标 host 白名单，支持 `*.domain` |
| `--max-sessions` | `AGENT_MAX_SESSIONS` | `8` | 并发会话上限 |
| `--debug` | `AGENT_DEBUG` | `false` | 详细日志 |

## 行为说明

- **令牌**：`<githubId>:<agentId>:<secret>`，服务端只存 SHA-256 哈希；丢失需在 Web 端重新创建。
- **安全边界**：目标白名单 + 高危端口黑名单（23/80/443/25/3306/6379/…）在 session_init 时逐节点校验（含全部跳板）。
- **断线恢复**：DataChannel 断开后会话保留 60s 宽限（`SESSION_GRACE_PERIOD_MS`），恢复时校验 resume token（容忍上一代一次）并轮换；设备绑定的分享会话要求 ECDSA P-256 签名挑战。
- **审计/OS 回传**：分享会话的终端/SFTP/生命周期审计经 `POST /internal/agent/audit` 回传 ShareDO；已保存服务器的 OS 识别结果回传 UserDBDO。
- **凭据**：解密发生在服务端，`session_init` 经信令通道下发（与中继路径同一信任模型）；Agent 不落盘任何凭据。

## 开发

```bash
pnpm --dir agent exec tsc --noEmit   # 类型检查
pnpm --dir agent run build           # esbuild 打包 → dist/agent.js
pnpm --dir agent run build:sea       # Node SEA 跨平台单文件二进制 → dist/sea/
pnpm test                            # 根 vitest 会跑 agent/tests（含 werift loopback）
```
