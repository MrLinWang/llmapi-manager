# LLM API Manager

[English](./README.md) | **简体中文**

自托管的 LLM API 控制台：在一个网页里维护各家 LLM API，聚合成统一模型别名，
再把聚合结果下发到你本机的 Agent（首期支持 Codex CLI 与 Claude Code）。

设计参考了 `cc-switch`（供应商切换 + 把配置写进 Agent、且只拥有最小字段集）与
`new-api`（多渠道网关 + 优先级选路），但代码是独立实现的，未复制两者源码。

## 能力范围

- **供应商管理**：三种协议 —— OpenAI 兼容（Chat Completions）/ OpenAI 兼容（Responses）/ Anthropic 兼容（Messages）；API Key 加密落盘、列表脱敏、优先级排序、启用开关、连通性测试（请求上游 `/models`）、按表单当前值一键拉取上游模型列表并勾选启用；另有**逐档实测**：按思考档位逐个打一次极小请求，让 Codex 模型目录只列出上游真正接受的档位。
- **模型聚合**：把启用供应商的**对话模型**发布为 `lam-<供应商key>/<模型>` 别名；另可配置"默认供应商 + 默认模型"承接不带别名的请求。**生图模型单独一个列表**，不会出现在 Codex 的 `/model` 选择器里。
- **统一网关**：`/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/responses`，外加 `/v1/images/generations` 与 `/v1/images/edits`（Codex 内置生图工具可经网关使用，上游只给图片链接时网关会内联成 `b64_json`）；支持 SSE 流式透传；默认路径失败时按优先级回退一次。
- **Agent 下发**：Codex CLI（`~/.codex/config.toml` + `auth.json` + `llmapi-model-catalog.json`，只接受 `responses` 供应商，`wire_api` 固定 `responses`）与 Claude Code（`~/.claude/settings.json`，需要 `anthropic`）；支持预览、应用、还原、结束 Codex 进程，写前备份，只改自己拥有的键。Windows 上文件位于 `C:\Users\<用户名>\` 下，进程探测/结束改用 PowerShell `Get-CimInstance` + `taskkill`。
- **多设备双向同步（手动）**：一台机器提供配置给其它机器拉取。角色分 `standalone`（默认）/ `master`（只提供）/ `follower`（只拉取）/ `peer`（两者都做）。拉取永远由接收方发起——没有推送、没有定时任务。每租户一份 `sync-state.json` 保存内容哈希，因此合并是**三方**的：「只有对端变了」会自动收敛，真正分叉才变成冲突并保留双版本交给人仲裁。删除不传播，拉取令牌每次随请求提供、不落盘。
- **Windows 桌面应用（Tauri 2）**：Windows 安装包提供原生桌面 App，不再注册 Windows 服务。窗口内嵌现有 Web UI（没有地址栏），后端是随 App 启动/停止的本地 Node/Fastify sidecar。关闭窗口默认隐藏到托盘（第一次会提示），托盘「退出」才停止网关。数据与日志在 `%APPDATA%\llmapi-manager\`，`desktop.env` 保存 `DATA_ENCRYPTION_KEY`（当前用户 ACL）。这台机器作为同步 `peer` / `master` 时，从托盘显式开启「允许局域网访问」。
- **可观测**：请求日志与今日统计（请求数、成功率、平均耗时）。
- **双语界面与双语报错**：控制台支持简体中文 / English 切换，语言偏好保存在服务端
  （租户设置），换浏览器或清缓存后仍然生效；未登录时按浏览器语言显示。
  接口返回的 `error.message`、Agent 描述与诊断输出同样跟随语言。

## 快速开始

```bash
npm install
cp .env.example .env    # 按需修改
npm run dev             # 服务端 :8787 + 前端 :5173
```

打开 http://localhost:5173 ，首次启动会引导你**自己设置**管理员用户名与口令：
把控制台打印的一次性初始化令牌填进设置页即可。

生产模式（单进程托管前端）：

```bash
npm run build
npm start               # http://127.0.0.1:8787
```

Windows 上安装 Tauri 桌面应用，不必装源码：

1. 运行 `llmapi-manager-<version>-x64-setup.exe`（或解压便携 zip 后直接启动 App）。
   安装包**未签名**，SmartScreen 可能提示；先校验 SHA256，确认来源可信后点
   “更多信息”→“仍要运行”。
2. 首次启动会自动拉起 sidecar，从 stdout 捕获一次性 `setup_...` 令牌，并在内嵌窗口打开
   `/setup#token=...`；设置你自己的管理员用户名与口令后进入控制台。已有账号时打开
   登录/控制台。初始化中途退出的话，下次启动会重新生成令牌。
