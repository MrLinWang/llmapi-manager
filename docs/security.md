# 安全模型

## 两类凭据，两条通路

| 通路 | 凭据 | 能做什么 |
| --- | --- | --- |
| 管理面 `/api/*` | 会话 Cookie（口令登录） | 按角色授权，可改供应商、下发 Agent 配置 |
| 数据面 `/v1/*` | 网关令牌（Bearer / x-api-key） | 只能消费模型，不能访问管理接口 |

两者解析出的都是 `Principal`，但 `role` 不同：会话取账号真实角色，网关令牌固定为 `member`。
`member` 只有 `gateway:read`，走到任何 `/api/*` 写接口都会 403。

> 注意"本服务令牌的两种写法"与"上游的鉴权形态"是两件事：客户端既可以用
> `Authorization: Bearer <网关令牌>`，也可以用 `x-api-key: <网关令牌>`，两者都会被解析成本服务的
> `Principal`；而转发给上游时，只有 `openai` / `responses` 供应商走 Bearer、`anthropic` 供应商走
> `x-api-key` + `anthropic-version`，与客户端当初用哪种写法无关。

## 口令

- 用 scrypt（N=16384 默认参数、16 字节随机盐、64 字节派生）哈希，存储格式 `scrypt$<salt>$<hash>`。
- 校验用 `timingSafeEqual`，避免时序侧信道。
- 登录失败统一返回"用户名或口令不正确"，并对不存在用户也做一次延迟，减少账号枚举信号。
- 修改口令需校验旧口令；成功后 `authVersion += 1`，**所有**既有会话（含当前）立即失效。

遗忘了口令：删除 `data/identity.json` 与 `data/setup.json` 后重启会重建账号，
但租户与账号数据会清空（`tenants/` 下的业务数据仍在，只是没有账号能登录）。

## 首次初始化（认领窗口）

默认配置下首次启动**不创建账号**，而是生成一次性初始化令牌（`setup_…`）打印到控制台。
设置页需要「令牌 + 自设用户名 + 自设口令」才能创建 `role=owner` 的管理员。

- **作用**：服务刚启动、还没设密码时是一扇开着的门。令牌只出现在控制台，
  因此只有能读到控制台的人（部署者本人）能完成认领，避免端口暴露时被陌生人抢注。
- **只存哈希**：`data/setup.json` 里是 `sha256(token)`，会话日志与接口都不返回明文；
  令牌也**不写入运行日志**（只打印到控制台）。
- **一次性**：初始化成功后令牌清空，`POST /api/setup` 一律 409，不会覆盖已有管理员。
- **失败计数**：令牌校验失败会累加 `failedAttempts`，便于发现试探行为。
- **无交互部署**：设置 `ADMIN_PASSWORD` 可跳过网页初始化直接建号；
  此时初始化接口保持关闭（状态里 `needsSetup: false`）。

> 注意：这条通路的强度取决于"控制台只有你能看"。若把服务跑在共享机器、
> 或把启动日志转发到公开的日志聚合平台，应改用 `ADMIN_PASSWORD` 并保管好环境变量。

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

- 格式 `lam_<32 位 base64url>`（24 字节随机数编码而成）。
- 只存 `sha256(token)`（`tokenHash`），比对用 `timingSafeEqual`。
- 为了给 Agent 下发配置，另存一份 `tokenCipher`（`SecretCodec` 编码），**任何接口都不返回它**。
- 查看接口只返回 `prefix`（前 8 位）+ `tail`（后 4 位）拼成的掩码；完整值只在"生成/重置"的那一次响应里出现。
- 重置后旧令牌立即失效，已下发的 Agent 配置必须重新应用，否则 Agent 会 401。

## 权限

13 个权限位，集中定义在 `server/src/domain/permissions.ts`：

