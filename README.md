# LLM API Manager

自托管的 LLM API 控制台：在一个网页里维护各家 LLM API，聚合成统一模型别名，
再把聚合结果下发到你本机的 Agent（首期支持 Codex CLI 与 Claude Code）。

设计参考了 `cc-switch`（供应商切换 + 把配置写进 Agent、且只拥有最小字段集）与
`new-api`（多渠道网关 + 优先级选路），但代码是独立实现的，未复制两者源码。

## 能力范围

- **供应商管理**：OpenAI / Anthropic 兼容上游，API Key 加密落盘、列表脱敏、优先级排序、启用开关、连通性测试（请求上游 `/models`）。
- **模型聚合**：把启用供应商的模型发布为 `lmm-<供应商key>/<模型>` 别名；另可配置"默认供应商 + 默认模型"承接不带别名的请求。
- **统一网关**：`/v1/models`、`/v1/chat/completions`、`/v1/messages`、`/v1/responses`；支持 SSE 流式透传；默认路径失败时按优先级回退一次。
- **Agent 下发**：Codex CLI（`~/.codex/config.toml` + `auth.json`）与 Claude Code（`~/.claude/settings.json`）；支持预览、应用、还原，写前备份，只改自己拥有的键。
- **可观测**：请求日志与今日统计（请求数、成功率、平均耗时）。

## 快速开始

```bash
npm install
cp .env.example .env    # 按需修改
npm run dev             # 服务端 :8787 + 前端 :5173
```

打开 http://localhost:5173 ，用控制台打印的初始口令登录。

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
| GET | `/api/auth/me` | 当前身份与权限 |
| POST | `/api/auth/password` | 修改口令（会使旧会话失效） |
| GET/POST | `/api/providers` | 供应商列表 / 新增 |
| PUT/DELETE | `/api/providers/:id` | 更新 / 删除 |
| PATCH | `/api/providers/:id/enabled` | 启用开关 |
| POST | `/api/providers/:id/test` | 连通性测试 |
| PUT | `/api/providers/order` | 调整优先级顺序 |
| GET | `/api/models` | 聚合别名、默认模型、网关地址与令牌（脱敏） |
| PUT | `/api/settings/default` | 设置默认供应商与模型 |
| POST | `/api/gateway/token` | 生成/重置网关令牌（明文只返回一次） |
| GET | `/api/agents` | Agent 列表与接管状态 |
| POST | `/api/agents/:id/preview` \| `apply` \| `revert` | 预览 / 应用 / 还原 |
| GET | `/api/logs`、`/api/stats` | 请求日志与统计 |

网关接口（需网关令牌，`Authorization: Bearer <token>` 或 `x-api-key`）：

```
GET  /v1/models
POST /v1/chat/completions    # 需要 apiType=openai 的上游
POST /v1/messages            # 需要 apiType=anthropic 的上游
POST /v1/responses
```

示例（令牌在"模型聚合"页生成）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $LLMAPI_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"lmm-myprovider/gpt-x","messages":[{"role":"user","content":"hi"}]}'
```

`model` 用聚合别名时只路由到该供应商；不认识的 `lmm-` 别名会返回 400，**不会**回落到默认供应商（避免用错额度、答错模型）。

## 环境变量

见 [.env.example](.env.example)。常用的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；对外暴露请配 HTTPS 反代 |
| `PORT` | `8787` | 监听端口 |
| `PUBLIC_BASE_URL` | 由 HOST:PORT 推导 | 写进 Agent 配置的网关地址，反代/容器部署必须显式设置 |
| `DATA_DIR` | `data` | 数据目录 |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次创建账号时使用 |
| `ADMIN_PASSWORD` | 随机 | 初始管理员口令，仅首次创建账号时使用 |
| `DATA_ENCRYPTION_KEY` | 无 | 供应商 Key 与网关令牌的落盘加密密钥；不设则为明文并告警 |
| `AGENT_HOME_DIR` | OS 家目录 | Agent 配置根目录（其下 `.codex` / `.claude`） |

## 数据与安全边界

```
data/
├── identity.json                       # 租户与账号（口令只存 scrypt 哈希）
├── instance.json                       # 会话签名密钥（可重建）
└── tenants/<tenantId>/
    ├── providers.json                  # 供应商（API Key 经 AES-256-GCM 加密）
    ├── settings.json                   # 默认模型、网关令牌（只存哈希 + 密文）
    ├── agents.json                     # 下发快照（含 appliedBy）
    ├── requests.jsonl                  # 网关请求日志
    └── backups/<agent>/<时间戳>-<文件名>