3. 关闭窗口默认隐藏到托盘；托盘「退出」才停止网关。数据与日志在
   `%APPDATA%\llmapi-manager\`，`desktop.env` 保存 `DATA_ENCRYPTION_KEY`。
4. 要让其它设备从这台机器拉取（同步 `peer` / `master`），在托盘开启「允许局域网访问」
   （会重启 sidecar），并在 Windows 防火墙放行入站 TCP 8787（专用网络）。
   `PUBLIC_BASE_URL` 仍是 `http://127.0.0.1:8787`；对端填 `http://<局域网IP>:8787`。

端口固定为 **8787**；被占用时 App 会启动失败，不会自动换端口。从旧 WinSW 服务升级的机器
可从仓库或构建机以管理员运行 `scripts/windows/migrate-from-service.ps1`（该脚本不打进
便携 zip）：停止旧服务、把 `%ProgramData%` 的数据复制到 `%APPDATA%`、导入加密密钥，
并保留源数据。

升级、卸载、防火墙、WebView2 与排错见 [docs/windows.md](./docs/windows.md)。

> 本仓库的开发环境是 Linux，**Windows 桌面壳（Tauri 窗口、托盘、sidecar 生命周期、安装器）
> 没有在这里实际跑过**；CI 的 `windows-desktop` / `windows-desktop-smoke` job 只构建
> 并冒烟，GUI 需在真实 Windows 机器上验收后再依赖。

其他命令：`npm run typecheck`、`npm test`。

## 文档

完整文档在 [docs/](./docs/README.md)：

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | 架构、分层、租户与身份、数据流 |
| [docs/api.md](./docs/api.md) | 接口参考（路径、权限、示例、错误码） |
| [docs/gateway.md](./docs/gateway.md) | 别名、选路、协议匹配、流式转发 |
| [docs/agents.md](./docs/agents.md) | Codex / Claude Code 配置下发细节（含 Windows 路径与进程处理） |
| [docs/sync.md](./docs/sync.md) | 多设备同步：角色（`master` / `follower` / `peer`）、双向手动拉取、三方合并、冲突、Windows/局域网 |
| [docs/windows.md](./docs/windows.md) | Windows 桌面应用（Tauri 2）：安装、托盘、首次初始化、`%APPDATA%` 数据、局域网/防火墙、旧服务迁移、卸载、端口冲突、SmartScreen/WebView2、构建/CI |
| [docs/configuration.md](./docs/configuration.md) | 环境变量、数据目录、部署、迁移 |
| [docs/security.md](./docs/security.md) | 鉴权、权限矩阵、凭据与安全边界 |
| [docs/development.md](./docs/development.md) | 开发、测试、扩展方式 |

参与开发（尤其是 AI 编码代理）请先读 [AGENTS.md](./AGENTS.md)。


## 接口速查

