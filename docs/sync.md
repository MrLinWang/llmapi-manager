# 多设备配置同步

一台机器配好供应商与 Agent 设置，其余设备跟随，省掉逐台重配。

典型场景：先在 Linux 服务器上配好全部供应商、模型与 Agent 连接方式，再让 Windows
端拉过去。两端 Codex 于是指向同一处，`codex` 的 SSH 远程能力才能两边都工作——否则每台
都要重填一遍 Key，且两边配置一旦分叉，排查问题时会先怀疑错方向。

角色分 `standalone` / `master` / `follower` / `peer` 四种。默认 `standalone`：不开启时
行为与没有这个功能时**完全一致**，不会因为升级就突然开始对外提供快照接口或定时联网。

## 四种角色与双向语义

| 角色 | 对外提供快照 | 拉取对端 | 默认 |
| --- | --- | --- | --- |
| `standalone` | 否 | 否 | ✅ |
| `master` | 是（只提供） | 否 | |
| `follower` | 否 | 是（只拉取） | |
| `peer` | 是 | 是 | |

- **`master`**：只响应 `GET /api/sync/snapshot`，把勾选范围的配置导出给对端。
- **`follower`**：只发起 `POST /api/sync/pull`，把对端快照应用到本地。
- **`peer`**：两种都做。它既是对端的快照源，也会拉取对端。

**「双向」仍然是拉，不是推。** 没有任何一端会主动把配置推给另一端：推送要求发送方知道
所有对端地址，反而逼着每台机器都对外可达，和「多设备互联」的初衷相反。所以双向同步的
实际形态是：A 和 B 都设 `peer`、各自填对方的地址、各自用对方的令牌，**A 点一次同步把 B
的改动拉到 A，B 再点一次把 A 的改动拉到 B**。一次拉取只改变发起方。

`masterUrl` 字段名保持不变（兼容已落盘的 `settings.json`），语义是「对端地址」。
`follower` 与 `peer` 都必须填，保存时就返回 400（`sync.masterUrl.requiredForFollower` /
`sync.masterUrl.requiredForPeer`），而不是等点「立即同步」才报错：配置漏项越早暴露越好。
**两端都是 `peer` 时，各自都要填对方的地址**：双方既是提供方又是拉取方，只填一端等于
另一台没有可拉的对象。