| 权限 | 含义 |
| --- | --- |
| `providers:read` / `providers:write` | 查看 / 增删改供应商、连通性测试与拉取上游模型列表 |
| `gateway:read` / `gateway:write` | 查看网关信息 / 生成与重置网关令牌 |
| `agents:read` / `agents:apply` | 预览 / 应用与还原 Agent 配置；`agents:apply` 还能**结束本机 Codex 进程** |
| `logs:read` | 查看请求日志与统计 |
| `settings:read` / `settings:write` | 查看 / 修改默认供应商与模型、Codex 行为开关、同步角色与范围；**API 令牌的查看 / 创建 / 吊销**也归这里 |
| `sync:read` | **导出同步快照（含全部上游 API Key 明文）**，见「同步快照的威胁模型」 |
| `sync:write` | 拉取 master 快照、仲裁同步冲突（不导出凭据，风险与改设置同级） |
| `settings:read` / `settings:write` | 查看 / 修改默认供应商与模型、Codex 行为开关、**界面语言**；**API 令牌的查看 / 创建 / 吊销**也归这里 |

| `users:manage` / `tenants:manage` | 预留给多用户与多租户管理（当前无对应接口，也不可授予 API 令牌） |

角色映射：

| 角色 | 权限 |
| --- | --- |
| `owner` | 全部 13 项 |
| `admin` | 除 `gateway:write`、`sync:read`、`users:manage`、`tenants:manage` 外的管理权限（**含 `sync:write`**） |
| `member` | 仅 `gateway:read` |

> `admin` 刻意**不含** `sync:read`：那个权限能把全部上游 Key 明文导出去，应当由 owner
> 显式授予，而不是随 admin 一起扩散。但它**有** `sync:write`——拉取与仲裁改的是本机
> 自己的配置，风险与改设置同级。这个不对称就是"只收窄、不提权"的具体形态。

> `member` 是网关令牌解析出的角色，它只够消费模型。**API 令牌不是这个角色**：
> 令牌解析出的 `role` 虽然也是 `member`，但判定时只看 `scopes`、忽略角色
> （见下节「只收窄、不提权」）。所以一个带 `providers:read` 的 API 令牌能读供应商，
> 而网关令牌连 `/api/providers` 都进不去。

强制机制：

- 每条 `/api` 路由必须经 `defineRoute` 注册并声明 `access`；
  `registerApiGuard` 在 `onRequest` 阶段解析 `Principal` 并调用 `assertCan`。
- 管理面同时接受会话 cookie 与 `Authorization: Bearer api_…`，**会话优先**：
  两者都带时按会话身份裁决，不会被附带的 Authorization 头改变语义。
- `RouteRegistry.assertAllDeclared()` 在启动时自检；未登记的路由请求会直接 500，
  **不存在默认放行**。请求未匹配到任何路由时（`routeOptions.url` 为空）交给 404 处理，不误判。
- 越权返回 403，且不执行任何写操作。错误信息分两种：
  会话是 `角色 X 缺少权限 Y`，API 令牌是 `该 API 令牌缺少权限 Y`
  —— 令牌没有角色语义，回显角色会把排查方向带偏。
- `agents:apply` 的作用范围**不止写文件**：它还会通过 `POST /api/agents/:id/stop-processes`
  结束本机上的 Codex 进程（`SIGTERM`，必要时 `SIGKILL`）。这是"改完配置要让客户端重读"的必要一步，
  但它意味着持有该权限的账号（`owner` 与 `admin`）能让同一台机器上的 Codex 会话中断。
  `member` 只有 `gateway:read`，碰不到这个接口。

## 上游凭据

- 供应商 API Key 经 `SecretCodec.encode()` 落盘；只有真正发请求（转发、连通性测试）时才 `decode()`。
- 供应商接口的返回一律走 `toProviderView`：只给 `apiKeyMasked`（首 3 位 + 8 星 + 尾 4 位）与 `apiKeyTail`，
  **不返回 `apiKey`**，并同时剔除 `tenantId`。（当前没有"单个供应商详情"接口，写操作返回的也是这个视图。）
