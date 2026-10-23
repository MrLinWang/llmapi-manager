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
  "enabled": true,
  "priority": 0,
  "notes": "可选",
  "websiteUrl": "可选"
}
```

约束：`name` 非空；`apiType` ∈ `openai | anthropic | responses`（非法值返回
400 `apiType 只能是 openai / anthropic / responses`）；`baseUrl` 必须是 http/https；
`models` 去重后保持输入顺序；`priority` 越小越靠前。

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
{ "ok": false, "latencyMs": 10003, "error": "请求超时（10s）" }
```

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

权限 `settings:read`。返回 `defaultProviderId` / `defaultModel` / `disableCodexWebSearch` / `gatewayBaseUrl` / `token`（脱敏）。

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
{ "disableCodexWebSearch": false }
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `disableCodexWebSearch` | `true` | 为 `true` 时下发 `web_search = "disabled"`；为 `false` 时**删除**该行（不残留旧值） |

字段可省略（省略即不修改该项，但仍会刷新 `updatedAt`），传非布尔值返回 400
`disableCodexWebSearch 必须是布尔值`。

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
| POST | `/api/agents/:id/stop-processes` | `agents:apply` | 结束本机 Codex 进程，使其重读配置（Claude Code 返回 `supported: false`） |

`:id` 取 `codex` 或 `claude-code`。以上全部无 body。

供应商按 Agent 所需的协议挑选：`codex` 只接受 `responses`（它的 `wire_api` 固定写 `responses`），
`claude-code` 只接受 `anthropic`。Codex 不再回落到 `openai` 供应商 —— `wire_api = "chat"` 已被 Codex 移除。
没有匹配协议的启用供应商时预览返回 400，消息里会说明缺哪种协议。

预览响应（Codex 有三个文件；`catalog` 是整份生成的，所以 `entries` 里只有一条汇总行）：

```json
{
  "agentId": "codex",
  "name": "Codex CLI",
  "applied": false,
  "gatewayBaseUrl": "http://127.0.0.1:8787",
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
`model_catalog_json` 必须是顶层键（写进 `[model_providers.llmapi]` 会被 Codex 忽略并告警），
它和 `model_catalog_url` 的分工见 [agents.md](./agents.md#模型目录model_catalog_json-与-model_catalog_url)。

API Key、网关令牌等凭据类键的 `next` 与 `current` 只返回前 8 位与后 4 位（中间打码），
完整值不会出现在预览响应中；只有 `apply` 才会把完整值写入目标文件。

应用响应：

```json
{ "binding": { "agentId": "codex", "appliedAt": "...", "appliedBy": "u_owner",
               "files": [{ "role": "config", "path": "...", "values": {}, "created": false },
                         { "role": "catalog", "path": "...", "values": {}, "created": true }] } }
```

还原响应：

```json
{
  "restored": ["model_provider", "model", "[model_providers.llmapi] wire_api"],
  "conflicts": [{ "key": "env.ANTHROPIC_MODEL", "expected": "lam-a/x", "current": "user-changed" }]
}
```

`conflicts` 非空表示有键被手动改过、因此保留未动。
生成类文件若由我们创建，还原时直接删除，其文件名会出现在 `restored` 里。

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

- 先 `codex app-server daemon stop`，再对匹配到的 `codex`（TUI）/ `codex exec` 进程发 `SIGTERM`，
  300ms 后补 `SIGKILL`。匹配规则刻意保守，不碰 `app-server` / `login` / `update` / `mcp` 等子命令。
- `codex` 不在 PATH、守护进程未运行、目录只读等情况都通过 `warnings` / `actions` 说明，**不会**变成 500。
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

三条 POST 路径都是严格匹配：供应商协议与路径不符时返回 501（`not_implemented`），
不会退化成直通。比如 `/v1/responses` 打到 `openai` 供应商会被拦下 —— 早期它确实是不限协议的
直通路径，结果把 Responses 请求发给了只支持 Chat 的上游。

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
  "dataDir": "/path/to/data",
  "gatewayBaseUrl": "http://127.0.0.1:8787/v1"
}
```

可能的 `code`：`corrupt_file`、`plaintext_credentials`、`credential_decrypt_failed`、
`setup_pending`。
