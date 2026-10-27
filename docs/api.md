# 接口参考

- 管理面：`/api/*`，用会话 Cookie 鉴权。所有错误响应统一为
  `{ "error": { "code": "...", "message": "...", "details"?: ... } }`。
- 数据面：`/v1/*`，用网关令牌鉴权，错误也复用同一结构（上游原始错误则原样透传）。

`code` 取值：`bad_request`(400) / `unauthorized`(401) / `forbidden`(403) / `not_found`(404) /
`conflict`(409) / `not_implemented`(501) / `upstream_error`(502) / `internal_error`(500)。

## 鉴权

### POST /api/auth/login

免鉴权。成功时下发 `llmapi_session` Cookie（HttpOnly、SameSite=Lax、7 天）。

```json
{ "username": "admin", "password": "..." }
```

失败一律返回 401 `用户名或口令不正确`，不区分"用户不存在"与"口令错误"。

## 首次初始化

未初始化时还没有任何账号，无法用会话鉴权，因此这两个接口都是 `public`；
真正的门禁是启动时打印的一次性初始化令牌。初始化完成后 `POST /api/setup` 一律返回 409。

### GET /api/setup/status

免鉴权。前端据此决定是否强制跳转设置页。

```json
{
  "needsSetup": true,
  "defaultUsername": "admin",
  "rules": { "minUsernameLength": 3, "maxUsernameLength": 32, "minPasswordLength": 8 },
  "failedAttempts": 0
}
```

`failedAttempts` 只在 `needsSetup: true` 时返回，用于发现令牌试探。
响应中**不含**令牌、令牌哈希或任何口令材料。

### POST /api/setup

免鉴权。成功返回 `201` 并创建 `role=owner` 的管理员账号，令牌立即作废。

```json
{ "token": "setup_…", "username": "alice", "password": "至少 8 位" }
```

| 情况 | 状态码 | 说明 |
| --- | --- | --- |
| 成功 | 201 | 返回 `{ user }`，不含口令 |
| 令牌错误 | 403 | `初始化令牌不正确`，并累加 `failedAttempts` |
| 已初始化 | 409 | 绝不覆盖已有管理员 |
| 口令过短 / 用户名非法 | 400 | 规则见 `setup/status` |

初始化成功后可以用新账号直接调 `POST /api/auth/login`。

### POST /api/auth/logout

免鉴权，清除 Cookie，返回 `{ "ok": true }`。

### GET /api/auth/me

需登录。返回身份与权限清单（前端据此决定显示哪些菜单）。

```json
{
  "user": { "id": "u_owner", "tenantId": "t_default", "role": "owner", "username": "admin" },
  "permissions": ["providers:read", "..."],
  "allPermissions": ["providers:read", "..."]
}
```

### POST /api/auth/password

需登录。校验旧口令 → 更新哈希 → `authVersion += 1`（所有既有会话立即失效，含当前会话）。

```json
{ "oldPassword": "...", "newPassword": "至少 8 位" }
```

## 供应商

供应商对象（返回形态，`apiKey` 已剔除）：

```json
{
  "id": "p_54be05e1",
  "name": "Mock OpenAI",
  "providerKey": "mock-openai",
  "apiType": "openai",
  "baseUrl": "https://api.example.com",
  "models": ["gpt-x", "gpt-x-mini"],
  "enabled": true,
  "priority": 0,
  "notes": null,
  "websiteUrl": null,
  "createdBy": "u_owner",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "apiKeyMasked": "sk-********cret",
  "apiKeyTail": "cret",
  "hasApiKey": true,
  "lastTest": { "at": "...", "ok": true, "latencyMs": 42, "status": 200, "models": ["gpt-x"] }
}
```

