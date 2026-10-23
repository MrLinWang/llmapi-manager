# 架构

## 定位

LLM API Manager 是一个单进程自托管服务，同时承担三件事：

1. **管理面**：`/api/*`，网页控制台用它维护供应商、聚合配置与 Agent 下发。
2. **数据面**：`/v1/*`，OpenAI / Anthropic 兼容网关（三种上游协议：`openai`、`responses`、
   `anthropic`），把请求转发到聚合后的上游。
3. **静态资源**：生产模式下托管 `web/dist`，非接口路径回落到 `index.html`（SPA）。

它解决的问题是：一个人有多家 LLM API，想让不同 Agent（Codex、Claude Code）都用上"聚合后的模型列表"，
而不必在每台客户端上反复改配置。参考了 `cc-switch`（把配置写进 Agent，且只拥有最小字段集）
与 `new-api`（多渠道网关 + 优先级选路）的思路，但代码独立实现。

## 进程与模块

```
浏览器 ──HTTP──┐
               ├─► Fastify (server/src/app.ts)
Agent ──HTTP──┘      │
                     ├─ /api/*  ─► registerApiGuard ─► routes/* ─► services/* ─► store/*
                     ├─ /v1/*   ─► gateway/auth       ─► gateway/forward ─► 上游供应商
                     └─ 其它    ─► web/dist（SPA fallback）
```

`AppContext`（[server/src/context.ts](../server/src/context.ts)）是唯一的依赖容器：

| 字段 | 作用 |
| --- | --- |
| `config` | 环境变量解析结果（端口、数据目录、密钥等） |
| `logger` | 分级日志，按 key 名与正则打码 |
| `paths` | `StorePaths`，所有落盘路径的唯一来源 |
| `identity` | `data/identity.json` 的仓储（租户与账号） |
| `store` | `forTenant(tenantId)` 返回租户作用域仓储集合 |
| `secrets` | `SecretCodec`，凭据编解码 |

启动顺序（[server/src/index.ts](../server/src/index.ts)）：

1. `loadConfig()` 读 `.env` 与环境变量，创建数据目录，解析/生成会话密钥。
2. `createContext()` 装配上述容器。
3. `bootstrapIdentity()` 幂等创建 `t_default` 租户并补齐租户数据文件。**默认不建账号**：
   生成一次性初始化令牌（此时只返回给调用方、尚未打印），由用户在设置页自设用户名与口令
   （账号 id 固定为 `u_owner`）；仅在设置了 `ADMIN_PASSWORD` 时直接建号，用户名取 `ADMIN_USERNAME`。
4. `buildApp()` 注册插件、鉴权钩子、路由、静态资源。
5. `listen()`，打印控制台地址、网关地址；若本次启动生成了初始化令牌，紧接着把它打印到**控制台**
   （只这一处，不写入日志文件）。

## 分层约定

| 层 | 位置 | 允许做什么 | 不允许做什么 |
| --- | --- | --- | --- |
| 路由 | `server/src/routes/` | 解析参数、调用服务、组装响应 | 拼文件路径、写权限判断、直接读写存储 |
| 服务 | `server/src/services/`、`agents/service.ts` | 业务规则编排、调用仓储 | 处理 HTTP 细节 |
| Agent 适配 | `server/src/agents/`（`registry` / `patch` / `toml` / `processes`） | 路径解析、JSON/TOML 保值补丁、进程探测与信号 | 权限判断、HTTP 细节 |
| 领域 | `server/src/domain/` | 纯类型与纯函数（别名、脱敏、providerKey、Codex 模型目录） | IO、依赖 Fastify |
| 存储 | `server/src/store/` | 原子读写、租户作用域、损坏隔离 | 业务判断 |
| 网关 | `server/src/gateway/` | 令牌、鉴权、上游转发 | 管理面权限逻辑 |

## 租户与身份

三层抽象（[domain/identity.ts](../server/src/domain/identity.ts)）：

```
Tenant    { id, name, status, createdAt }      // 数据隔离边界
User      { id, tenantId, username, role,      // role ∈ owner | admin | member
            passwordHash, authVersion, status }
Principal { userId, tenantId, role, via }      // 一次请求的身份载体
```

`Principal` 有两个来源：

- **会话 Cookie**（`via: 'session'`）：`auth/principal.ts` 校验 HMAC 签名，再回表核对
  `status`、`tenantId`、`role`、`authVersion`。任一项不一致即视为未登录 —— 改口令或停用账号能立刻踢掉旧会话。
- **网关令牌**（`via: 'gateway-token'`）：`gateway/auth.ts` 按租户遍历比对令牌哈希，命中后给 `role: 'member'`。

本期只有一个租户。`app.ts` 里用 `DEFAULT_TENANT_ID` 取仓储；接入多租户时改为从 `Principal` 取即可，
领域模型与接口契约不变。

## 数据流：一次网关请求