- `POST /api/providers/:id/test` 与 `POST /api/providers/models` 的响应是连通性结果
  （`ok` / `latencyMs` / `status` / `models` / `error`），同样不含凭据。
- 客户端自带的 `Authorization` / `x-api-key` 不会被转发给上游 —— 网关头只用于校验本服务令牌。
  上游鉴权头由网关重新生成：`openai` 与 `responses` 注入 `Authorization: Bearer <上游 Key>`，
  `anthropic` 注入 `x-api-key` + `anthropic-version`。
- 日志器按 key 名（`apikey` / `authorization` / `token` / `password` / `secret` 等）打码，
  并把 `sk-xxx`、`Bearer xxx` 形式的字符串截断。但这是兜底，不要主动把密钥写进日志。

## 会碰你的文件系统与进程

这是本工具最需要知情的地方：

- 只有点击"应用配置"时才会写 `~/.codex/config.toml`、`~/.codex/auth.json`、
  `~/.codex/llmapi-model-catalog.json` 与 `~/.claude/settings.json`
  （或 `AGENT_HOME_DIR` 下的对应路径）。
- 其中 `llmapi-model-catalog.json` 是 Codex 的模型目录，由我们从当前聚合别名**整份生成**
  （不做按键合并）；应用前若已存在会被备份，还原时按"是否由我们创建"决定删除或重置为 `{}`。
- 写入前在**被改文件的同目录**留一份 `*.bak-<时间戳>`（如 `~/.codex/config.toml.bak-...`）——
  备份要能在本服务停掉、数据目录丢失时仍然可用。
- 只改自己拥有的键，其余内容原样保留；文件解析失败则中止，不写空文件。
- 还原只撤销"值仍等于我们写入值"的键，被手改过的键保留并报告冲突。
- **会结束进程**：`POST /api/agents/:id/stop-processes`（权限 `agents:apply`）会执行
  `codex app-server daemon stop`，并向匹配到的 `codex` / `codex exec` 进程发 `SIGTERM`
  （300ms 后仍在的补 `SIGKILL`）。它只认可执行文件名恰好是 `codex` 的进程，
  不碰 `mycodex`、编辑器插件、`codex --version` 这类一次性命令；Claude Code 不受影响。
  这意味着"点一个按钮"就可能中断你正在跑的 Codex 会话。

## 同步快照的威胁模型

多设备配置同步（[sync.md](./sync.md)）会跨机传输**上游 API Key 的明文**。这不是疏忽，
是唯一可行的做法：`enc:v1:` 密文绑定本机 `DATA_ENCRYPTION_KEY`，换个密钥解不开。
于是设计上必须承认"快照本身就是一份凭据"，并据此收紧三处。

### 为什么 `sync:read` 单独成权限

`GET /api/sync/snapshot` 是**唯一**能把全部上游 Key 明文导出的接口。如果它复用
`settings:write`，就等于把两件风险差着数量级的事绑成一个授权项：

- "能改默认模型" —— 改错了再改回来即可；
- "能一次性导走我所有付费凭据" —— 导走之后无法追溯、无法撤回。

拆开后可以把"改设置的人"与"能导出凭据的人"分开授权。代价是 `admin` 默认没有它，
需要 owner 显式创建带 `sync:read` 的 API 令牌。

它**可以**授予 API 令牌（不在 `UNGRANTABLE` 里），因为 follower 拉取必须用令牌而不是
登录会话；但仍受"只收窄、不提权"约束——只有本身持有 `sync:read` 的账号才能创建它。
这意味着一个 `sync:read` 令牌等价于"全部上游 Key 的离线副本"，要像对待 root 凭据一样
对待它：设 `expiresAt`，用完吊销。

### 为什么强制 HTTPS

`assertSecureTransport` 检查**本次请求的实际协议**（`request.protocol`）：非 `https:`
且 Host 不是回环时返回 **403**。理由是快照在链路上就是明文 Key，走明文 HTTP 等于把它
扔进同一网段的抓包范围。

两处必须知道的细节：

