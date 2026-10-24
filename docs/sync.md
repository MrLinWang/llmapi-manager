# 多设备配置同步

一台机器配好供应商与 Agent 设置，其余设备跟随，省掉逐台重配。

典型场景：先在一台 Linux 服务器上配好全部供应商、模型与 Agent 连接方式，再让 Windows
端拉过去。两端 Codex 于是指向同一处，`codex` 的 SSH 远程能力才能两边都工作——否则每台
都要重填一遍 Key，且两边配置一旦分叉，排查问题时会先怀疑错方向。

角色分 `standalone` / `master` / `follower` 三种。默认 `standalone`：不开启时行为与没有
这个功能时**完全一致**，不会因为升级就突然开始对外提供快照接口或定时联网。

## 三个刻意的边界

这三条决定了后面所有的实现细节，先看它们再看接口：

1. **不传 `DATA_ENCRYPTION_KEY`。** 每台机器自己的密钥独立，跨机传的永远是明文，
   落地时用本机密钥重新加密（见「凭据为什么必须明文过网」）。
2. **不同步登录口令与会话。** 否则一台机器被入侵等于全部沦陷。
3. **不覆盖有本地改动的项。** 冲突保留双版本由人仲裁——配置被静默改掉，比报错更难查。

## 角色

| 角色 | 做什么 | 默认 |
| --- | --- | --- |
| `standalone` | 什么都不做，与未启用该功能相同 | ✅ |
| `master` | 对外提供 `GET /api/sync/snapshot`，导出勾选范围的快照 | |
| `follower` | 主动拉取 master 的快照并应用到本地 | |

master 不主动推送。推送需要 master 知道所有 follower 的地址，那反而要求每个 follower
都对外可达，与「多设备互联」的初衷相反——所以方向固定为 follower 拉。

选 `follower` 时必须同时填 master 地址，保存时就拦下（`400`），而不是等到点「立即同步」
才报错：配置漏项越早暴露越好。

## 同步范围

`scopes` 决定拉取时同步哪些内容。前端勾选项由 `GET /api/sync/status` 的 `availableScopes`
下发，文案只在 `server/src/domain/sync.ts` 维护一份，避免两处各写一套。

| scope | 内容 |
| --- | --- |
| `providers` | 供应商与模型（含上游 API Key，跨机重新加密） |
| `settings` | 网关设置（默认模型、跨协议转发、审批模型等） |
| `agentTargets` | Agent 连接方式（走网关 / 直连） |

> **空 `scopes` 实际会被当作「全部范围」。** 领域层的注释（`domain/sync.ts`）写的是
> "空数组表示什么都不动"，但路由实现不是这样：`GET /api/sync/snapshot` 与
> `POST /api/sync/pull` 都回落成 `[...SYNC_SCOPES]`
> （`config.scopes.length > 0 ? config.scopes : [...SYNC_SCOPES]`）。想"什么都不动"
> 只能不触发拉取，不能靠清空勾选达到。**以路由实现为准**，这处注释与代码不一致。

### 永远不同步的东西

`GET /api/sync/status` 的 `neverSynced` 会把这四项原样告诉前端，界面直接展示：

| 不同步 | 为什么 |
| --- | --- |
| 登录口令 | 同上，一台机器被入侵不应导致全部账号沦陷 |
| 会话 cookie | 会话签名密钥是本机 `instance.json` 的，传过去也验不过 |
| `DATA_ENCRYPTION_KEY` | 密文绑定本机密钥；且密钥本身就是最高价值目标 |
| 网关令牌 | 每台机器要有自己的一份：共用会让泄露面翻倍，且无法单独吊销 |

`settings` 快照里刻意不含 `gatewayToken`；应用快照时也**只覆盖**那五个网关设置字段，
`gatewayToken` 保留本地（`services/sync.ts` 的 `next` 对象里没有它）。这条有测试固定：
「不覆盖本机的网关令牌」。

## 凭据为什么必须明文过网

这是整个功能最反直觉的一处，也是所有安全措施的来源。

落盘的 API Key 形如 `enc:v1:<iv>:<tag>:<ciphertext>`，由本机 `DATA_ENCRYPTION_KEY`
派生的密钥加密。**把这段密文原样传给另一台机器是没用的**——对方的密钥不同，解不开，
只会得到一份读不出来的凭据。所以跨机的唯一可行路径是：

```
master  decode() → 明文 → TLS 传输 → follower  encode()（用本机密钥）→ 落盘
```

`SyncService.exportSnapshot` 因此是全仓库唯一一处**有意**把凭据明文放进出口函数的地方
（`apiKey` 明文出参）。它带来的三条硬性约束：