`providerKey` 由名称派生（小写、非字母数字转 `-`、截断 24 字符），租户内唯一，重名时追加 `-2`、`-3`。
它就是别名里的那一段，**改名会重新分配**，旧别名随之失效。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/providers` | `providers:read` | 按 `priority` 升序返回 |
| POST | `/api/providers` | `providers:write` | 201；同名返回 409 |
| PUT | `/api/providers/:id` | `providers:write` | 全量更新；`apiKey` 留空表示不修改 |
| PATCH | `/api/providers/:id/enabled` | `providers:write` | `{ "enabled": true }` |
| DELETE | `/api/providers/:id` | `providers:write` | 若删的是默认供应商，返回 `{ newDefaultProviderId }` |
| PUT | `/api/providers/order` | `providers:write` | `{ "ids": [...] }`，按数组顺序重排 `priority` |
| POST | `/api/providers/:id/test` | `providers:write` | 请求上游 `/models`，10s 超时；结果写回 `lastTest` |
| POST | `/api/providers/models` | `providers:write` | 按表单**临时值**拉取模型列表，不要求供应商已保存 |
| POST | `/api/providers/:id/default` | `providers:write` | 设为默认，可带 `{ "model": "..." }` |

创建/更新请求体：

```json
{
  "name": "Mock OpenAI",
  "apiType": "openai",
  "baseUrl": "https://api.example.com",
  "apiKey": "sk-...",
  "models": ["gpt-x", "gpt-x-mini"],
  "modelCapabilities": {
    "gpt-x": { "contextWindow": 400000, "maxOutputTokens": 64000 }
  },
  "enabled": true,
  "priority": 0,
  "notes": "可选",
  "websiteUrl": "可选"
}
```

约束：`name` 非空；`apiType` ∈ `openai | anthropic | responses`（非法值返回
400 `apiType 只能是 openai / anthropic / responses`）；`baseUrl` 必须是 http/https；
`models` 去重后保持输入顺序；`priority` 越小越靠前。

`modelCapabilities` 可省略，省略表示**保持已存值不变**（编辑态不必为了保留能力而重填）。
服务端在落盘前会裁剪：只保留仍出现在 `models` 里的模型，非正整数的值整条丢弃
（0 / 负数会被当成"窗口为 0"，比缺省更糟）。它的唯一用途是生成 Codex 目录里的
`context_window` / `max_output_tokens`，见 `docs/agents.md`。

`apiType` 不是展示字段，它决定这条上游只接哪条网关路径：

| `apiType` | 前端文案 | 只接 |
| --- | --- | --- |
| `openai` | OpenAI 兼容（Chat Completions） | `/v1/chat/completions` |
| `responses` | OpenAI 兼容（Responses） | `/v1/responses` |
| `anthropic` | Anthropic 兼容（Messages） | `/v1/messages` |

协议不符的请求由网关返回 501，供应商本身不会被调用。前端下拉顺序是
`openai` → `responses` → `anthropic`（`web/src/lib/labels.ts` 的 `API_TYPE_META`）。

连通性测试返回：

```json
{ "ok": true, "latencyMs": 42, "status": 200, "models": ["gpt-x", "gpt-x-mini"] }
{ "ok": false, "latencyMs": 10003, "error": "请求超时（10s）" }
```

测试失败不会抛 500，结果同时写回该供应商的 `lastTest`。

### POST /api/providers/models

权限 `providers:write`。按**表单里填的临时值**向上游拉取模型列表，
用于新增供应商时"先试连再保存"——此时还没有 id，`/:id/test` 用不了。

```json
{
  "apiType": "openai",
  "baseUrl": "https://api.example.com",
  "apiKey": "sk-...",
  "providerId": "p_xxx"
}
```

- `apiKey` 为空且传了 `providerId` 时，**沿用已保存的 Key**。前端不回显明文，
  编辑态不该为了拉列表让用户重填一次。
- 两者都没有 → 400 `尚未填写 API Key，且没有可沿用的已保存 Key`。
- `baseUrl` 已以 `/v1` 结尾时不重复拼接，与转发路径规则一致。
- 鉴权头按协议体系分组：`anthropic` 用 `x-api-key` + `anthropic-version`，
  `openai` / `responses` 用 `Authorization: Bearer`。

返回与连通性测试同构：

```json
{ "ok": true, "latencyMs": 42, "status": 200, "models": ["gpt-5", "gpt-5-mini", "o3"] }
{
  "ok": true,
  "latencyMs": 42,
  "status": 200,
  "models": ["gpt-5", "gpt-5-mini"],
  "capabilities": { "gpt-5": { "contextWindow": 400000, "maxOutputTokens": 64000 } }
}
{ "ok": false, "latencyMs": 10003, "error": "请求超时（10s）" }
```

`capabilities` 是可选字段：解析上游 `/models` 条目里的 `metadata`
（`context_limit` / `context_window` / `context_length` 与 `output_budget` / `max_output_tokens`）
得到，**只包含确实声明了这些字段的模型**。一个都解析不出来时整个字段不出现，
而不是给一个空对象 —— 空对象会被误读成"上游明确声明无限制"。
前端拿到后随供应商一起提交到 `modelCapabilities`，生成 Codex 目录时用作
`context_window`（详见 `docs/agents.md`）。

每个 `capabilities` 条目可能包含：

| 字段 | 含义 |
| --- | --- |
| `contextWindow` | 上下文窗口（token）。目录里作为 `context_window`，Codex 据此算自动压缩阈值 |
| `maxOutputTokens` | 单次输出上限。目录里只作自解释，Codex 的 `ModelInfo` 并不读它 |
| `supportsReasoning` | 是否支持推理档位；`false` 时目录里 `supported_reasoning_levels` 写空数组 |
| `reasoningEfforts` | 该模型可用的推理档位（已按强度升序）。`[]` 表示查过但无可用档位，与缺省（未知）不同 |
| `inputModalities` | 输入模态，**只会是 `text` / `image` / `audio` 的子集** |

`inputModalities` 一定经过白名单过滤：Codex 的模态枚举不认 `pdf` / `video` / `document`，
写进去会让整份目录解析失败并静默回退到内置官方列表（详见 `docs/agents.md`）。
上游没声明时可由 `npm run registry:sync -w server` 从 modelinfo.dev / models.dev 补齐。

连上了但响应里没有可识别的 `data[]` / `models[]` 时返回 `ok: false` 并说明原因，
而不是给一个空列表——否则界面看起来像是"上游真的没有模型"。
任何失败都不会变成 500。

前端把返回结果渲染成**可点选的模型片段**（参考 new-api 渠道编辑的模型框）：
点一下加入、再点一下取消，已选模型以强调色显示。

## 聚合与设置

### GET /api/models

权限 `providers:read`。

```json
{
  "prefix": "lam-",
  "aliases": [
    {
      "alias": "lam-mock-openai/gpt-x",
      "providerId": "p_...",
      "providerKey": "mock-openai",
      "providerName": "Mock OpenAI",
      "apiType": "openai",
      "upstreamModel": "gpt-x"
    }
  ],
  "default": { "providerId": "p_...", "providerName": "Mock OpenAI", "model": "gpt-x" },
  "gateway": {
    "baseUrl": "http://127.0.0.1:8787/v1",
    "token": { "exists": true, "prefix": "lam_abcd", "tail": "wxyz",
               "masked": "lam_abcd************wxyz", "createdAt": "..." }
  }
}
```

### GET /api/settings

权限 `settings:read`。返回 `defaultProviderId` / `defaultModel` / `disableCodexWebSearch` / `approvalReviewModel` / `protocolConversion` / `agentTargets` / `gatewayBaseUrl` / `token`（脱敏）。

### PUT /api/settings/default

权限 `settings:write`。

```json
{ "providerId": "p_...", "model": "gpt-x" }
```

`providerId: null` 表示清除默认。`model` 必须是该供应商已声明的模型，否则 400；
省略时取该供应商第一个模型。

### PATCH /api/settings/codex

权限 `settings:write`。Codex 配置的行为开关。

```json
{ "disableCodexWebSearch": false, "approvalReviewModel": "gpt-6-luna" }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `disableCodexWebSearch` | `true` | 为 `true` 时下发 `web_search = "disabled"`；为 `false` 时**删除**该行（不残留旧值） |
| `approvalReviewModel` | `null` | 「Approve for me」的模型映射。网关识别出审批请求时，把其 `model`（Codex 硬编码的 `gpt-5.6-luna`）换成此值；`null` 不映射。详见 `docs/gateway.md` |
| `protocolConversion` | `false` | 跨协议转发。为 `true` 时 `/v1/responses` 可以落到 `openai` 供应商，由网关双向转换（含工具调用与流式）。默认关闭 |