管理接口（需登录会话 Cookie）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与启动告警（免鉴权） |
| POST | `/api/auth/login` / `/api/auth/logout` | 登录 / 退出 |
| GET | `/api/auth/me` | 当前身份、权限与界面语言（`language`，`null` = 跟随浏览器） |
| POST | `/api/auth/password` | 修改口令（会使旧会话失效） |
| GET/POST | `/api/providers` | 供应商列表 / 新增 |
| PUT/DELETE | `/api/providers/:id` | 更新 / 删除 |
| PATCH | `/api/providers/:id/enabled` | 启用开关 |
| POST | `/api/providers/:id/test` | 连通性测试 |
| POST | `/api/providers/:id/probe-efforts` | 逐档实测思考档位（NDJSON 进度流） |
| POST | `/api/providers/models` | 按表单临时值拉取模型列表（新增时也能用） |
| PUT | `/api/providers/order` | 调整优先级顺序 |
| GET | `/api/models` | 聚合别名、默认模型、网关地址与令牌（脱敏） |
| PUT | `/api/settings/default` | 设置默认供应商与模型 |
| GET | `/api/settings` | 读取租户设置（含 `language`、`disableCodexWebSearch`） |
| PATCH | `/api/settings/language` | 设置界面语言：`zh` / `en` / `null`（跟随浏览器） |
| PATCH | `/api/settings/codex` | Codex 行为开关：是否关闭联网搜索 |
| POST | `/api/gateway/token` | 生成/重置网关令牌（明文只返回一次） |
| GET | `/api/agents` | Agent 列表与接管状态 |
| POST | `/api/agents/:id/preview` \| `apply` \| `revert` | 预览 / 应用 / 还原 |
| POST | `/api/agents/:id/stop-processes` | 结束本机 Codex 进程，使其重读配置 |
| GET | `/api/sync/status` | 同步角色、对端地址、范围、上次拉取结果、冲突数，以及 `canServe` / `canPull` / `hasSyncRead` / `hasSyncWrite` |
| PATCH | `/api/sync/config` | 设置角色（`standalone` / `master` / `follower` / `peer`）、对端地址（`masterUrl`）、范围 |
| GET | `/api/sync/snapshot` | 导出快照（权限 `sync:read`，角色 `master` / `peer`） |
| POST | `/api/sync/pull` | 从对端拉取（权限 `sync:write`，角色 `follower` / `peer`，令牌在请求体） |
| GET | `/api/sync/conflicts` | 待仲裁冲突（已剔除封存值） |
| POST | `/api/sync/conflicts/:id/resolve` | `{ "choice": "local" \| "remote" }` |
| GET | `/api/logs`、`/api/stats` | 请求日志与统计 |

网关接口（需网关令牌，`Authorization: Bearer <token>` 或 `x-api-key`）：

```
GET  /v1/models
POST /v1/chat/completions    # 需要 apiType=openai 的上游（OpenAI 兼容 · Chat Completions）
POST /v1/messages            # 需要 apiType=anthropic 的上游（Anthropic 兼容 · Messages）
POST /v1/responses           # 需要 apiType=responses 的上游（OpenAI 兼容 · Responses）
POST /v1/images/generations  # 生图；需要 apiType 为 openai 或 responses 的上游
POST /v1/images/edits        # 改图；需要 apiType 为 openai 或 responses 的上游
```

对话路径都是**严格匹配**：协议不符返回 501，不会退化成正向直通。两条生图路径是例外——
它们同时接受 `openai` 与 `responses` 供应商，因为 `apiType` 描述的是对话协议，
不描述"有没有实现 Images 端点"（实测 `responses` 类型的上游照样能生图，`openai` 类型的
反而可能没有生图渠道）。上游若只返回 `data[].url`，网关会下载图片并内联成 `b64_json`，
因为 Codex 只认这个字段。
鉴权头按上游体系分组：`openai` 与 `responses` 用 `Authorization: Bearer`，
`anthropic` 用 `x-api-key` + `anthropic-version`。