- **强制 HTTPS**。`assertSecureTransport` 读的是**本次请求的实际协议**
  （`request.protocol`，配合 `trustProxy` 采信 `X-Forwarded-Proto`），不是配置文件里的
  `PUBLIC_BASE_URL` 字符串。非 `https:` 且 Host 不是回环时返回 **403**
  （`forbidden`，不是 409），并给出两种可操作的解法。宁可让用户看到报错，也不要让他
  以为链路是加密的——在明文 HTTP 上给出去，等于把全部上游凭据扔进同网段的抓包范围。
  可信内网（例如 EasyTier 隧道内）可设 `SYNC_ALLOW_INSECURE=1` 显式跳过。
- **`no-store`**。响应头带 `cache-control: no-store` 与 `pragma: no-cache`，
  禁止任何代理或浏览器缓存留下这份响应体。
- **日志不记 body**。导出只记一行"谁、用什么渠道、导出了几个范围、多少条供应商"
  （`by=… via=… scopes=… providers=N`），绝不记内容。

> **为什么不能看配置。** 早先的实现检查 `ctx.config.publicBaseUrl`，有两个致命问题：
> ① 该值在未配置时由监听地址推导，`HOST=0.0.0.0` 会得到 `http://127.0.0.1:8787`，
> 看起来是回环于是放行——而服务其实对外监听，明文请求照样能取走全部上游 Key；
> ② 即便显式配了 `https://…`，那也只是用户声明，与实际链路是否加密无关。
>
> 配套要求：反向代理后必须设 `TRUST_PROXY=1`，且它只把 `trustProxy` 设为
> `'loopback'`（只信任来自本机回环的转发头）。**不能设成 `true`**，否则任何客户端
> 都能伪造 `X-Forwarded-Proto: https` 绕过检查。

follower 侧另有一道对称的检查：`assertMasterUrlAllowed` 在保存配置与 `pull` 时都校验
`masterUrl` 的协议，非回环的 `http://` 直接 403。少了它，follower 会把 master 的
API 令牌与拉回的明文 Key 一起走明文 HTTP 送出去。

## 冲突：为什么不直接覆盖

配置被静默改掉是最难排查的一类问题：用户看着界面上的值，以为是自己的设置，实际早就
被另一台机器覆盖了，症状要到某次请求失败才显现。所以冲突**保留双版本**，由人选一个。

判定规则（`services/sync.ts` 的 `applySnapshot`）：

- 只比时间戳不安全——「改完又改回来」会被误判成冲突。所以同时比内容。
- `providers`：`localChanged = 内容不同 && 本地不比远端旧`（`compareTime(…) >= 0`）
  → 冲突；否则用远端覆盖。
  **时间戳相同但内容不同也算冲突**：无法判断谁先改，交给人工裁决比赌一个方向安全。
  原实现走"直接覆盖"分支，等于静默丢掉本地改动，正是这个功能声称要避免的情况。
- `settings`：整体一份，粒度粗。本地 `updatedAt` 更晚且任一字段不同 → 冲突，否则整体覆盖。
- `agentTargets`：**不产生冲突**，字段不同就直接用远端值。
- 时间比较走 `compareTime`（`Date.parse` 成数值再比），不是字符串比较——
  带不同时区偏移的 ISO 字符串按字符串比会得到错误结论。

冲突一旦产生就**累积**，不覆盖已有的：多次拉取产生的冲突都要能被人看到，直到逐条仲裁。

### `remoteValueSealed` 为什么存在

冲突文件 `sync-conflicts.json` 落盘，且经 `GET /api/sync/conflicts` 返回给前端。把凭据
原值放进去等于多出一份明文副本，而且它不在 `secrets.encode()` 的保护范围内。

两边因此都只存**打码形态**（`toComparable` / `pickSettings`，Key 只留 `***` + 末 4 位）。
但用户选「用远端版」时必须能把对方的密钥真正写进来——所以另存一份完整值，
用本机 `secrets.encode()` 加密（`remoteValueSealed`）。

**未配置 `DATA_ENCRYPTION_KEY` 时它不封存**（`sealRemoteValue` 在
`secrets.encrypted === false` 时返回 `null`）：此时 `encode()` 是恒等变换，写进去等于
明文落盘。代价是那一轮冲突只能"用本地"，仲裁 `remote` 会抛
`SyncSealedUnavailableError`，接口返回 400 并提示去配密钥后重新拉取。

`remoteValueSealed` **不出现在任何接口响应里**：`GET /api/sync/conflicts` 会把它剔除——
给一个只需要 `settings:read` 的人看凭据副本没有意义。

> 打码后的尾部对本地版来自**密文**、对远端版来自**明文**，两者本来就不对应。
> 这个字段只够做"看起来是不是同一个"的粗判断，不能当作相等性依据。

## 接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/sync/status` | `settings:read` | 角色、范围清单、冲突数、永不同步项 |
| PATCH | `/api/sync/config` | `settings:write` | 改角色 / master 地址 / 范围 |
| GET | `/api/sync/snapshot` | **`sync:read`** | master 导出快照（含明文 Key） |
| POST | `/api/sync/pull` | **`sync:write`** | follower 拉取并应用 |
| GET | `/api/sync/conflicts` | `settings:read` | 待仲裁列表 |
| POST | `/api/sync/conflicts/:id/resolve` | **`sync:write`** | `{ choice: 'local' \| 'remote' }` |