字段可省略（省略即不修改该项，但仍会刷新 `updatedAt`）。传错类型返回 400
（`disableCodexWebSearch 必须是布尔值` / `approvalReviewModel 必须是字符串或 null`）。

返回 `{ disableCodexWebSearch, requiresReapply: true }` —— 改动只落在设置里，
需要再调一次 `POST /api/agents/codex/apply` 才会写进 `~/.codex/config.toml`
（前端勾选/取消后会自动补一次 apply）。

### POST /api/gateway/token

权限 `gateway:write`。生成或重置网关令牌。

```json
{
  "token": "lam_<完整令牌，仅此一次>",
  "masked": "lam_abcd************wxyz",
  "createdAt": "...",
  "note": "这是唯一一次显示完整令牌，请立即复制并更新已下发的 Agent 配置。"
}
```

重置后旧令牌立即失效，已下发的 Agent 配置需要重新应用。

## Agent

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/agents` | `agents:read` | 列表与接管状态 |
| POST | `/api/agents/:id/preview` | `agents:read` | 只读，返回目标路径与键值对照（凭据脱敏） |
| POST | `/api/agents/:id/apply` | `agents:apply` | 写文件并记录快照 |
| POST | `/api/agents/:id/revert` | `agents:apply` | 撤销我们写入的键 |
| PATCH | `/api/agents/:id/target` | `agents:apply` | 按 Agent 设置连接方式与直连供应商（见下） |
| POST | `/api/agents/:id/stop-processes` | `agents:apply` | 结束本机 Codex 进程，使其重读配置（Claude Code 返回 `supported: false`） |

`:id` 取 `codex` 或 `claude-code`；除 `PATCH .../target` 外全部无 body。

供应商按 Agent 所需的协议挑选：`codex` 只接受 `responses`（它的 `wire_api` 固定写 `responses`），
`claude-code` 只接受 `anthropic`。Codex 不再回落到 `openai` 供应商 —— `wire_api = "chat"` 已被 Codex 移除。
没有匹配协议的启用供应商时预览返回 400，消息里会说明缺哪种协议。

连接方式按 Agent 各存一份（设置项 `agentTargets`），默认 `gateway`。`direct` 时用上游
`baseUrl` + 上游真实 Key + 裸模型名，且**必须**通过 `PATCH .../target` 明确指定供应商——
没指定时预览/应用返回 400，而不是按优先级自动挑一家。走网关与直连的差异见
[agents.md](./agents.md#连接方式走网关与直连上游)。

预览响应（Codex 有三个文件；`catalog` 是整份生成的，所以 `entries` 里只有一条汇总行）：

```json
{
  "agentId": "codex",
  "name": "Codex CLI",
  "applied": false,
  "gatewayBaseUrl": "http://127.0.0.1:8787",
  "connectionMode": "gateway",
  "files": [
    {
      "role": "config",
      "path": "/home/user/.codex/config.toml",
      "exists": true,
      "entries": [
        { "key": "model_provider", "next": "llmapi", "current": "openai", "differs": true },
        { "key": "model_catalog_json", "next": "/home/user/.codex/llmapi-model-catalog.json",
          "current": null, "differs": false },
        { "key": "web_search", "next": "disabled", "current": null, "differs": false },
        { "key": "[model_providers.llmapi] wire_api", "next": "responses",
          "current": null, "differs": false },
        { "key": "[model_providers.llmapi] model_catalog_url",
          "next": "http://127.0.0.1:8787/v1/models", "current": null, "differs": false },
        { "key": "[model_providers.llmapi] base_url", "next": "http://127.0.0.1:8787/v1",
          "current": null, "differs": false }
      ]
    },
    {
      "role": "auth",
      "path": "/home/user/.codex/auth.json",
      "exists": true,
      "entries": [
        { "key": "OPENAI_API_KEY", "next": "lam_abcd****wxyz", "current": null, "differs": false }
      ]
    },
    {
      "role": "catalog",
      "path": "/home/user/.codex/llmapi-model-catalog.json",
      "exists": false,
      "entries": [
        { "key": "（整份生成）", "next": "包含 2 个模型别名",
          "current": null, "differs": true }
      ]
    }
  ]
}
```

`catalog` 是整份生成的文件，没有"按 keys 打补丁"的语义：`entries` 里只有一条汇总行
（`key` 是 `（整份生成）`，`next` 是"包含 N 个模型别名"），不逐个列出 `slug`。
文件已存在时 `current` 是"（将被覆盖，已自动备份）"。

`mode` 由设置项 `agentTargets[<id>].mode` 决定：`gateway` 时 `connectionMode` 是 `"gateway"`；
`direct` 时是 `"direct"` 并额外返回 `directBaseUrl`（实际写进 `base_url` 的上游地址，
Codex 会补 `/v1`，已在末尾含 `/v1` 时不再重复拼接）。
`model_catalog_json` 必须是顶层键（写进 `[model_providers.llmapi]` 会被 Codex 忽略并告警），
它和 `model_catalog_url` 的分工见 [agents.md](./agents.md#模型目录model_catalog_json-与-model_catalog_url)。

API Key、网关令牌等凭据类键的 `next` 与 `current` 只返回前 8 位与后 4 位（中间打码），
完整值不会出现在预览响应中；只有 `apply` 才会把完整值写入目标文件。

应用响应：

```json
{ "binding": { "agentId": "codex", "appliedAt": "...", "appliedBy": "u_owner",
               "runningProcesses": 2,
               "files": [{ "role": "config", "path": "...", "values": {}, "created": false },
                         { "role": "catalog", "path": "...", "values": {}, "created": true }] } }