示例（令牌在"模型聚合"页生成）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lam-myprovider/gpt-x","messages":[{"role":"user","content":"hi"}]}'
```

`model` 用聚合别名时只路由到该供应商；不认识的 `lam-` 别名会返回 400，**不会**回落到默认供应商（避免用错额度、答错模型）。

错误响应统一为 `{ "error": { "code", "message", "messageKey", "details"? } }`。
`message` 按请求语言渲染（租户设置 > `Accept-Language` > 中文），
要判断具体原因请用**不随语言变化**的 `messageKey`（如 `gateway.auth.invalidToken`），
不要匹配译文。详见 [docs/api.md](./docs/api.md)。

## 环境变量

见 [.env.example](.env.example)。常用的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；对外暴露请配 HTTPS 反代。Windows 桌面版默认只监听回环；托盘「允许局域网访问」会切到 `0.0.0.0` 并重启 sidecar |
| `PORT` | `8787` | 监听端口。Windows 桌面版固定 8787，被占用时不会自动换端口 |
| `PUBLIC_BASE_URL` | 由 HOST:PORT 推导 | 写进 Agent 配置的网关地址，反代/容器部署必须显式设置。Windows 桌面版固定为 `http://127.0.0.1:8787`，让本机 Agent 走回环；只有其它设备的 Agent 也要经这台网关时才改 |
| `TRUST_PROXY` | 关闭 | 放在 HTTPS 反代之后设为 `1`，才采信 `X-Forwarded-Proto`（且只信任回环来源）。**直接局域网 HTTP 不要开**：没有反代可信任，伪造的头会绕过同步的 HTTPS 检查 |
| `SYNC_ALLOW_INSECURE` | 关闭 | 设为 `1` 允许同步快照与拉取走明文 HTTP。仅用于可信局域网或隧道，**两端都要设**；快照里是上游 Key 明文 |
| `DATA_DIR` | `data` | 数据目录；相对路径按进程 cwd 解析（npm 脚本下即 `server/data`），想固定在仓库根可设 `../data`。Windows 桌面版用 `%APPDATA%\llmapi-manager\data` |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次创建账号时使用 |
| `ADMIN_PASSWORD` | 无 | 无交互部署（Docker/systemd）的应急通道：设置后跳过网页初始化，直接以此口令建号。Windows 桌面版不使用它——首次启动会自动捕获初始化令牌 |
| `DATA_ENCRYPTION_KEY` | 无 | 供应商 Key 与网关令牌的落盘加密密钥；不设则为明文并告警。Windows 桌面版会生成到 `%APPDATA%\llmapi-manager\desktop.env`（当前用户 ACL）。同步跨机传的是明文 Key，因为该密钥每台机器独立 |
| `LOG_LANGUAGE` | `zh` | 运行日志、启动横幅与 CLI 输出的语言（`zh` / `en`）。与界面语言分开：接口跟随请求语言，日志跟随这个设置 |
| `LOG_DIR` | 仓库根 `log/` | 运行日志目录；设为 `off` 只输出到控制台。Windows 桌面版用 `%APPDATA%\llmapi-manager\log` |
| `LOG_MAX_BYTES` / `LOG_MAX_FILES` | `5242880` / `5` | 单文件滚动阈值与保留的历史文件个数 |
| `AGENT_HOME_DIR` | OS 家目录 | Agent 配置根目录（其下 `.codex` / `.claude`）。Windows 桌面版以当前用户运行，默认家目录就是对的，无需为服务账号覆盖 |
| `CODEX_BIN` | PATH 上的 `codex` | `codex` 可执行文件的绝对路径。桌面 App 从资源管理器启动时可能拿不到 shell PATH，结束 Codex 进程找不到 `codex` 时填它 |

## 数据与安全边界

```
data/                                  # 实际落点由 DATA_DIR 决定（npm 脚本下默认 server/data；
                                       # Windows 桌面版为 %APPDATA%\llmapi-manager\data）
├── identity.json                       # 租户与账号（口令只存 scrypt 哈希）
├── instance.json                       # 会话签名密钥（可重建；也是同步快照的 masterId 来源）
├── setup.json                          # 首次初始化令牌（哈希），完成后清空
└── tenants/<tenantId>/
    ├── providers.json                  # 供应商（API Key 经 AES-256-GCM 加密）
    ├── settings.json                   # 默认模型、网关令牌（只存哈希 + 密文）、Codex 开关
    ├── agents.json                     # 下发快照（含 appliedBy）
    ├── sync-conflicts.json             # 待仲裁的同步冲突（凭据已打码）
    ├── sync-state.json                 # 三方合并的内容哈希基线（不含原文、无接口）
    ├── requests.jsonl                  # 网关请求日志
    └── （备份不再放数据目录，见下）
```