字段与示例见 [api.md](./api.md#配置同步)。

### 为什么 `sync:read` 要单独成权限

快照导出用独立的 `sync:read`，理由只有一个：**它是这套权限里唯一能把全部上游 API Key
明文导出去的接口**。合进 `settings:write` 会带来一个说不清的后果——"能改默认模型的人"
与"能导走我所有付费凭据的人"变成同一个授权项，而这两件事的风险差着几个数量级。

`sync:read` 与 `sync:write` 的不对称是刻意的：

| 权限 | 能做什么 | 风险 | owner | admin |
| --- | --- | --- | --- | --- |
| `sync:read` | 导出快照 | 全部上游 Key 明文外流 | ✅ | ❌ |
| `sync:write` | 拉取、仲裁冲突 | 与"改设置"同级（改的是本机自己的配置） | ✅ | ✅ |

所以 `admin` 能当 follower 拉取、能仲裁冲突，但**不能对外提供快照**。这正是
"只收窄、不提权"的一个具体应用。

`sync:read` 可以授予 API 令牌（不在 `routes/apiTokens.ts` 的 `UNGRANTABLE` 里），
因为 follower 拉取必须用令牌而不是登录会话；但仍受"只收窄、不提权"约束——
只有本来持有 `sync:read` 的账号才能创建这样的令牌。这意味着一个 `sync:read` 令牌
等价于"全部上游 Key 的离线副本"，要像对待 root 凭据一样对待它。

`status` / `config` / `conflicts` 三个接口继续用 `settings:*`：它们只读写本机的
同步偏好与冲突列表，不导出凭据。

## 操作步骤

### 1. 在 master 上

1. 配好供应商、模型、默认供应商、Agent 连接方式。
2. 设置页把角色改为 `master`（界面会有二次确认：之后本机开始对外提供快照接口，
   而快照里是上游 Key 明文）。
3. 勾选要同步的范围。
4. 到「API 令牌」创建一个**含 `sync:read`** 的令牌，复制明文（只显示一次）。

master 必须是 HTTPS（或回环地址），否则导出时直接 403。反向代理后还要设
`TRUST_PROXY=1`，否则网关看到的是代理转发来的 HTTP，同样会被拦下。

### 2. 在 follower 上

1. 设置页把角色改为 `follower`，填 master 地址（如 `https://box.example.com:8787`），
   必须在保存时一起填，否则 400。地址协议会在保存时就校验：非回环的 `http://` 直接 403。
2. 勾选范围（与 master 侧一致才有意义；空 = 全部）。
3. 填上一步拿到的 API 令牌，点「立即同步」。
4. 看返回的摘要：应用了多少项、产生多少冲突。`lastPullAt` / `lastPullResult` 会留档
   在设置里，供界面显示。

令牌只在这一步使用，**不落盘**（`pull` 的 token 来自请求体，不进设置文件）。

### 3. 仲裁冲突

有待仲裁项时列表页顶部常驻告警。每条冲突并列显示本地版与远端版，`changedFields`
标出哪些字段不同：

- **用本地**：不改数据，只把这条冲突标记为已解决（本地版就是现值）。
- **用远端**：解封 `remoteValueSealed`，用远端版覆盖这一条，然后移除冲突。
  本机未配置 `DATA_ENCRYPTION_KEY` 时没有封存值，这条路会报错并提示去配密钥。

## 已知限制

- **单向**：只有 master → follower。follower 上的改动不会回流，想统一就在 master 上改。
- **不实时**：只在点「立即同步」时拉一次，没有定时、没有推送。
- **不删远端没有的供应商**：master 上删掉不会自动清空 follower——那可能是 follower
  自己加的，或 master 还没同步过去的。
- **不检测 master 是否换机**：快照里带了 `masterId`，但应用时并没有消费它，
  换了 master 不会提示。
- **依赖两端时钟**，但不再依赖字符串格式。冲突判定用 `compareTime`（`Date.parse` 成
  毫秒数值后比较），带不同时区偏移或不同格式的 ISO 字符串都能正确比。
  仍要注意：应用快照时两端处理不同——供应商写回的 `updatedAt` 被置为**本机当时**的时间，
  网关设置则沿用远端的 `updatedAt`。
- **没有并发保护**：`pull` 不阻止同时触发两次；`applySnapshot` 内部是同步 IO，
  单次应用不会交错，但两次拉取谁后写谁生效。
- **范围列表由 master 决定**：应用哪些内容看快照里的 `scopes`，follower 的勾选只影响
  请求时传什么 query。
- **配置保存时会校验传输安全**：`PATCH /api/sync/config` 与 `pull` 都会检查 `masterUrl`
  协议（`assertMasterUrlAllowed`），所以填一个非回环的 `http://` 地址会当场 403，
  而不是等到同步时才发现。`SYNC_ALLOW_INSECURE=1` 时两侧都不设防。