> 角色只影响「能不能提供/拉取」，不影响权限。真正决定一个账号能不能调接口的是
> `sync:read` / `sync:write`（见[为什么 `sync:read` 要单独成权限](#为什么-syncread-要单独成权限)）。
> 例如 `admin` 有 `sync:write` 能拉取，但没有 `sync:read`，所以即使把角色设成 `peer`，
> 它提供的快照接口也会 403。

## 三个刻意的边界

这三条决定了后面所有实现细节，先看它们再看接口：

1. **不传 `DATA_ENCRYPTION_KEY`。** 每台机器自己的密钥独立，跨机传的永远是明文，
   落地时用本机密钥重新加密（见[凭据为什么必须明文过网](#凭据为什么必须明文过网)）。
2. **不同步登录口令与会话。** 否则一台机器被入侵等于全部沦陷。
3. **不覆盖有本地改动的项。** 双方都改过的项保留双版本交给人仲裁——配置被静默改掉，
   比报错更难查。

## 手动拉取

同步是**手动动作**，没有定时任务、没有后台轮询、没有推送：

- 点一次「立即同步」才拉一次；不点就不会有网络请求。
- 拉取结果记在 `settings.sync` 的 `lastPullAt` / `lastPullResult` / `lastMasterId` 里，
  界面据此显示「上次结果」。
- **拉取令牌只来自请求体**（`POST /api/sync/pull` 的 `token` 字段），不落盘、不进
  `settings.json`。每次拉取都要重新填/带上；服务重启后也不会「记住」上次用的令牌。
- 拉取用对端账号创建的、含 `sync:read` 的 API 令牌（`api_` 前缀）；令牌明文只在创建时
  出现一次，丢了只能吊销重建。

**换机会被提示**：快照里带 `masterId`（对端的实例标识）。拉取时与本地记录的
`lastMasterId` 比对，换了机器会在本次摘要里提示重新核对；**首次拉取只建立基线，
不报换机**（旧实现把空基线也当成换机，属于误报）。`masterUrl` 相同不代表是同一台机器：
反向代理下两台机器可能配同一个对外地址。

## 同步范围

`scopes` 决定同步哪些内容。前端勾选项由 `GET /api/sync/status` 的 `availableScopes`
下发，文案只在 `server/src/domain/sync.ts` 维护一份，避免两处各写一套。

| scope | 内容 |
| --- | --- |
| `providers` | 供应商与模型（含上游 API Key 跨机重新加密），以及 `imageModels`（生图模型）与 `modelCapabilities`（逐模型的上下文/输出上限、推理档位、输入模态） |
| `settings` | 网关设置：默认供应商/模型、审批模型、跨协议转发、`disableCodexWebSearch`，以及两个 Codex 流式字段 `codexStreamMaxRetries` / `codexStreamIdleTimeoutMs` |
| `agentTargets` | 每个 Agent 的连接方式（`mode` / `directProviderId` / `directModel`），带各自的 `updatedAt` |

**空 `scopes` 不是「全部」。** 导出与拉取都会以 400 拒绝：

| 场景 | 错误键 |
| --- | --- |
| master/peer 导出时 `scopes` 为空 | `sync.scopes.emptyForExport` |
| follower/peer 拉取时 `scopes` 为空 | `sync.scopes.emptyForPull` |

这是有意的安全默认：用户什么都没勾时，系统不能擅自把全部上游 Key 导出去。想「什么都不动」
就不要触发同步，而不是靠清空勾选达到。

拉取时 follower / peer 会把**自己勾选的** scopes 作为查询参数发给对端；对端以查询参数为准
（缺省用它自己的勾选）。最终应用哪些内容，看**快照里的 `scopes`**——对端没导出的 scope
不会改变本地。

### 永远不同步的东西

`GET /api/sync/status` 的 `neverSynced` 会把它列的四项原样告诉前端，界面直接展示；
下面后三项虽然不在那句提示里，但同样不进快照、也不参与内容哈希：

| 不同步 | 为什么 |
| --- | --- |
| 登录口令 | 一台机器被入侵不应导致全部账号沦陷 |
| 会话 cookie | 会话签名密钥是本机 `instance.json` 的，传过去也验不过 |
| `DATA_ENCRYPTION_KEY` | 密文绑定本机密钥；且密钥本身就是最高价值目标 |
| 网关令牌 | 每台机器要有自己的一份：共用会让泄露面翻倍，且无法单独吊销 |
| 界面语言 `language` | 每台机器的显示偏好，不该互相覆盖；且它是「界面文案」不是「网关配置」 |
| 同步设置 `sync` 本身 | 否则一次拉取会改掉对端的角色、地址与勾选，等于让远端决定本机行为 |
| 组网设置 `networking` | 含组网密钥与虚拟 IP，属于本机网络环境，不随配置漂移 |

`settings` 快照里刻意不含 `gatewayToken`；应用快照时也**只覆盖**上表 `settings` 那一行
列出的字段，`gatewayToken`、`language`、`sync`、`networking` 保留本地。

## 凭据为什么必须明文过网

这是整个功能最反直觉的一处，也是所有安全措施的来源。

落盘的 API Key 形如 `enc:v1:<iv>:<tag>:<ciphertext>`，由本机 `DATA_ENCRYPTION_KEY`
派生的密钥加密。**把这段密文原样传给另一台机器是没用的**——对方的密钥不同，解不开，
只会得到一份读不出来的凭据。所以跨机的唯一可行路径是：

```
对端  decode() → 明文 → TLS 传输 → 本机 encode()（用本机密钥）→ 落盘
```

`SyncService.exportSnapshot` 因此是全仓库唯一一处**有意**把凭据明文放进出口函数的地方
（`apiKey` 明文出参）。它带来的三条硬性约束：

- **强制 HTTPS**。`assertSecureTransport` 读的是**本次请求的实际协议**
  （`request.protocol`，配合 `trustProxy` 采信 `X-Forwarded-Proto`），不是配置文件里的
  `PUBLIC_BASE_URL` 字符串。非 `https:` 且 Host 不是回环时返回 **403**
  （`sync.snapshot.mustUseHttps`），并给出可操作的解法。宁可让用户看到报错，也不要让他
  以为链路是加密的——在明文 HTTP 上给出去，等于把全部上游凭据扔进同网段的抓包范围。
  可信内网（例如 EasyTier 隧道内，或家用局域网）可设 `SYNC_ALLOW_INSECURE=1` 显式跳过。
- **`no-store`**。响应头带 `cache-control: no-store` 与 `pragma: no-cache`，
  禁止任何代理或浏览器缓存留下这份响应体。
- **日志不记 body**。导出只记一行「谁、用什么渠道、从哪来、导出了几个范围、多少条供应商」
  （`by=… via=… from=… scopes=… providers=N`），绝不记内容。

> **为什么不能看配置。** 早先的实现检查 `ctx.config.publicBaseUrl`，有两个致命问题：
> ① 该值在未配置时由监听地址推导，`HOST=0.0.0.0` 会得到 `http://127.0.0.1:8787`，
> 看起来是回环于是放行——而服务其实对外监听，明文请求照样能取走全部上游 Key；
> ② 即便显式配了 `https://…`，那也只是用户声明，与实际链路是否加密无关。
>
> 配套要求：反向代理后必须设 `TRUST_PROXY=1`，且它只把 `trustProxy` 设为
> `'loopback'`（只信任来自本机回环的转发头）。**不能设成 `true`**，否则任何客户端
> 都能伪造 `X-Forwarded-Proto: https` 绕过检查。

拉取侧另有一道对称的检查：`assertMasterUrlAllowed` 在保存配置与 `pull` 时都校验
`masterUrl` 的协议，非回环的 `http://` 直接 403（`sync.masterUrl.insecure`）。少了它，
发起方会把对端的 API 令牌与拉回的明文 Key 一起走明文 HTTP 送回去。
`SYNC_ALLOW_INSECURE=1` 时两侧都不设防——**这个开关要在两端都设**，只设一端仍会被另一端拦下。

## `sync-state.json`：三方合并的基线

每台机器在 `data/tenants/<tenantId>/sync-state.json` 记录「上次同步后，每一类数据的
内容指纹」。路径由 `StorePaths.syncStateFile(tenantId)` 提供，经 `TenantRepos.syncState`
读写；**不暴露任何 API**，前端也看不到它。

```json
{
  "schemaVersion": 1,
  "data": {
    "entries": [
      { "scope": "providers", "targetId": "<provider id>", "hash": "<sha256 hex>" },
      { "scope": "settings", "targetId": "settings", "hash": "<sha256 hex>" },
      { "scope": "agentTargets", "targetId": "codex", "hash": "<sha256 hex>" }
    ],
    "updatedAt": "2026-10-29T00:00:00.000Z"
  }
}
```

`hash` 是**规范内容**的 SHA-256（十六进制）。规范内容只包含确实需要参与同步的字段：

| scope | 参与哈希 | 排除 |
| --- | --- | --- |
| Provider | `name` / `providerKey` / `apiType` / `baseUrl` / **明文 `apiKey`** / `models` / `imageModels` / `modelCapabilities` / `enabled` / `priority` / `notes` / `websiteUrl` | `updatedAt` / `createdAt` / `createdBy` / `lastTest` / `tenantId` |
| Settings | `defaultProviderId` / `defaultModel` / `approvalReviewModel` / `protocolConversion` / `disableCodexWebSearch` / `codexStreamMaxRetries` / `codexStreamIdleTimeoutMs` | `updatedAt` / `gatewayToken` / `language` / `sync` / `networking` / `agentTargets` |
| AgentTarget | `mode` / `directProviderId` / `directModel` | `updatedAt` |

对象按键名排序、`modelCapabilities` 的档位数组排序（顺序来自探测过程，不代表内容），
保证「内容相同」一定得到相同哈希（否则键序或数组顺序不同会被误判成改动）。`targetId`
供应商用 `id`、设置用固定串 `settings`、AgentTarget 用 `agentId`。

**为什么要基线（base）。** 只比较本地与远端的两方算法必须靠时间戳猜「谁改的」，而两台
机器的时钟、历史都不保证一致；「改完又改回来」也会被误判。多了 base 之后可以区分四种
情况（只有本地变 / 只有远端变 / 都变成一样 / 都变成不一样），前两种能安全地单向收敛，
只有真正分叉才报冲突。

## 三方合并规则

按 `(scope, targetId)` 逐项处理：`base` 来自 `sync-state.json`，`localHash` / `remoteHash`
由两侧当前内容算出。只处理快照 `scopes` 包含的 scope。

**有 base 时：**

| 情况 | 判定 | 结果 | 计数 |
| --- | --- | --- | --- |
| 两边都没变 | `localHash === base` 且 `remoteHash === base` | 不动 | 否 |
| 只有本地变 | `localHash !== base` 且 `remoteHash === base` | 保留本地，**不推进 base**（等对端也看到这次改动后再收敛） | 否 |
| 只有远端变 | `localHash === base` 且 `remoteHash !== base` | 应用远端，`base = remoteHash` | +1 |
| 两边都变，且结果相同 | 两个 hash 都变但相等 | 收敛，`base = remoteHash` | +1 |
| 两边都变，且结果不同 | 两个 hash 都变且不等 | 冲突，保留本地，不推进 base | 否 |

**没有 base（首次同步，或新增记录）时：**

| 情况 | 结果 | 计数 |
| --- | --- | --- |
| 内容相同 | 只补 `base = localHash` | 否 |
| 内容不同，本地不早于远端（**含相等**） | 冲突，保留本地 | 否 |
| 内容不同，本地早于远端 | 应用远端，`base = remoteHash` | +1 |

「本地/远端谁更新」只看这一种情况：首次同步没有历史基线，只能沿用 `updatedAt` 启发式。
时间戳相同时无法判断谁先改，判冲突比赌一个方向安全。比较**先把 ISO 字符串
`Date.parse()` 成数值**，不按字典序——`+08:00` 与 `Z` 混用时字符串比较会得出相反结论。

应用远端时**保留远端的 `updatedAt`**（供应商、设置、AgentTarget 都是），只有本地新建的
记录用 `now`。这样下一次比较的基准和两侧一致，不会因为「每次拉取都刷新时间戳」而让
冲突判定永久失真。

## 冲突与仲裁

配置被静默改掉是最难排查的一类问题：用户看着界面上的值，以为是自己的设置，实际早就
被另一台机器覆盖了，症状要到某次请求失败才显现。所以冲突**保留双版本**，由人选一个。

规则：

- **每个 `(scope, targetId)` 只保留一条冲突。** 重复拉取时 upsert 远端值、
  `remoteHash`、`remoteUpdatedAt` 与 `changedFields`，不新增重复项。
- **某次拉取发现 `localHash === remoteHash` 时，删除该项已有冲突**：双方已经收敛，
  再让人选一次只会制造噪音。
- 冲突期间**保留本地版**，不计入 `applied`。
- `agentTargets` 也会产生冲突并支持仲裁（此前该 scope 只能整体覆盖、不会冲突）。
- 冲突**累积**，逐条仲裁，不会因为下一次拉取而自动消失（除非收敛）。
- **不删除远端已经删掉的本地记录**：对端的供应商删了，本机不会跟着删——那可能是本机
  自己加的，或对端还没同步过来的。删除需要两端各做一次。

冲突里存的是**打码形态**（`localValue` / `remoteValue`，Key 只留 `***` + 末 4 位），
且经 `GET /api/sync/conflicts` 返回前会剔除内部字段：

- `remoteValueSealed`：远端完整值的本机密文，供「用远端版」时还原，**不出现在任何接口响应里**。
- `remoteHash`：三方合并用的内容指纹，只供服务端判定收敛，**同样不出现在响应里**。

仲裁：

- **用本地**：不改数据，`base = remoteHash`（把这次差异标记为已知），移除该冲突。
- **用远端**：应用远端完整值（供应商会重新加密），`base = remoteHash`，
  本地 `updatedAt` 取远端值；移除该冲突。

**未配置 `DATA_ENCRYPTION_KEY` 时没有 `remoteValueSealed`**（封存会退化成明文落盘）。
代价是那一轮冲突只能「用本地」，选「用远端」会返回 400 `sync.conflict.undecodable`；
去补上密钥后重新拉取一次，远端值会被重新封存。

> 打码后的尾部对本地版来自**密文**、对远端版来自**明文**，两者本来就不对应。
> 这个字段只够做「看起来是不是同一个」的粗判断，不能当作相等性依据。

## 接口

| 方法 | 路径 | 权限 | 允许的角色 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/sync/status` | `settings:read` | 全部 | 角色、对端地址、勾选范围、上次结果、冲突数、`availableScopes`、`neverSynced`，以及四个只读状态位 |
| PATCH | `/api/sync/config` | `settings:write` | 全部 | 改角色 / 对端地址 / 范围；`follower` 与 `peer` 必须带地址 |
| GET | `/api/sync/snapshot` | **`sync:read`** | `master` / `peer` | 导出快照（含明文 Key） |
| POST | `/api/sync/pull` | **`sync:write`** | `follower` / `peer` | 拉取并应用，令牌来自请求体 |
| GET | `/api/sync/conflicts` | `settings:read` | 全部 | 待仲裁列表（已剔除 sealed / remoteHash） |
| POST | `/api/sync/conflicts/:id/resolve` | **`sync:write`** | 全部 | `{ choice: 'local' \| 'remote' }`，支持三个 scope |

`GET /api/sync/status` 的四个只读状态位（供前端置灰按钮、给出可操作提示）：

| 字段 | 含义 |
| --- | --- |
| `canServe` | 当前角色是否对外提供快照（`master` / `peer`） |
| `canPull` | 当前角色是否拉取对端（`follower` / `peer`） |
| `hasSyncRead` | **当前账号**是否持有 `sync:read`（决定它能不能真的导出） |
| `hasSyncWrite` | **当前账号**是否持有 `sync:write`（决定它能不能真的拉取/仲裁） |

它们只用于界面展示，**不参与鉴权**：真正的裁决仍是 `defineRoute` 声明的权限。
角色与权限是两件事——角色对了但缺权限，接口照样 403。

快照结构版本仍是 `schemaVersion: 1`，本次新增的 `imageModels`、`modelCapabilities`、
`codexStreamMaxRetries`、`codexStreamIdleTimeoutMs` 与 AgentTarget 的 `updatedAt`
都是可选字段，旧快照缺字段按默认值处理。拉取前会校验快照：

- 未来版本（`schemaVersion` 高于本机支持）→ 400 `sync.snapshot.futureSchema`；
- 结构错误（`masterId` 为空、`scopes` 含未知值、数组/字段类型不对、供应商 id 重复等）
  → 400 `sync.snapshot.malformed`。

宁可拒绝，也不要用新语义误读旧/坏数据——那会把错误写进本地配置。

字段与请求示例见 [api.md](./api.md)。

### 为什么 `sync:read` 要单独成权限

快照导出用独立的 `sync:read`，理由只有一个：**它是这套权限里唯一能把全部上游 API Key
明文导出去的接口**。合进 `settings:write` 会带来一个说不清的后果——「能改默认模型的人」
与「能导走我所有付费凭据的人」变成同一个授权项，而这两件事的风险差着几个数量级。

`sync:read` 与 `sync:write` 的不对称是刻意的：

| 权限 | 能做什么 | 风险 | owner | admin |
| --- | --- | --- | --- | --- |
| `sync:read` | 导出快照 | 全部上游 Key 明文外流 | ✅ | ❌ |
| `sync:write` | 拉取、仲裁冲突 | 与「改设置」同级（改的是本机自己的配置） | ✅ | ✅ |

所以 `admin` 能当 follower 拉取、能仲裁冲突，但**不能对外提供快照**；即使把角色设成
`peer`，它也只能拉取、不能导出。

`peer` 需要两者兼备：对外提供要 `sync:read`，自己拉取要 `sync:write`。

`sync:read` 可以授予 API 令牌（不在 `UNGRANTABLE` 里），因为对端拉取必须用令牌而
不是登录会话；但仍受「只收窄、不提权」约束——只有本来持有 `sync:read` 的账号才能
创建这样的令牌。这意味着一个 `sync:read` 令牌等价于「全部上游 Key 的离线副本」，
要像对待 root 凭据一样对待它：设 `expiresAt`，用完吊销（见 [security.md](./security.md#同步快照的威胁模型)）。

`status` / `config` / `conflicts` 三个接口继续用 `settings:*`：它们只读写本机的
同步偏好与冲突列表，不导出凭据。

## 操作步骤

### 1. 在对端（master 或 peer）上

1. 配好供应商、模型、默认供应商、Agent 连接方式。
2. 设置页把角色改为 `master`（或 `peer`）。界面会有二次确认：之后本机开始对外提供
   快照接口，而快照里是上游 Key 明文。
3. 勾选要同步的范围（至少一项，否则导出会被拒）。
4. 到「API 令牌」创建一个**含 `sync:read`** 的令牌，复制明文（只显示一次）。

对端必须是 HTTPS（或回环地址，或显式 `SYNC_ALLOW_INSECURE=1`），否则导出时直接 403。
反向代理后还要设 `TRUST_PROXY=1`，否则服务看到的是代理转发来的 HTTP，同样会被拦下。

### 2. 在发起方（follower 或 peer）上

1. 设置页把角色改为 `follower`（或 `peer`），填对端地址（如
   `https://box.example.com:8787`），必须在保存时一起填，否则 400（`peer` 报
   `sync.masterUrl.requiredForPeer`；两端都是 `peer` 时各自填对方的地址）。地址协议会在
   保存时就校验：非回环的 `http://` 且未开 `SYNC_ALLOW_INSECURE` 时直接 403。
2. 勾选范围（至少一项）。
3. 填上一步拿到的 API 令牌，点「立即同步」。本机账号需要 `sync:write`。
4. 看返回的摘要：应用了多少项、产生多少冲突。`lastPullAt` / `lastPullResult` /
   `lastMasterId` 会留档在设置里，供界面显示。

### 3. 双向（两台都设 `peer`）

1. 两端都把角色设为 `peer`，各自填**对方**的地址。
2. 两端各创建一个含 `sync:read` 的令牌，交换填到对方的「令牌」输入框。
3. 在 A 上点「立即同步」：A 用 B 的令牌读 B 的快照，写入 A；在 B 上再点一次，
   反向生效。**一次只同步一个方向**，不会一次拉取就两边都变。
4. 冲突各自在本机仲裁；`sync-state.json` 保证已收敛的项不会反复变成冲突。

### 4. 仲裁冲突

有待仲裁项时列表页顶部常驻告警。每条冲突并列显示本地版与远端版，`changedFields`
标出哪些字段不同：

- **用本地**：不改数据，把这条标记为已解决（本地版就是现值）。
- **用远端**：解封 `remoteValueSealed`，用远端版覆盖这一条，然后移除冲突。
  本机未配置 `DATA_ENCRYPTION_KEY` 时没有封存值，这条路会报错并提示去配密钥。

## Windows 与局域网

Windows 安装包与服务的细节见 [windows.md](./windows.md)。与同步相关的默认值：

| 项 | Windows 服务默认 | 为什么 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 让局域网内其它设备能连到控制台与快照接口 |
| `PORT` | `8787` | 与源码运行一致 |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8787` | 写进**本机** Agent 配置的地址。本机 Agent 走回环最稳，不依赖网卡/IP 变化；只有其它设备的 Agent 也要走这台网关时才改成局域网地址 |
| `AGENT_HOME_DIR` | `C:\Users\<安装用户>` | 服务默认以 LocalSystem 运行，自身家目录是系统配置目录；必须显式指向安装用户的家目录，`.codex` / `.claude` 才会被用户自己的 Codex/Claude Code 读到 |
| 服务账号 | LocalSystem | 安装器需要给服务账号授予 `AGENT_HOME_DIR\.codex` / `.claude` 的修改权限 |
| 防火墙 | 可选（安装时勾选）：入站 TCP 8787，Private 配置 | 没放行时，局域网访问会被 Windows 防火墙直接丢弃，表现为「连接超时」而不是 403 |

在局域网里用明文 HTTP 同步（家用/可信内网）时：

- 两端都要设 `SYNC_ALLOW_INSECURE=1`。只设一端时，另一端仍会按协议拒绝——
  `master` 侧看本次请求是不是 HTTPS，`follower` 侧看 `masterUrl` 协议。
- 对端地址填**局域网 IP 或主机名**（如 `http://192.168.1.20:8787`），不要填
  `127.0.0.1`：那是本机自己。
- Windows 网络配置档必须是 **Private**（专用网络）。被识别成 Public 时上面那条防火墙
  规则不生效，需要改网络配置档或补一条对应配置档的规则。
- 明文 HTTP 只适合完全可信的网段。跨公网、共享 Wi-Fi、或任何可能被同网段抓包的环境，
  应改用 HTTPS 反向代理（两端都设 `TRUST_PROXY=1`，并把 `PUBLIC_BASE_URL` 写成
  `https://…`），而不是打开 `SYNC_ALLOW_INSECURE`。

> **本环境没有 Windows，以上运行时行为需在 Windows CI 与用户机器上验证。**
> 安装器/服务脚本本身也需要在 Windows 上实际跑过安装、升级、卸载三条路径。

## 已知限制

- **手动、无定时、无推送**：每次点「立即同步」才拉一次；两端不会自动感知对方改动。
- **`peer` 要求两端互相可达**：每一端都要能接受对方发起的快照请求。只有一端能从
  外面连进来时，实际只能做单向；NAT/防火墙没打通就是连不上（直接报连接失败），
  不会静默降级成「只拉不供」。
- **删除不传播**：对端删掉的供应商/设置项不会自动清掉本机。删除需要两端各做一次。
- **混版本**：`peer`、三方合并、`sync-state.json` 是同一批改动的产物，两端都升级后行为
  才一致。只升级一端时，旧端仍按旧的「时间戳 + 内容」两方判定，可能把本可自动收敛的
  情况报成冲突；新增字段在旧快照里缺失时按默认值处理。`schemaVersion` 高于本机支持的
  快照会被拒绝（400 `sync.snapshot.futureSchema`），不会硬着头皮应用。
- **没有并发保护**：`pull` 不阻止同时触发两次；应用是同步 IO，单次不会交错，但两次拉取
  谁后写谁生效。也没有跨进程锁，别在多实例间共享同一个 `data/`。
- **依赖两端时钟**：只有「没有 base 的首次同步」才用 `updatedAt` 决定方向；比较是
  `Date.parse()` 成毫秒后的数值，不是字符串。时钟严重漂移仍可能让首次判定偏向一边。
- **冲突文件不含明文凭据**：`localValue` / `remoteValue` 只留打码尾部；完整远端值另存为
  本机加密的 `remoteValueSealed`。未配置 `DATA_ENCRYPTION_KEY` 时无法「用远端」。
- **应用快照不会自动下发 Agent 文件**：`agentTargets` 同步的是「连接方式偏好」，
  真正写 `~/.codex` / `.claude` 仍要在目标机点「应用配置」——下发路径属于本机环境。
- **`sync-state.json` 是基线，不是缓存**：从备份整体恢复 `data/` 后它可能与实际内容
  对不上。后果是多应用几次或报出本可避免的冲突，不会丢数据；不确定时删掉它，
  下一次同步会按「首次同步」重新建立基线。
- **没有频率限制与独立审计**：导出只留一行 info 日志，导出去的数据无法召回；
  快照没有签名，HTTPS 是唯一防线。