- **会写你的家目录**：只有点击"应用配置"时才改写 `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.codex/llmapi-model-catalog.json`（模型目录，整份生成）、`~/.claude/settings.json`；写入前在同目录生成 `*.bak-<时间戳>` 备份（如 `~/.codex/config.toml.bak-2026-10-23T14-00-00-000Z`），改坏了可直接找回，不依赖本服务是否还在运行。
- **会结束你的进程**：Codex 只在启动时读配置与模型目录，所以「退出 Codex 进程」按钮会执行 `codex app-server daemon stop`，再结束 `codex` / `codex exec` 进程（POSIX 先 `SIGTERM`、必要时 `SIGKILL`；Windows 用 `taskkill /PID /T /F`）。匹配规则保守，不碰 `mycodex`、编辑器插件或 `codex --version` 这类一次性命令。自动结束没覆盖到时按平台手动清理：POSIX 用 `pkill -9 -f codex`，Windows 用任务管理器结束 `codex.exe` 或 `taskkill /F /IM codex.exe`。Windows 进程表探测失败会写进 `warnings`，不会静默当成「没有进程」。
- **只拥有最小字段集**：Codex 只改 `model_provider`、`model`、`model_catalog_json`、`web_search` 与 `[model_providers.llmapi]` 段；Claude Code 只改 `env` 下三个键。其余内容（MCP、钩子、权限、其他 provider）原样保留。
- **还原是保守的**：只移除"当前值仍等于我们写入值"的键；被你手改过的键保留并作为冲突提示。由我们创建、且还原后为空壳的文件会直接删除。
- **凭据**：口令用 scrypt；网关令牌只存哈希（下发 Agent 时另有密文副本，任何接口都不返回）；供应商 Key 列表接口只返回首 3 位 + 尾 4 位。
- **同步会传明文 Key**：快照里是解码后的上游 Key，因为 `enc:v1:` 绑定本机 `DATA_ENCRYPTION_KEY`。所以导出接口默认拒绝非回环的明文 HTTP（除非显式 `SYNC_ALLOW_INSECURE=1`），响应带 `cache-control: no-store`，日志也绝不记 body。`sync-state.json` 只存内容哈希（含明文 Key 的哈希——是指纹，不能还原成 Key）。角色设成 `peer` 时**两端都暴露快照接口**，任意一端的凭据就足以读走全部 Key。
- **明文模式**：不设置 `DATA_ENCRYPTION_KEY` 时凭据以明文保存，`/api/health` 会持续告警，仅建议单机使用。

## 为多用户预留的设计

当前是单人使用（一个 `t_default` 租户、一个 `owner` 账号），但结构上已经为多用户/租户隔离与权限控制留好接口：

- **身份三层**：`Tenant` / `User(role)` / `Principal`（请求上下文）。会话与网关令牌都解析成 `Principal`，没有"匿名默认租户"的兜底。
- **数据分区**：所有租户数据在 `data/tenants/<tenantId>/`，仓储只能通过 `forTenant(principal)` 获取，路由层不拼路径。
- **权限集中裁决**：`server/src/domain/permissions.ts` 定义 `Permission` 与角色映射；每条 `/api` 路由经 `defineRoute` 显式声明所需权限，`policy.ts` 统一判定，漏声明会在启动自检时失败。
- **路径可替换**：Agent 文件路径由 `AgentPathResolver` 按 `{tenantId, userId}` 解析，`registerTenantWorkspace()` 已预留为每租户独立工作区的入口。
- **可审计**：日志与 Agent 下发快照都带 `tenantId` / `appliedBy`。

接入多用户时，需要新增的是用户/租户开通、邀请与登录方式，以及把 `app.ts` 里写死的 `DEFAULT_TENANT_ID` 换成从 `Principal` 取租户——领域模型与接口契约不用动。

## 已知限制

- 协议默认严格匹配：`/v1/chat/completions` 要 `openai`、`/v1/messages` 要 `anthropic`、
  `/v1/responses` 要 `responses`，不匹配明确返回 501、不静默转发。
  例外有两个：`/v1/responses → openai` 在开启「跨协议转发」（或协议不匹配时网关自动开启）后，
  由网关双向转换请求、响应与流式事件（托管工具如 `web_search` 没有 Chat 等价物会被丢弃）；
  以及两条生图路径，它们同时接受 `openai` 与 `responses` 供应商，且**从不**做协议转换。
  生图响应的 `url → b64_json` 内联是网关唯一会改写成功响应体的地方。
