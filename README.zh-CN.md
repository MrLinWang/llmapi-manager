# LLM API Manager

[English](./README.md) | **简体中文**

自托管的 LLM API 控制台：在一个网页里维护各家 LLM API，聚合成统一模型别名，
再把聚合结果下发到你本机的 Agent（首期支持 Codex CLI 与 Claude Code）。

设计参考了 `cc-switch`（供应商切换 + 把配置写进 Agent、且只拥有最小字段集）与
`new-api`（多渠道网关 + 优先级选路），但代码是独立实现的，未复制两者源码。

## 能力范围

- **供应商管理**：三种协议 —— OpenAI 兼容（Chat Completions）/ OpenAI 兼容（Responses）/ Anthropic 兼容（Messages）；API Key 加密落盘、列表脱敏、优先级排序、启用开关、连通性测试（请求上游 `/models`）、按表单当前值一键拉取上游模型列表并勾选启用。
- **模型聚合**：把启用供应商的模型发布为 `lam-<供应商key>/<模型>` 别名；另可配置"默认供应商 + 默认模型"承接不带别名的请求。
- **统一网关**：`/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/responses`；支持 SSE 流式透传；默认路径失败时按优先级回退一次。
- **Agent 下发**：Codex CLI（`~/.codex/config.toml` + `auth.json` + `llmapi-model-catalog.json`，只接受 `responses` 供应商，`wire_api` 固定 `responses`）与 Claude Code（`~/.claude/settings.json`，需要 `anthropic`）；支持预览、应用、还原、结束 Codex 进程，写前备份，只改自己拥有的键。
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

其他命令：`npm run typecheck`、`npm test`。

## 文档

完整文档在 [docs/](./docs/README.md)：

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](./docs/architecture.md) | 架构、分层、租户与身份、数据流 |
| [docs/api.md](./docs/api.md) | 接口参考（路径、权限、示例、错误码） |
| [docs/gateway.md](./docs/gateway.md) | 别名、选路、协议匹配、流式转发 |
| [docs/agents.md](./docs/agents.md) | Codex / Claude Code 配置下发细节 |
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
| GET | `/api/logs`、`/api/stats` | 请求日志与统计 |

网关接口（需网关令牌，`Authorization: Bearer <token>` 或 `x-api-key`）：

```
GET  /v1/models
POST /v1/chat/completions    # 需要 apiType=openai 的上游（OpenAI 兼容 · Chat Completions）
POST /v1/messages            # 需要 apiType=anthropic 的上游（Anthropic 兼容 · Messages）
POST /v1/responses           # 需要 apiType=responses 的上游（OpenAI 兼容 · Responses）
```

三条 POST 路径都是**严格匹配**：协议不符返回 501，不会退化成正向直通。
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
| `HOST` | `127.0.0.1` | 监听地址；对外暴露请配 HTTPS 反代 |
| `PORT` | `8787` | 监听端口 |
| `PUBLIC_BASE_URL` | 由 HOST:PORT 推导 | 写进 Agent 配置的网关地址，反代/容器部署必须显式设置 |
| `DATA_DIR` | `data` | 数据目录；相对路径按进程 cwd 解析（npm 脚本下即 `server/data`），想固定在仓库根可设 `../data` |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次创建账号时使用 |
| `ADMIN_PASSWORD` | 无 | 应急通道：设置后跳过网页初始化，直接以此口令建号（适合 Docker/systemd） |
| `DATA_ENCRYPTION_KEY` | 无 | 供应商 Key 与网关令牌的落盘加密密钥；不设则为明文并告警 |
| `LOG_LANGUAGE` | `zh` | 运行日志、启动横幅与 CLI 输出的语言（`zh` / `en`）。与界面语言分开：接口跟随请求语言，日志跟随这个设置 |
| `LOG_DIR` | 仓库根 `log/` | 运行日志目录；设为 `off` 只输出到控制台 |
| `LOG_MAX_BYTES` / `LOG_MAX_FILES` | `5242880` / `5` | 单文件滚动阈值与保留的历史文件个数 |
| `AGENT_HOME_DIR` | OS 家目录 | Agent 配置根目录（其下 `.codex` / `.claude`） |