- **它刻意不看 `ctx.config.publicBaseUrl`。** 那个值在未配置时由监听地址推导，
  `HOST=0.0.0.0` 会得到 `http://127.0.0.1:8787`——看起来是回环于是放行，而服务其实
  对外监听，明文请求照样能取走全部上游 Key。即便显式配了 `https://…`，那也只是用户声明，
  与实际链路无关。用"我不知道真实地址"来自证清白是不成立的。
- **依赖 `TRUST_PROXY=1` 才能识别反代后的 HTTPS。** 反向代理回源本身是 HTTP，
  不开这个开关时 Fastify 看不到 `X-Forwarded-Proto`，检查会把正常的 HTTPS 部署判成明文。
  它只把 `trustProxy` 设成 `'loopback'`（只信任来自本机回环的转发头），
  **不能设成 `true`**——那样任何客户端都能伪造该头绕过检查。

follower 侧有一道对称的检查：`assertMasterUrlAllowed` 在保存配置与 `pull` 时都校验
`masterUrl` 协议，非回环的 `http://` 直接 403。少了它，follower 会把 master 的 API 令牌
与拉回的明文 Key 一起走明文 HTTP 送出去。

`SYNC_ALLOW_INSECURE=1` 是给可信内网（如 EasyTier 隧道）留的显式逃生门：默认必须由人
主动设置，而不是猜测"这可能是内网所以放过"。配套的还有 `cache-control: no-store`，
以及日志只记"谁导出了几个范围、多少条"而绝不记 body。

### 为什么冲突文件里脱敏

`sync-conflicts.json` 是普通 JSON 文件（不在 `secrets.encode()` 的保护范围内），
还会经 `GET /api/sync/conflicts` 返回给前端。若把两版的 Key 原值写进去，冲突文件就变成
凭据的第二份副本，而且生命周期不受控——用户解决完冲突也不会想到去删它。

所以落盘与出接口的 `localValue` / `remoteValue` 都只保留 `***` + 末 4 位
（`toComparable` / `pickSettings`）。但"用远端版"必须能真正写回对方的密钥，于是另存
`remoteValueSealed`——远端完整值的本机密文。它既能还原，又不会成为明文副本，
且**不出现在任何接口响应里**（`GET /api/sync/conflicts` 不含该字段）。

> 打码尾部对本地版来自密文、对远端版来自明文，本来就不对应。它只够做
> "看起来是不是同一个"的粗判断，不能当相等性依据。

### 已知残留风险

- **快照导出没有频率限制，也不留独立审计**：只有一行 info 日志（`by` / `via` /
  `scopes` / 条数）。导出过的数据无法召回。
- **follower 侧令牌只在前缀上被校验**（必须以 `api_` 开头），不落盘、不进设置文件。
- **没有传输重试与完整性校验**：快照没有签名，链路被中间人替换内容时无法察觉
  （HTTPS 是唯一防线）。

## 部署风险清单

| 风险 | 缓解 |
| --- | --- |
| 监听 `0.0.0.0` 且无 TLS | 放在 HTTPS 反代后；Cookie 在 https 下自动加 `Secure` |
| 未设 `DATA_ENCRYPTION_KEY` | 启动日志 + `/api/health` 持续告警；建议设置 |
| 网关令牌泄漏 | 重置令牌；令牌只存哈希，泄漏面仅限使用方能消费模型 |
| **API 令牌泄漏** | 立即 `DELETE /api/tokens/:id` 吊销（记录保留可追溯）；泄漏面等于它 `scopes` 里的那些权限。所以按需最小授权、能设 `expiresAt` 就设 |
| `ENABLE_DIAGNOSTICS=1` 误开在生产 | 它会回显 prompt 片段并真实打上游；排查完就关掉（未设置时接口返回 404，不是常开项） |
| 服务进程权限过大 | 它以当前 OS 用户的身份运行，能写该用户的家目录、并能结束该用户的 Codex 进程；考虑用专用用户运行 |
| 数据目录被他人读取 | 文件权限 0600；确保 `data/` 所在目录不被其他人遍历 |
| 多实例共享 `data/` | 不支持，会造成写入竞争；单实例部署 |
| 反向代理缓冲 SSE | 关闭 `proxy_buffering`，否则流式响应被攒住 |

