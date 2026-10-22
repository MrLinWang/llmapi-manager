# 安全模型

## 两类凭据，两条通路

| 通路 | 凭据 | 能做什么 |
| --- | --- | --- |
| 管理面 `/api/*` | 会话 Cookie（口令登录） | 按角色授权，可改供应商、下发 Agent 配置 |
| 数据面 `/v1/*` | 网关令牌（Bearer / x-api-key） | 只能消费模型，不能访问管理接口 |

两者解析出的都是 `Principal`，但 `role` 不同：会话取账号真实角色，网关令牌固定为 `member`。
`member` 只有 `gateway:read`，走到任何 `/api/*` 写接口都会 403。

## 口令

- 用 scrypt（N=16384 默认参数、16 字节随机盐、64 字节派生）哈希，存储格式 `scrypt$<salt>$<hash>`。
- 校验用 `timingSafeEqual`，避免时序侧信道。
- 登录失败统一返回"用户名或口令不正确"，并对不存在用户也做一次延迟，减少账号枚举信号。
- 修改口令需校验旧口令；成功后 `authVersion += 1`，**所有**既有会话（含当前）立即失效。

遗忘了口令：删除 `data/identity.json` 后重启会重建账号，但租户与账号数据会清空
（`tenants/` 下的业务数据仍在，只是没有账号能登录）。

## 会话

Cookie 名 `llmapi_session`，值为 `<base64url(payload)>.<HMAC-SHA256>`：

```
{ sid, userId, tenantId, role, authVersion, exp }   // 7 天
```

- 属性：`HttpOnly`、`SameSite=Lax`、`Path=/`；当 `PUBLIC_BASE_URL` 为 https 时加 `Secure`。
- 每次请求都回表核对用户的 `status`、`tenantId`、`role`、`authVersion`。
  停用账号、改口令、改角色都会让旧 Cookie 立刻失效。
- 签名密钥来自 `SESSION_SECRET`，未设置时生成并持久化到 `data/instance.json`。

## 网关令牌

- 格式 `lmm_<32 字节 base64url>`。
- 只存 `sha256(token)`（`tokenHash`），比对用 `timingSafeEqual`。
- 为了给 Agent 下发配置，另存一份 `tokenCipher`（`SecretCodec` 编码），**任何接口都不返回它**。
- 查看接口只返回 `prefix`（前 8 位）+ `tail`（后 4 位）拼成的掩码；完整值只在"生成/重置"的那一次响应里出现。
- 重置后旧令牌立即失效，已下发的 Agent 配置必须重新应用，否则 Agent 会 401。

## 权限

11 个权限位，集中定义在 `server/src/domain/permissions.ts`：

| 权限 | 含义 |
| --- | --- |
| `providers:read` / `providers:write` | 查看 / 增删改供应商与连通性测试 |
| `gateway:read` / `gateway:write` | 查看网关信息 / 生成与重置网关令牌 |
| `agents:read` / `agents:apply` | 预览 / 应用与还原 Agent 配置 |
| `logs:read` | 查看请求日志与统计 |
| `settings:read` / `settings:write` | 查看 / 修改默认供应商与模型 |
| `users:manage` / `tenants:manage` | 预留给多用户与多租户管理（当前无对应接口） |

角色映射：

| 角色 | 权限 |
| --- | --- |
| `owner` | 全部 11 项 |
| `admin` | 除 `gateway:write`、`users:manage`、`tenants:manage` 外的管理权限 |
| `member` | 仅 `gateway:read` |

强制机制：

- 每条 `/api` 路由必须经 `defineRoute` 注册并声明 `access`；
  `registerApiGuard` 在 `onRequest` 阶段解析 `Principal` 并调用 `assertCan`。
- `RouteRegistry.assertAllDeclared()` 在启动时自检；未登记的路由请求会直接 500，
  **不存在默认放行**。请求未匹配到任何路由时（`routeOptions.url` 为空）交给 404 处理，不误判。
- 越权返回 403 `{ "error": { "code": "forbidden", "message": "角色 X 缺少权限 Y" } }`，且不执行任何写操作。

## 上游凭据

- 供应商 API Key 经 `SecretCodec.encode()` 落盘；只有真正发请求（转发、连通性测试）时才 `decode()`。
- 列表/详情接口返回 `apiKeyMasked`（首 3 位 + 8 星 + 尾 4 位）与 `apiKeyTail`，**不返回 `apiKey`**，
  并由 `toProviderView` 同时剔除 `tenantId`。
- 客户端自带的 `Authorization` / `x-api-key` 不会被转发给上游 —— 网关头只用于校验本服务令牌。
- 日志器按 key 名（`apikey` / `authorization` / `token` / `password` / `secret` 等）打码，
  并把 `sk-xxx`、`Bearer xxx` 形式的字符串截断。但这是兜底，不要主动把密钥写进日志。

## 会碰你的文件系统

这是本工具最需要知情的地方：

- 只有点击"应用配置"时才会写 `~/.codex/config.toml`、`~/.codex/auth.json`、`~/.claude/settings.json`
  （或 `AGENT_HOME_DIR` 下的对应路径）。
- 写入前备份到 `data/tenants/<tenantId>/backups/<agentId>/`。
- 只改自己拥有的键，其余内容原样保留；文件解析失败则中止，不写空文件。
- 还原只撤销"值仍等于我们写入值"的键，被手改过的键保留并报告冲突。

## 部署风险清单

| 风险 | 缓解 |
| --- | --- |
| 监听 `0.0.0.0` 且无 TLS | 放在 HTTPS 反代后；Cookie 在 https 下自动加 `Secure` |
| 未设 `DATA_ENCRYPTION_KEY` | 启动日志 + `/api/health` 持续告警；建议设置 |
| 网关令牌泄漏 | 重置令牌；令牌只存哈希，泄漏面仅限使用方能消费模型 |
| 服务进程权限过大 | 它以当前 OS 用户的身份运行，能写该用户的家目录；考虑用专用用户运行 |
| 数据目录被他人读取 | 文件权限 0600；确保 `data/` 所在目录不被其他人遍历 |
| 多实例共享 `data/` | 不支持，会造成写入竞争；单实例部署 |
| 反向代理缓冲 SSE | 关闭 `proxy_buffering`，否则流式响应被攒住 |

## 不做的事

- 不做多因素认证、不做 OAuth 登录、不做细粒度对象级 ACL（权限只到"类"这一级）。
- 不加密 `requests.jsonl`（其中不含凭据，但含模型名与供应商名，自行评估敏感性）。
- 不对上游证书做额外校验控制（使用 Node 默认 HTTPS 校验）。
