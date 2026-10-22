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
{ "username": "owner", "password": "..." }
```

失败一律返回 401 `用户名或口令不正确`，不区分"用户不存在"与"口令错误"。

### POST /api/auth/logout

免鉴权，清除 Cookie，返回 `{ "ok": true }`。

### GET /api/auth/me

需登录。返回身份与权限清单（前端据此决定显示哪些菜单）。

```json
{
  "user": { "id": "u_owner", "tenantId": "t_default", "role": "owner", "username": "owner" },
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
| POST | `/api/providers/:id/test` | `providers:write` | 请求上游 `/models`，10s 超时 |
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

约束：`name` 非空；`apiType` ∈ `openai | anthropic`；`baseUrl` 必须是 http/https；
`models` 去重后保持输入顺序；`priority` 越小越靠前。

连通性测试返回：

```json
{ "ok": true, "latencyMs": 42, "status": 200, "models": ["gpt-x", "gpt-x-mini"] }
{ "ok": false, "latencyMs": 10003, "error": "请求超时（10s）" }
```

测试失败不会抛 500，结果同时写回该供应商的 `lastTest`。

## 聚合与设置

### GET /api/models

权限 `providers:read`。

```json
{
  "prefix": "lmm-",
  "aliases": [
    {
      "alias": "lmm-mock-openai/gpt-x",
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
    "token": { "exists": true, "prefix": "lmm_abcd", "tail": "wxyz",
               "masked": "lmm_abcd************wxyz", "createdAt": "..." }
  }
}
```

### GET /api/settings

权限 `settings:read`。返回 `defaultProviderId` / `defaultModel` / `gatewayBaseUrl` / `token`（脱敏）。

### PUT /api/settings/default

权限 `settings:write`。

```json
{ "providerId": "p_...", "model": "gpt-x" }
```

`providerId: null` 表示清除默认。`model` 必须是该供应商已声明的模型，否则 400；
省略时取该供应商第一个模型。

### POST /api/gateway/token

权限 `gateway:write`。生成或重置网关令牌。

```json
{
  "token": "lmm_<完整令牌，仅此一次>",
  "masked": "lmm_abcd************wxyz",
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

`:id` 取 `codex` 或 `claude-code`。无 body。

预览响应：

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
        { "key": "[model_providers.llmapi] base_url", "next": "http://127.0.0.1:8787/v1",
          "current": null, "differs": false }
      ]
    }
  ]
}
```

API Key、网关令牌等凭据类键的 `next` 与 `current` 只返回前 8 位与后 4 位（中间打码），
完整值不会出现在预览响应中；只有 `apply` 才会把完整值写入目标文件。

应用响应：

```json
{ "binding": { "agentId": "codex", "appliedAt": "...", "appliedBy": "u_owner",
               "files": [{ "role": "config", "path": "...", "values": {}, "created": false }] } }
```

还原响应：

```json
{
  "restored": ["model_provider", "model"],
  "conflicts": [{ "key": "env.ANTHROPIC_MODEL", "expected": "lmm-a/x", "current": "user-changed" }]
}
```

`conflicts` 非空表示有键被手动改过、因此保留未动。

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
      "requestedModel": "lmm-mock-openai/gpt-x",
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

鉴权用 `Authorization: Bearer <token>` 或 `x-api-key: <token>`，缺失/错误返回 401 且不产生上游请求。

| 方法 | 路径 | 上游要求 |
| --- | --- | --- |
| GET | `/v1/models` | — |
| POST | `/v1/chat/completions` | `apiType=openai` |
| POST | `/v1/messages` | `apiType=anthropic` |
| POST | `/v1/responses` | 不限制 |

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
`initial_password_printed`。