```
POST /v1/chat/completions
  │
  ├─ gateway/auth.ts        解析 Bearer / x-api-key → Principal(role=member)
  ├─ 取租户仓储             ctx.store.forTenant(principal.tenantId)
  ├─ domain/aliases.ts      解析 model：
  │                            lam-<key>/<model> → 明确供应商（失败即 400，不回落）
  │                            其它              → 默认供应商 + 默认模型
  ├─ gateway/forward.ts     先校验协议：requiredApiType(path) 与供应商 apiType 不符即 501
  │                         （必须在发上游请求前拒绝，否则客户端只会看到上游的参数错误）
  ├─ gateway/forward.ts     拼上游 URL、注入上游 Key、转发 body
  │                            openai / responses → Authorization: Bearer
  │                            anthropic         → x-api-key + anthropic-version
  │                            非流式：原样回传响应体
  │                            流式  ：逐块透传 SSE，客户端断开即 abort 上游
  ├─ 失败处理               未带别名且主供应商 5xx → 按优先级回退 1 次（响应头 x-llmapi-fallback: 1）
  └─ services/requestLog.ts 追加到 data/tenants/<id>/requests.jsonl（失败不影响响应）
```

细节见 [gateway.md](./gateway.md)。

## 数据流：一次 Agent 下发

```
POST /api/agents/codex/apply
  │
  ├─ registerApiGuard       会话鉴权 + 权限 agents:apply
  ├─ agents/service.ts      选供应商（codex → 只接受 responses，claude-code → anthropic；
  │                         没有匹配协议的启用供应商就 400，不回落）
  │                         取网关令牌明文（从密文解密，仅进程内使用）
  │                         生成目标键值：model_provider / model / model_catalog_json /
  │                         web_search / [model_providers.llmapi] 表内 5 个键，
  │                         其中 wire_api 固定 "responses"
  ├─ domain/modelCatalog.ts  用当前聚合别名整份生成 Codex 模型目录（catalog 角色）
  ├─ agents/registry.ts      AgentPathResolver 解析物理路径（本期落到 OS 家目录）
  ├─ agents/patch.ts         读现有文件 → 备份（若存在）→ 就地改写 / 整体覆盖 → 原子替换
  └─ agents.json            记录快照：写入的键值 + appliedBy + created 标记

改完配置后可选 POST /api/agents/codex/stop-processes：
  agents/service.ts → agents/processes.ts（daemon stop + 按进程表精确 SIGTERM）
```

还原走同一套规则的反向操作，只撤销"值仍等于我们写入值"的键；由我们生成的模型目录文件按 `created` 删除。
细节见 [agents.md](./agents.md)。

## 存储布局

```
data/                                # 实际落点由 DATA_DIR 决定，默认 server/data
├── identity.json                     租户与账号（口令 scrypt 哈希）
├── instance.json                     会话签名密钥（自动生成，可重建）
├── setup.json                        首次初始化状态（init token 哈希，完成后清空）
└── tenants/<tenantId>/
    ├── providers.json                供应商（apiKey 为密文）
    ├── settings.json                 默认供应商/模型、网关令牌（哈希 + 密文）、Codex 行为开关
    ├── agents.json                   下发快照
    ├── requests.jsonl                请求日志（追加写）
    └── backups/<agentId>/<时间戳>-<文件名>
```

所有 JSON 写入都是"临时文件 + rename"，文件权限 0600，外层信封为 `{ schemaVersion, data }`。
读到损坏或版本更高的文件时，改名为 `*.corrupt-<时间戳>` 并以默认值启动，同时把告警挂到 `/api/health`。

运行日志是另一条独立的落盘路径，**不在 `DATA_DIR` 下**：

```
log/                                 仓库根，已 gitignore（LOG_DIR 可改）
├── app.log                          当前写入（0600）
└── app.<n>.log                      按大小滚动的历史，最多 LOG_MAX_FILES 个
```

区分的理由：`data/` 是租户业务数据，可以整体迁移/备份；`log/` 是运行产物，
迁移数据目录时不该被一起带走。日志器与业务存储也不共用代码（同步追加写 vs 原子写）。

## 关键设计取舍

| 取舍 | 原因 |
| --- | --- |
| JSON 文件而非数据库 | 单机自托管、零外部依赖；Repository 接口隔离，替换成本可控 |
| 别名严格失败不回落 | 回落会用别家额度、答错模型，且调用方无感知 |
| 单进程同时托管前端 | 部署简单；开发期 Vite 代理保持热更新 |
| 不做协议转换 | 三条路径与上游协议严格一一对应；不匹配明确 501，不静默转发、也不放宽成直通 |
| 只回退一次 | 优先保证可预测性；多层重试需要熔断与配额才能安全 |
| 权限声明与路由注册绑定 | 漏声明会启动失败，避免"新路由默认放开"这类事故 |
| Agent 路径可解析 | 现在写家目录，将来可切到每租户工作区而不动上层 |