## 不做的事

- 不做多因素认证、不做 OAuth 登录、不做细粒度对象级 ACL（权限只到"类"这一级）。
- 不加密 `requests.jsonl`（其中不含凭据，但含模型名与供应商名，自行评估敏感性）。
- 不对上游证书做额外校验控制（使用 Node 默认 HTTPS 校验）。

## API 令牌的安全边界

### 两套令牌不要混

`api_`（管理面）与 `lam_`（推理转发）是两条独立鉴权路径，前缀分开是刻意的：
日志里能一眼看出是哪类凭据泄露，处置方式也不同（前者吊销令牌即可，
后者还要检查 Agent 配置里是否被写进了上游真实 Key）。

混用的结果是 401，不是"部分可用"：

- `lam_` 调 `/api/*`：管理面只从 `Authorization: Bearer` 里接受 `api_` 前缀的令牌，
  `lam_` 会被当成无效凭据（`parseBearerToken` 直接返回 null）。
- `api_` 调 `/v1/*`：网关走的是 `gateway/auth.ts`，只比对租户设置里的网关令牌哈希，
  `api_` 永远匹配不上。

也就是说**没有哪套令牌能同时干两件事**。想让脚本既能转发又能管配置，就建两个。

### 只收窄、不提权

令牌的 `scopes` 必须是创建者权限的子集，创建时校验。判定时**只看 scopes、忽略角色**
（`policy.ts` 的 `can`）：若还叠加角色权限，那么创建一个"只读令牌"反而会拿到创建者的全部权限，
收窄就形同虚设。

`users:manage` / `tenants:manage` 不允许授予任何令牌：当前没有接口使用这两项，
开放只会扩大风险面。

### 为什么令牌不能改口令

`authenticated` 级接口（`/api/auth/me`、`/api/auth/password`）假设操作者是真人会话。

注意 `/api/auth/me` 还额外返回了 `language`：它**读**的是租户设置，却没有要求
`settings:read`。这是有意的——`member` 角色没有 `settings:read`，但同样得看到
正确语言的界面。语言偏好不是敏感数据（它不泄漏供应商、令牌或其它配置），
写它仍然要 `settings:write`。
令牌能被用来读 `me` 本身危害不大，但同一个级别里还有改口令，两者共用一条规则：
**令牌访问 `authenticated` 级接口一律 403**。这样做的理由是改口令——凭据泄露后攻击者
可以永久接管账号，吊销令牌也救不回来（口令已被改）。

同理，令牌不能创建或吊销令牌：否则一个即将被吊销的令牌可以先给自己留一个后门。

### 存储

- 只存 `sha256(token)`，比对用 `timingSafeEqual`（防时序侧信道）。
- 明文只在创建响应里出现一次，不写日志、不进列表。**丢了就找不回**，只能吊销重建。
- 数据文件 `data/tenants/<id>/api-tokens.json` 由 `jsonFile.ts` 原子写入、权限 0600。
- 吊销是置 `revokedAt` 而非删除：保留记录才能解释"某个令牌曾经存在过"。
- 空 `scopes` 的令牌在校验阶段就被拒绝，避免出现"创建了但什么都干不了"的困惑令牌。

### 已知限制

- **多租户下的令牌查找**：令牌按租户分文件存放，鉴权时还不知道属于哪个租户。
  当前只有默认租户所以直接查它；做多租户时需要一张全局 `hash → tenantId` 索引，
  否则必须遍历所有租户（慢且随租户数线性增长）。
- **没有 IP 白名单、没有令牌轮换**：只支持吊销后重建。
- **`lastUsedAt` 只有分钟级精度**：按 60 秒节流更新，不能用它做精确审计。