- **同步是手动的、由接收方发起**：只有点「立即同步」才拉一次，没有定时任务、没有推送。角色设成 `peer` 要求两端能互相访问；NAT/防火墙只打通一个方向时，实际只能做单向。两端应使用同一版本；旧版对端仍按旧的「时间戳 + 内容」两方判定，可能把本可收敛的情况报成冲突。
- **拉取令牌不落盘**：每次拉取都从请求体读取，不写进 `settings.json`；重启后要重新填。
- **删除不传播**：一台机器上删掉的供应商，另一台上仍然存在。需要在两端各删一次；合并永远不删除「对端没有」的本地记录。
- **`peer` 双端暴露快照**：两端都提供可导出全部上游 Key 明文的接口，任意一端的 `sync:read` 凭据（或账号）都能拿走全部 Key。给对端用单独的、设了 `expiresAt` 的令牌，用完吊销；只在你愿意互相暴露的机器上启用 `peer`。
- 不做计费、配额、多用户 UI、MCP/Skills/会话管理。Windows 的正式发行形态是 Tauri 2 桌面
  App；不提供 macOS/Linux 桌面打包，Linux 继续用 `npm start` 服务模式。Windows GUI 与
  安装器需在真实 Windows 上验收，CI 只构建并冒烟。
- **日志语言与接口语言是两套设置**：接口响应跟随请求语言（租户设置 > `Accept-Language`），
  而运行日志、启动横幅与 CLI 输出跟随 `LOG_LANGUAGE`（默认中文）。日志的受众是部署者，
  跟着某个客户端漂移会让同一故障在不同请求下长得不一样、无法 grep。
- 存储是 JSON 文件 + 原子写，适合单机自托管；高并发或多实例需要换 SQLite/Postgres 与共享状态。
- 上游能力以"OpenAI / Anthropic 兼容"为前提（OpenAI 体系含 Chat Completions 与 Responses
  两种 API 形态）；非兼容的私有协议需要新增适配层。

## 目录结构

```
server/
  src/
    app.ts                Fastify 装配、错误处理、SPA 托管
    index.ts              启动入口（bootstrap + listen）
    config.ts  logger.ts  resilience.ts  context.ts  bootstrap.ts
    i18n/                 服务端文案：语言解析（租户设置 → Accept-Language → 中文）、translate、locales/{zh,en}/ 字典
    domain/               provider、aliases、identity、permissions、agent、settings、modelCatalog、requestLog
    store/                jsonFile（原子写/损坏隔离）、paths、tenantScope、identityRepo
    auth/                 password、session、principal、policy、guard
    crypto/               secretCodec（AES-256-GCM）
    gateway/              token、auth、forward
    services/             providers、connectivity、requestLog、setup、sync（三方合并）
    agents/               registry（路径解析）、patch（JSON/TOML 保值补丁）、toml、processes、service
    routes/               auth、providers、models、logs、agents、gateway、sync
  test/                   单元测试 + 端到端冒烟（含假上游）
web/
  src/pages/              Login / Setup / Layout / Overview / Providers / Models / Agents / Settings
  src/components/         ui、ProviderForm、CopyButton
  src/lib/                api、auth、useAsync、types、labels（枚举文案键）
  src/i18n/               i18next 初始化、语言探测、日期格式化、locales/{zh,en}/ 字典
  test/                   页面装配测试 + 字典契约 + 硬编码扫描（jsdom）
scripts/windows/          PowerShell 桌面打包 + 旧服务迁移脚本（需在 Windows 上运行）
src-tauri/                Tauri 2 桌面壳：窗口、托盘、sidecar 生命周期、NSIS 配置
desktop/                  Tauri 窗口使用的桌面加载页
.github/workflows/        CI：Ubuntu + Windows 测试矩阵、Windows 桌面构建/冒烟 job
```

## 致谢

本项目的设计参考了 [cc-switch](https://github.com/farion1231/cc-switch) 与
[new-api](https://github.com/QuantumNous/new-api) 两个开源项目：

- **cc-switch**：把配置写进本机 Agent、且只拥有最小字段集（不改用户其余配置）的做法；
- **new-api**：多渠道网关 + 按优先级选路的思路。

代码为独立实现，未复制两者源码，也未沿用其架构。

## 许可

[MIT](LICENSE) © 2026 LinWang