```

- **会写你的家目录**：只有点击"应用配置"时才改写 `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.claude/settings.json`；写入前备份到 `data/tenants/<id>/backups/`。
- **只拥有最小字段集**：Codex 只改 `model_provider`、`model` 与 `[model_providers.llmapi]` 段；Claude Code 只改 `env` 下三个键。其余内容（MCP、钩子、权限、其他 provider）原样保留。
- **还原是保守的**：只移除"当前值仍等于我们写入值"的键；被你手改过的键保留并作为冲突提示。由我们创建、且还原后为空壳的文件会直接删除。
- **凭据**：口令用 scrypt；网关令牌只存哈希（下发 Agent 时另有密文副本，任何接口都不返回）；供应商 Key 列表接口只返回首 3 位 + 尾 4 位。
- **明文模式**：不设置 `DATA_ENCRYPTION_KEY` 时凭据以明文保存，`/api/health` 会持续告警，仅建议单机使用。

## 为多用户预留的设计

当前是单人使用（一个 `t_default` 租户、一个 `admin` 账号），但结构上已经为多用户/租户隔离与权限控制留好接口：

- **身份三层**：`Tenant` / `User(role)` / `Principal`（请求上下文）。会话与网关令牌都解析成 `Principal`，没有"匿名默认租户"的兜底。
- **数据分区**：所有租户数据在 `data/tenants/<tenantId>/`，仓储只能通过 `forTenant(principal)` 获取，路由层不拼路径。
- **权限集中裁决**：`server/src/domain/permissions.ts` 定义 `Permission` 与角色映射；每条 `/api` 路由经 `defineRoute` 显式声明所需权限，`policy.ts` 统一判定，漏声明会在启动自检时失败。
- **路径可替换**：Agent 文件路径由 `AgentPathResolver` 按 `{tenantId, userId}` 解析，`registerTenantWorkspace()` 已预留为每租户独立工作区的入口。
- **可审计**：日志与 Agent 下发快照都带 `tenantId` / `appliedBy`。

接入多用户时，需要新增的是用户/租户开通、邀请与登录方式，以及把 `app.ts` 里写死的 `DEFAULT_TENANT_ID` 换成从 `Principal` 取租户——领域模型与接口契约不用动。

## 已知限制

- 不做协议转换：`/v1/messages` 打到 `openai` 供应商会明确返回 501，不会静默转发。
- 不做计费、配额、多用户 UI、MCP/Skills/会话管理、桌面打包。
- 存储是 JSON 文件 + 原子写，适合单机自托管；高并发或多实例需要换 SQLite/Postgres 与共享状态。
- 上游能力以"OpenAI / Anthropic 兼容"为前提；非兼容的私有协议需要新增适配层。

## 目录结构

```
server/
  src/
    app.ts                Fastify 装配、错误处理、SPA 托管
    index.ts              启动入口（bootstrap + listen）
    config.ts  logger.ts  resilience.ts  context.ts  bootstrap.ts
    domain/               provider、aliases、identity、permissions、agent、settings、requestLog
    store/                jsonFile（原子写/损坏隔离）、paths、tenantScope、identityRepo
    auth/                 password、session、principal、policy、guard
    crypto/               secretCodec（AES-256-GCM）
    gateway/              token、auth、forward
    services/             providers、connectivity、requestLog
    agents/               registry（路径解析）、patch（JSON/TOML 保值补丁）、toml、service
    routes/               auth、providers、models、logs、agents、gateway
  test/                   单元测试 + 端到端冒烟（含假上游）
web/
  src/pages/              Login / Layout / Overview / Providers / Models / Agents / Settings
  src/components/         ui、ProviderForm、CopyButton
  src/lib/                api、auth、useAsync、types
  test/                   页面装配测试（jsdom）
```

## 致谢

本项目的设计参考了 [cc-switch](https://github.com/farion1231/cc-switch) 与
[new-api](https://github.com/QuantumNous/new-api) 两个开源项目：

- **cc-switch**：把配置写进本机 Agent、且只拥有最小字段集（不改用户其余配置）的做法；
- **new-api**：多渠道网关 + 按优先级选路的思路。

代码为独立实现，未复制两者源码，也未沿用其架构。