## 数据与安全边界

```
data/                                  # 实际落点由 DATA_DIR 决定，npm 脚本下默认 server/data
├── identity.json                       # 租户与账号（口令只存 scrypt 哈希）
├── instance.json                       # 会话签名密钥（可重建）
├── setup.json                          # 首次初始化令牌（哈希），完成后清空
└── tenants/<tenantId>/
    ├── providers.json                  # 供应商（API Key 经 AES-256-GCM 加密）
    ├── settings.json                   # 默认模型、网关令牌（只存哈希 + 密文）、Codex 开关
    ├── agents.json                     # 下发快照（含 appliedBy）
    ├── requests.jsonl                  # 网关请求日志
    └── （备份不再放数据目录，见下）
```

- **会写你的家目录**：只有点击"应用配置"时才改写 `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.codex/llmapi-model-catalog.json`（模型目录，整份生成）、`~/.claude/settings.json`；写入前在同目录生成 `*.bak-<时间戳>` 备份（如 `~/.codex/config.toml.bak-2026-10-23T14-00-00-000Z`），改坏了可直接找回，不依赖本服务是否还在运行。
- **会结束你的进程**：Codex 只在启动时读配置与模型目录，所以「退出 Codex 进程」按钮会执行 `codex app-server daemon stop` 并对 `codex` / `codex exec` 进程发信号（先 `SIGTERM`、必要时 `SIGKILL`）。匹配规则保守，不碰 `mycodex`、编辑器插件或 `codex --version` 这类一次性命令。操作结果提示里固定附上兜底命令 `pkill -9 -f codex`，自动结束没覆盖到时可以手动清理。
- **只拥有最小字段集**：Codex 只改 `model_provider`、`model`、`model_catalog_json`、`web_search` 与 `[model_providers.llmapi]` 段；Claude Code 只改 `env` 下三个键。其余内容（MCP、钩子、权限、其他 provider）原样保留。
- **还原是保守的**：只移除"当前值仍等于我们写入值"的键；被你手改过的键保留并作为冲突提示。由我们创建、且还原后为空壳的文件会直接删除。
- **凭据**：口令用 scrypt；网关令牌只存哈希（下发 Agent 时另有密文副本，任何接口都不返回）；供应商 Key 列表接口只返回首 3 位 + 尾 4 位。
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
  唯一例外是 `/v1/responses → openai`：开启「跨协议转发」（或协议不匹配时网关自动开启）后，
  由网关双向转换请求、响应与流式事件。托管工具（如 `web_search`）没有 Chat 等价物会被丢弃。
- 不做计费、配额、多用户 UI、MCP/Skills/会话管理、桌面打包。
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
    services/             providers、connectivity、requestLog、setup
    agents/               registry（路径解析）、patch（JSON/TOML 保值补丁）、toml、processes、service
    routes/               auth、providers、models、logs、agents、gateway
  test/                   单元测试 + 端到端冒烟（含假上游）
web/
  src/pages/              Login / Setup / Layout / Overview / Providers / Models / Agents / Settings
  src/components/         ui、ProviderForm、CopyButton
  src/lib/                api、auth、useAsync、types、labels（枚举文案键）
  src/i18n/               i18next 初始化、语言探测、日期格式化、locales/{zh,en}/ 字典
  test/                   页面装配测试 + 字典契约 + 硬编码扫描（jsdom）
```

## 致谢

本项目的设计参考了 [cc-switch](https://github.com/farion1231/cc-switch) 与
[new-api](https://github.com/QuantumNous/new-api) 两个开源项目：

- **cc-switch**：把配置写进本机 Agent、且只拥有最小字段集（不改用户其余配置）的做法；
- **new-api**：多渠道网关 + 按优先级选路的思路。

代码为独立实现，未复制两者源码，也未沿用其架构。

## 许可

[MIT](LICENSE) © 2026 LinWang