```

`runningProcesses` 是**应用后探测到的、仍在运行的该 Agent 进程数**（只对 Codex 计数，
Claude Code 恒为 0）。写成功不等于生效：这些进程内存里还是旧配置，界面据此提示"必须重启"。

还原响应：

```json
{
  "restored": ["model_provider", "model", "[model_providers.llmapi] wire_api"],
  "conflicts": [{ "key": "env.ANTHROPIC_MODEL", "expected": "lam-a/x", "current": "user-changed" }]
}
```

`conflicts` 非空表示有键被手动改过、因此保留未动。
生成类文件若由我们创建，还原时直接删除，其文件名会出现在 `restored` 里。

### PATCH /api/agents/:id/target

权限 `agents:apply`。按 Agent 设置下发偏好（Codex 与 Claude Code 互相独立）。

```json
{ "mode": "direct", "directProviderId": "p_...", "directModel": "gpt-x" }
```

| 字段 | 说明 |
| --- | --- |
| `mode` | `gateway` 走网关；`direct` 把供应商 baseUrl 与真实 Key 直接写进配置 |
| `directProviderId` | 直连用哪家供应商。**直连时必填**，保存时就校验存在、未停用、协议匹配 |
| `directModel` | 直连用哪个模型，省略或不在该供应商 `models` 里时取第一个模型 |

字段均可省略（省略即不修改该项）。`mode` 只接受 `gateway` / `direct`；
`directProviderId`、`directModel` 可传 `null` 或空字符串清除。
换供应商时会顺带把 `directModel` 清空（旧模型多半已不存在），除非本次请求同时指定了 `directModel`。
切到 `gateway` 会清空 `directProviderId` / `directModel`，避免下次切回来用了过期供应商。
返回 `{ agentTargets, requiresReapply: true }`，需再调一次 `apply` 才写进文件。

### POST /api/agents/:id/stop-processes

权限 `agents:apply`。结束本机正在运行的 Codex，让它在下次启动时重读配置与模型目录。
无 body。

```json
{
  "actions": ["已停止 Codex 守护进程（codex app-server daemon stop）", "已结束 1 个 Codex 客户端进程"],
  "killed": 1,
  "warnings": [],
  "supported": true
}
```

- 三步：① `codex app-server daemon stop`（5s 超时）；② 按
  `app-server-daemon/daemon.pid`、`daemon-updater.pid` 里记录的 pid 发 `SIGTERM`
  （官方命令失败时的兜底）；③ 对匹配到的 `codex`（TUI）/ `codex exec` 进程发 `SIGTERM`，
  按 800ms / 1200ms / 1600ms 三轮检查存活，仍活着的补 `SIGKILL`。
  匹配规则刻意保守，不碰 `app-server` / `login` / `update` / `mcp` 等子命令。
- `codex` 不在 PATH、守护进程未运行、目录只读等情况都通过 `warnings` / `actions` 说明，**不会**变成 500。
  `SIGKILL` 后仍未退出的进程会连同 pid 一起写进 `warnings`。
- 对 `claude-code` 返回 `supported: false` 与 `killed: 0`（没有常驻进程），仍是 200；未知 `:id` 返回 404。

## 日志与统计

### GET /api/logs

权限 `logs:read`。查询参数 `limit`（1–200，默认 50）、`providerId`（可选过滤）。最新在前。

```json
{
  "logs": [
    {
      "tenantId": "t_default",
      "at": "2026-01-01T00:00:00.000Z",
      "path": "/v1/chat/completions",
      "requestedModel": "lam-mock-openai/gpt-x",
      "upstreamModel": "gpt-x",
      "providerId": "p_...",
      "providerName": "Mock OpenAI",
      "mode": "alias",
      "stream": false,
      "status": 200,
      "latencyMs": 111,
      "fallback": false
    }
  ]
}
```

`mode`：`alias`（命中别名）/ `default`（走默认供应商）/ `invalid`（解析失败）。

### GET /api/stats

权限 `logs:read`。仅统计当天（UTC 日期）。

```json
{ "total": 12, "success": 11, "successRate": 91.7, "avgLatencyMs": 320 }
```

成功率按 `status` 在 200–399 计成功。

## 网关

鉴权用 `Authorization: Bearer <token>` 或 `x-api-key: <token>`（本服务令牌，两种写法等价），
缺失/错误返回 401 且不产生上游请求。

| 方法 | 路径 | 要求的上游 `apiType` |
| --- | --- | --- |
| GET | `/v1/models` | 不要求（不限协议） |
| POST | `/v1/chat/completions` | `openai` |
| POST | `/v1/messages` | `anthropic` |
| POST | `/v1/responses` | `responses` |

三条 POST 路径默认严格匹配：供应商协议与路径不符时返回 501（`not_implemented`），
不会退化成直通。比如 `/v1/responses` 打到 `openai` 供应商默认会被拦下 —— 早期它确实是不限协议的
直通路径，结果把 Responses 请求发给了只支持 Chat 的上游。

唯一的例外是设置项 `protocolConversion`：打开后 `/v1/responses → openai` 由网关做双向转换
（其余组合仍 501）。遇到"打开就能解决"的协议不匹配时会**自动开启**并持久化，
且在响应头带 `x-llmapi-auto-conversion: 1`；开关关着时这类 501 的 `error.details`
带 `{ "canEnableConversion": true }`。详见 [gateway.md](./gateway.md#跨协议转发responses--chat)。

请求体必须有 `model` 字段。流式由 `"stream": true` 触发。详见 [gateway.md](./gateway.md)。

## 健康检查

### GET /api/health

免鉴权。用于探活与展示启动告警。

```json
{
  "ok": true,
  "warnings": [
    { "code": "plaintext_credentials",
      "message": "未设置 DATA_ENCRYPTION_KEY，供应商 API Key 将以明文保存在 data 目录…" }
  ],
  "gatewayBaseUrl": "http://127.0.0.1:8787/v1"
}
```

**不含** `dataDir`：这是 public 接口，返回本机绝对路径等于把部署结构告诉任何扫到这个端口的人。
需要路径请看启动日志或 `docs/configuration.md`。

可能的 `code`：`corrupt_file`、`plaintext_credentials`、`credential_decrypt_failed`、
`setup_pending`。

## API 令牌（程序化访问）

`/api/*` 默认只接受浏览器会话 cookie。要给脚本或 CI 用，创建一个 API 令牌：

```bash
# 1. 用会话创建令牌（明文只在这一次响应里出现）
curl -X POST http://127.0.0.1:8787/api/tokens \
  -H 'Cookie: <你的会话 cookie>' \
  -H 'content-type: application/json' \
  -d '{"name":"CI 脚本","scopes":["providers:read","logs:read"]}'
# → { "token": "api_xxx…", "tokenView": { … } }

# 2. 之后用 Bearer 调用，不需要 cookie
curl http://127.0.0.1:8787/api/providers -H 'Authorization: Bearer api_xxx…'
```

> ⚠️ **明文只在创建响应的 `token` 字段里出现这一次。** 关掉弹窗、刷新页面或丢了响应体，
> 就只能吊销重建 —— 服务端只存 `sha256`，没有任何接口能再把它读出来。
> 控制台的令牌卡片也是这样：明文显示一次，之后列表里只有 `prefix`…`tail`。

**与网关令牌（`lam_`）是两套东西，不要混用**：

| | API 令牌（`api_`） | 网关令牌（`lam_`） |
| --- | --- | --- |
| 调用面 | `/api/*` 管理面 | `/v1/*` 推理转发 |
| 权限模型 | scopes（可收窄） | 无，只能转发 |
| 存放 | `data/tenants/<id>/api-tokens.json` | 租户设置里（`settings.json`） |
| 认的请求头 | `Authorization: Bearer` | `Authorization: Bearer` 或 `x-api-key` |

混用的后果很直接，两种情况都是 401（不是 403）：

- 拿 `lam_` 去调 `/api/*` → 管理面只认 `api_` 前缀，`lam_` 被当成无效凭据。
- 拿 `api_` 去调 `/v1/*` → 网关只比对租户设置里的网关令牌哈希，`api_` 永远匹配不上。

前缀分开就是为了让日志与用户心智都能一眼区分；出问题时也能从日志判断是哪一类凭据泄露。

### 接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/tokens` | `settings:read` | 列出令牌，含 `availableScopes`（前端据此渲染勾选项） |
| POST | `/api/tokens` | `settings:write` | 创建；**仅此响应返回明文** |
| DELETE | `/api/tokens/:id` | `settings:write` | 吊销（置 `revokedAt`，不物理删除）；**幂等** |

注意 `GET` 要 `settings:read` 而创建/吊销要 `settings:write`：一个只读令牌能看令牌列表
（含每个令牌的 scopes），但既不能创建也不能吊销。

创建参数：

| 字段 | 说明 |
| --- | --- |
| `name` | 必填，**≤64 字**（超出返回 400），列表里靠它区分；首尾空白会被 trim |
| `scopes` | 必填，权限名数组，**不能为空**；未知权限名返回 400，重复项会自动去重 |
| `expiresAt` | 可选 ISO 时间；省略、`null` 或空字符串表示不过期。**必须是合法时间且晚于当前时间**，否则 400 |

`expiresAt` 的校验是"必须晚于现在"而不是"允许过去"：填一个过去的时间不会立刻创建一个
已失效的令牌，而是直接报错。服务端会把它规范化成 ISO 字符串再存。

吊销是幂等的：对一个已吊销的 id 再发 `DELETE` 返回 200 和当前 `tokenView`，不报错。
所以脚本可以无脑重试。未知 id 才返回 404。

### 边界

- **只能收窄、不能提权**：`scopes` 必须是创建者自身权限的子集，否则 403
  （错误信息指明"该 API 令牌缺少权限 X"，不会回显角色——令牌没有角色语义）。
- `users:manage` / `tenants:manage` 不允许授予令牌（当前没有接口使用，开放只有风险），
  且 `availableScopes` 里也不会出现这两项。
- **令牌不能创建或吊销令牌**：否则一个即将被吊销的令牌可以先给自己留后门。
  用令牌调这两个接口返回 403，必须用登录会话。
- **令牌不能调用 `authenticated` 级接口**：`/api/auth/me`、`/api/auth/password` 都拒绝令牌，
  否则凭据泄露后可以永久接管账号，吊销令牌也救不回来。
- 明文只在创建响应里出现一次，之后只存 sha256；列表只给 `prefix`/`tail`。
- `lastUsedAt` 按 60 秒节流更新（每次请求都写盘会让高频脚本把磁盘打得很差），
  实际精度是"分钟级"，不能用它做精确审计。
- 令牌按租户分文件存放：当前只有默认租户，所以鉴权时直接查 `t_default`。
  做多租户需要一张全局 `hash → tenantId` 索引，否则得遍历所有租户。

## 信息接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/info` | `public` | 名称、版本、启动时间、运行时长、网关基址 |
| GET | `/api/overview` | `providers:read` | 供应商分布、别名数、关键设置、Agent 状态、今日统计 |

`/api/info` 是 public（程序需要登录前确认"这是不是我要连的实例"），因此**不含**
数据目录等部署细节。`/api/health` 同理，已移除 `dataDir` 字段。

`/api/overview` 的价值是"一次拿全"：脚本不必为了一份总览发七八个请求。

## 诊断接口（`ENABLE_DIAGNOSTICS=1` 才开启）

这段接口是为**排查"功能到底有没有生效"**而存在的，不是日常运维必用。
默认关闭：未设置 `ENABLE_DIAGNOSTICS=1` 时返回 404。

> 关于"404 是为了隐藏功能"这个说法要打个折扣：404 的响应体里其实写明了
> `诊断接口未启用，请设置 ENABLE_DIAGNOSTICS=1 后重启`，探测者照样知道开关存在。
> 用 404 而不是 403 的实际理由是**语义**——这里拒绝的原因与调用者身份无关（是功能没开），
> 而 403 应该留给"你没权限"。
>
> 另有一处顺序要留意：404 是在 handler 里抛的（`assertEnabled`），权限判定在更早的
> `onRequest` 钩子里。所以只有 `providers:read` 的令牌来调，拿到的是 **403**（缺
> `settings:write`），根本走不到 404。对有权限的调用方，关闭时才是 404。

为什么需要它们：本仓库的行为横跨「设置项 → 选路 → 协议转换 → 上游 → 回转」四层，
中间任何一层判断错，症状都是**上游不报错、客户端也不报错，只是结果不对**
（工具调用执行不了、思考区一直转圈、模型列表里少一家）。这种问题靠读日志很难定位。

| 方法 | 路径 | 权限 | 作用 |
| --- | --- | --- | --- |
| POST | `/api/diagnostics/route` | `settings:write` | 路由预演：不发送请求，只看会走哪里 |
| POST | `/api/diagnostics/forward` | `settings:write` | 全链路：真打上游，返回每层中间结果 |
| GET | `/api/diagnostics/check` | `settings:write` | 自检清单：找出互相矛盾的配置 |
| GET | `/api/diagnostics/converter` | `settings:write` | 转换器纯函数自检，不依赖供应商 |

四个接口**全部**要求 `settings:write`（不是 `settings:read`）：它们会暴露 prompt 片段、
能真的打上游，只读权限不该够用。

### 公共参数

两个 POST 接口都接受：

| 字段 | 说明 |
| --- | --- |
| `model` | 必填，非空字符串。别名（`lam-xxx/model`）或裸模型名都行 |
| `path` | 可选，默认 `/responses`。可写 `/responses` 或 `/v1/responses`，也接受 `/chat/completions`、`/messages` |
| `body` | 仅 `/forward`：替换请求体（见下） |

`path` 会先剥掉 `/v1` 前缀再校验，不在 `GATEWAY_PATHS` 里就返回 400 并列出可选值。

### `/api/diagnostics/route`

```bash
curl -X POST http://127.0.0.1:8787/api/diagnostics/route \
  -H 'Authorization: Bearer api_…' -H 'content-type: application/json' \
  -d '{"model":"my-model","path":"/responses"}'
```

返回里最有用的几个字段：

- `ok`：**这次真实请求会不会成功**。它同时考虑"协议匹配"与"会不会转换"，
  不是简单的"选到了供应商"。
- `primary.reason`：为什么选它。取值 `alias`（别名明确指向）/ `default-provider`（默认供应商）
  / `approval-placeholder`（审批占位名被改写）/ `priority`（按协议优先 + priority 排序取第一）
- `primary.convertResponsesToChat`：这次要不要做协议转换
- `primary.wouldUseUpstreamUrl`：**上游实际会收到的 URL**。开启转换时它的路径部分是
  `/chat/completions` 而不是 `/responses` —— 这个字段错了就说明路径改写没生效
  （它由 `upstreamUrl(provider, upstreamPathFor(...))` 算出，与真实转发同一个函数）
- `primary.apiTypeMatchesPath`：供应商协议是否与路径匹配。`false` 且没有转换，就必然 501
- `primary.authHeaderKind`：上游会用 `authorization: Bearer` 还是 `x-api-key`
- `wouldAutoEnableConversion`：**这次真实请求会顺手打开 `protocolConversion`**。
  真实网关在"路径要 responses、没有启用的 responses 供应商、但有启用的 openai 供应商"时
  会自动开启并持久化。诊断**不写设置**，只在内存副本上模拟，所以你可以放心反复预演；
  但要把这个字段当成"我的设置会被改"的预告。
- `wouldBeRejected`：不为 null 就是"真实网关会返回 501"的完整理由；为 null 表示能过
- `excluded[]`：被排除的供应商**及原因**（`providerId` / `providerName` / `reason`）。
  回答"我明明有三家供应商，为什么说没有"

> 为什么诊断要模拟"自动开启"：如果它只在当前设置下算，就会在"只有 openai 供应商 +
> 开关关着"时回答"直发 /responses、不需要转换"，而真实网关已经自动开了开关、改走
> `/chat/completions` —— 结论方向完全相反，比没有诊断更误导。

选路失败时（`ok: false`）返回 `reason`、`excluded` 和 `hint`：
当路径要 `responses`、转换又关着时，`hint` 会直接提示"可以开 `protocolConversion`"。

### `/api/diagnostics/forward`

真的打一次上游，把 `select` → `convert-request` → `upstream` → `convert-response`
四步的中间结果都返回。

**`convert-request.body` 不是客户端请求体的原样拷贝**，而是"转换并规范化之后、准备发给上游的
那个对象"。它会：

- 把 `model` 换成上游模型名（`select` 阶段算出的 `upstreamModel`）；
- 走转换时由 `responsesToChatRequest` 重写形状：`input` → `messages`、工具从扁平改嵌套、
  `max_output_tokens` → `max_tokens`；
- **补上请求里没有的字段**：`stream`（恒有，默认 `false`）、以及 `stream: true` 时自动加的
  `stream_options: { include_usage: true }`（不加它上游的用量统计永远是 0）。

被丢掉的字段列在 `convert-request.dropped` 里（例如 `reasoning.summary`、`tools.web_search`），
这是判断"某个功能为什么没效果"的直接依据。没走转换时该步骤带 `skipped: true`。

`convert-response.body` 是**转回 Responses 形状后 Codex 会收到的结果**；不转换时同样 `skipped`。

请求体用 `body` 字段整体替换，默认是 `{ "model": <model> }`：

```bash
curl -X POST http://127.0.0.1:8787/api/diagnostics/forward \
  -H 'Authorization: Bearer api_…' -H 'content-type: application/json' \
  -d '{"model":"lam-my-chat/gpt-x","path":"/responses",
       "body":{"model":"ignored","input":"hi","tools":[{"type":"function","name":"shell"}]}}'
```

> ⚠️ 两个成本：这个接口会回显 prompt 片段，也会**真实消耗上游额度**。用完请把开关关掉。
> 另外它**不支持流式**：即使你在 `body` 里传 `"stream": true`，它也是把上游响应当整段
> 读完再处理。走转换时这一步会拿 SSE 文本去 `JSON.parse`，因此 `convert-response`
> 会 `ok: false`；不走转换时你能在 `upstream.bodyPreview` 里看到 RAW SSE 文本。
> 要验证流式请直接打网关。

其他实现细节：上游请求有 60 秒超时；`upstream.bodyPreview` 只截前 4000 字符并把
`truncated` 标出来（避免超大响应把诊断接口本身拖垮）；上游不可达时返回
`ok: false` + `summary: '上游不可达，真实请求会返回 502'`。

### `/api/diagnostics/check`

把"应该一致"的几处放在一起比对，专门抓这类问题：设置开着但目录没跟上、
目录里有用户选中后必然 501 的条目、审批模型映射配在了直连模式下（不生效）。
每条 `check` 都带 `fix` 建议。

四项检查：`Codex 有可用的上游协议`、`Codex 模型目录不含用不了的协议`、
`审批模型映射的生效条件`（或在直连模式下的告警）、`别名都指向现存供应商`。
另带 `snapshot`：供应商按协议分布、别名数、关键设置、Agent 列表。

### `/api/diagnostics/converter`

不碰网络、不读设置，只验证转换器本身的映射是否正常（文本、工具定义、custom 工具、
有状态特性应拒绝、响应回转）。适合改完 `gateway/convert/` 后立刻确认没写坏。

### 实现约束

诊断**必须复用网关自己的逻辑**（`gateway/selection.ts`、`gateway/convert/`、
`forward.ts` 的 `upstreamPathFor`）。若诊断自己再算一遍，就会出现
"诊断说会转换、实际没转换"——这比没有诊断更糟。这也是把这几个函数抽成共享模块的原因。

