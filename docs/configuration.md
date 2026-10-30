# 配置

配置来自环境变量与 `.env` 文件。服务会依次查找 `server/.env`（进程 cwd）与仓库根目录的 `.env`，
前者优先；进程环境变量始终优先，已存在的同名变量不会被 `.env` 覆盖。

从仓库根目录执行 `cp .env.example .env` 即可得到一份带注释的模板。npm workspaces
执行脚本时 cwd 是 `server/`，所以 `.env` 放在仓库根目录也能被正确读取。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。对外暴露请改 `0.0.0.0` 并配 HTTPS 反向代理；Windows 服务安装包默认即 `0.0.0.0`，可达范围由防火墙与网络配置档约束 |
| `PORT` | `8787` | 监听端口 |
| `PUBLIC_BASE_URL` | 由 `HOST:PORT` 推导 | **写进 Agent 配置**的网关地址（不带 `/v1`）。反向代理或容器部署必须显式设置；Windows 服务默认固定为 `http://127.0.0.1:8787`，让本机 Agent 走回环 |
| `DATA_DIR` | `data` | 数据目录。相对路径按**进程 cwd** 解析：`npm start` / `npm run dev` 经 workspaces 切换后 cwd 是 `server/`，所以默认落在 `server/data`；想固定在仓库根可设 `../data` 或绝对路径 |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次创建账号时使用 |
| `ADMIN_PASSWORD` | 无 | 应急通道：设置后跳过网页初始化，直接以此口令创建 `ADMIN_USERNAME` 账号 |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥；未设置时生成并存入 `data/instance.json` |
| `DATA_ENCRYPTION_KEY` | 无 | 凭据落盘加密密钥（任意字符串，内部派生 AES-256）；不设则明文并告警 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_LANGUAGE` | `zh` | `zh` / `en`：**运行日志、启动横幅与 CLI 输出**的语言。与接口文案的语言是两回事——接口跟随请求语言，日志跟随这个设置，否则同一故障在不同客户端下会长得不一样、没法 grep |
| `LOG_DIR` | 仓库根 `log/` | 运行日志目录；设为 `off` 则只输出到控制台 |
| `LOG_MAX_BYTES` | `5242880`（5MB） | 单个日志文件的滚动阈值 |
| `LOG_MAX_FILES` | `5` | 保留的历史日志文件个数 |
| `AGENT_HOME_DIR` | OS 家目录 | Agent 配置根目录（其下为 `.codex`、`.claude`）。Windows 服务以 LocalSystem 运行时**必须**显式指向安装用户目录，否则文件会写进 `C:\Windows\system32\config\systemprofile`，用户自己的 Codex 读不到 |
| `CODEX_HOME` | 无 | 仅用于定位 Codex 配置目录（结束 Codex 进程时设进子进程环境）。设了就优先于 `AGENT_HOME_DIR/.codex` |
| `CODEX_BIN` | 无（用 PATH 上的 `codex`） | `codex` 可执行文件的绝对路径（Windows 上如 `C:\Users\me\AppData\Roaming\npm\codex.cmd`）。Windows 服务（LocalSystem）的 PATH 通常不含 npm 全局安装目录，结束 Codex 守护进程时会找不到 `codex`；设为完整路径可避免该问题 |
| `ENABLE_DIAGNOSTICS` | 无（关闭） | 设为 `1` 才开启 `/api/diagnostics/*`；未开启时这四个接口返回 404 |
| `TRUST_PROXY` | 无（关闭） | 设为 `1` 才采信 `X-Forwarded-Proto` 等转发头，且只信任来自回环的代理。**部署在 HTTPS 反向代理后必须开**，否则同步快照的 HTTPS 检查会把代理回源当成明文请求。直接以局域网 HTTP 提供服务时**不要**开：没有反代可信任，开了只会让伪造的转发头被采信 |
| `SYNC_ALLOW_INSECURE` | 无（关闭） | 设为 `1` 允许同步快照与 follower / peer 拉取走明文 HTTP。仅用于可信内网（如 EasyTier 隧道内、家用局域网）。**两端都要设**：一端导出、一端拉取，任一端没开都会被自己的协议检查拦下。它不替代防火墙，也不改变「快照里是明文 Key」这一事实 |
| `MODELS_DEV_URL` | `https://models.dev/models.json?type=all` | 模型公开规格库地址，供 `npm run registry:sync -w server` 校准上下文窗口与推理档位。内网部署可指向同构镜像；不可达时该命令报错退出，不影响服务运行 |
| `MODELINFO_URL` | `https://modelinfo.dev/v1/models` | 另一个模型目录源，**推理档位优先取它**（直接给数组，不用按 provider 投票）。注意只有这一个路径可用，`api.json`/`models.json` 均 404 |


`CODEX_HOME` 是 Codex 自己的约定变量，本服务只读不算：它决定 `codex app-server daemon stop`
在哪个目录下执行。目录不存在时不会强行设置（codex 会对不存在的路径报错，而"本机还没配过 Codex"
不该算失败）。写入 Agent 文件的路径仍由 `AGENT_HOME_DIR` 决定。

`PUBLIC_BASE_URL` 的特殊处理：当 `HOST` 是 `0.0.0.0` 或 `::` 时，推导结果会回落成 `127.0.0.1`，
因为监听地址对客户端没有意义。此时若客户端不在本机，必须显式设置。

注意这个推导值**不能当作"本机访问"的安全证据**：服务其实对外监听，明文请求照样能进来。
同步快照的 HTTPS 检查因此读的是请求实际协议（`request.protocol`），不看这个配置项；
需要反向代理配合时开 `TRUST_PROXY=1`。`publicBaseUrlIsExplicit` 记录了它是不是用户显式配的。

## `HOST` 与 `PUBLIC_BASE_URL` 是两件事

这两个值经常被混为一谈，而它们的用途完全不同：

| 变量 | 回答什么问题 | 影响 |
| --- | --- | --- |
| `HOST` | 服务**监听**在哪块网卡上 | 决定「谁能连进来」。`127.0.0.1` 只允许本机；`0.0.0.0` 允许所有网卡 |
| `PUBLIC_BASE_URL` | 客户端**应该用什么地址访问**本服务 | 决定写进 Agent 配置的网关地址，也影响会话 Cookie 是否加 `Secure` |

Windows 服务安装包的默认组合是 `HOST=0.0.0.0` + `PUBLIC_BASE_URL=http://127.0.0.1:8787`：

- `HOST=0.0.0.0` 让局域网里的另一台机器能访问控制台与同步快照接口；
- `PUBLIC_BASE_URL` 仍写回环，因为**本机 Agent 走回环最稳**——不受网卡切换、IP 变化、
  VPN 占用路由的影响。把它改成局域网地址的唯一理由是：**其它设备上的 Agent 也要经这台
  网关转发**。那时必须填一个客户端确实能访问到的地址（局域网 IP 或域名），否则 Agent
  会连不上。

反过来也要注意：改 `PUBLIC_BASE_URL` 不会让服务「只监听回环」，它只是写进配置的字符串；
真正的可达性由 `HOST` + 防火墙决定。同步的 HTTPS 检查两者都不看，只看请求实际协议
（见[`SYNC_ALLOW_INSECURE`](#环境变量)与 [sync.md](./sync.md#windows-与局域网)）。

## Windows 服务模式

Windows 安装包（Inno Setup 生成的 `llmapi-manager-setup-<version>-x64.exe`）与便携 zip
把服务装成 WinSW 托管的 Windows 服务，运行时固定为自带的 Node 22 LTS x64，不要求用户
预装 Node。安装、升级、卸载、日志与故障排查见 [windows.md](./windows.md)；本节只列
安装器写进 `.env` 的默认值与它们的原因。

| 变量 | Windows 服务默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 允许局域网访问；范围交给防火墙与网络配置档 |
| `PORT` | `8787` | 与源码运行一致 |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8787` | 本机 Agent 走回环；其它设备要从网关走时再改 |
| `DATA_DIR` | `C:\ProgramData\llmapi-manager\data` | 安装器展开 `%ProgramData%`。升级与卸载默认保留 |
| `LOG_DIR` | `C:\ProgramData\llmapi-manager\log` | 与 `DATA_DIR` 分开，避免迁移数据时带走日志 |
| `AGENT_HOME_DIR` | `C:\Users\<安装用户>` | 服务以 LocalSystem 运行，自身家目录是系统配置目录；必须指向安装用户目录 |
| `DATA_ENCRYPTION_KEY` | 安装时随机生成 | 缺了它会明文存凭据并持续告警 |
| `ADMIN_PASSWORD` | 安装时随机生成，**健康检查通过后从 `.env` 删除** | 用于首次建号。删除后账号已存在，重启不会重复创建 |
| `SYNC_ALLOW_INSECURE` | 不写（关闭） | 只有可信局域网做明文同步时才设为 `1`，且两端都要设 |
| `CODEX_BIN` | 不写（依赖 PATH） | 服务账号 PATH 里没有 npm 全局目录时，填 `codex.cmd` 的绝对路径 |
| `TRUST_PROXY` | 不写（关闭） | 只有前面放了 HTTPS 反向代理时才设 `1` |

几个必须知道的 Windows 细节：

- **服务账号默认是 LocalSystem**。它能写安装用户的家目录前提是安装器额外授予了
  `AGENT_HOME_DIR\.codex` 与 `.claude` 的修改权限；重装或换用户后若权限丢失，表现为
  「应用配置成功但 Codex 读不到」。安全上更稳妥的做法是改用专用低权限账号运行服务。
- **防火墙规则是入站 TCP 8787，Private 配置档**（安装时可选，**默认不勾选**）。Windows
  把当前网络识别为 Public 时这条规则不生效，局域网访问会表现为连接超时。需要改网络配置档，
  或补一条对应配置档的规则。
- **只升级程序不覆盖配置**：升级保留 `.env` 与数据目录；卸载默认保留数据，
  只有显式 `-Purge` 才删除。
- **`ADMIN_PASSWORD` 是一次性的**：健康检查通过后安装器会把它从 `.env` 删掉。若安装
  中断在删除之前，`.env` 里会残留一个已生效的口令，应手动删除并确认账号密码强度。

> 本仓库的开发环境是 Linux，**以上 Windows 运行时行为没有在本机实测**，
> 需在 Windows CI 与用户机器上验证安装、升级、卸载三条路径。

## 运行日志

日志同时输出到控制台和文件，内容一致（同样经过打码处理）。

```
log/
├── app.log         # 当前写入
├── app.1.log       # 上一次滚动的历史（最新）
├── app.2.log
└── …               # 最多 LOG_MAX_FILES 个，更老的自动删除
```

- **位置**：仓库根的 `log/`，刻意**不放在 `DATA_DIR` 下** —— 日志是运行产物，不是租户业务数据，
  整体迁移 `data/` 时不该被一起带走。`log/` 已在 `.gitignore` 中。
  `LOG_DIR=off` 可关闭落盘。
- **滚动**：单文件超过 `LOG_MAX_BYTES` 时轮转（`app.log` → `app.1.log` → `app.2.log`……），
  超出 `LOG_MAX_FILES` 的最老文件删除。
- **同步写**：日志量小（启动、网关失败、未处理异常等事件），同步写能保证进程崩溃前
  最后一条日志已落盘。写文件出错不会影响服务，会降级为仅控制台。
- **会记什么**：启动信息（含数据/日志路径）、启动告警、网关回退与未处理异常（含堆栈）。
- **不会记什么**：初始化令牌（只在控制台打印一次）、口令、完整 API Key 与网关令牌
  （日志器按 key 名与正则打码）。
- 权限 0600，与其他数据文件一致。

Docker / systemd 部署如果希望把日志挂到宿主机，把 `LOG_DIR` 指到挂载点即可；
容器内也可以设为 `off`，交给容器日志驱动收集 stdout。

## 关于两个密钥

### SESSION_SECRET

用于给会话 Cookie 做 HMAC 签名。不设置时会自动生成并保存到 `data/instance.json`（权限 0600），
这样重启不会把已登录用户踢下线。该文件可安全删除（代价是所有会话失效）。

### DATA_ENCRYPTION_KEY

用于加密供应商 API Key 与网关令牌的落盘副本：

- **设置后**：`providers.json` 里的 `apiKey` 形如 `enc:v1:<iv>:<tag>:<ciphertext>`（AES-256-GCM）。
- **不设置**：明文存储，启动日志与 `/api/health` 都会持续告警，仅建议单机使用。
- **更换后**：旧密文无法解密，读取时会退化为"无凭据"，并产生 `credential_decrypt_failed` 告警，
  需要重新填写各供应商的 Key。

> 内部派生密钥时使用固定盐值 `llmapi-hub.secret.v1`。这是加密参数而非项目名，
> 改动它会让所有已落盘密文失效，因此**不要改**。

## 数据目录

```
data/                                # 默认即 server/data，见上表 DATA_DIR 说明
├── identity.json                     租户与账号
├── instance.json                     会话签名密钥（也是同步快照的 masterId 来源）
├── setup.json                        首次初始化状态（一次性令牌哈希，完成后清空）
└── tenants/<tenantId>/
    ├── providers.json                供应商（含 imageModels 与 modelCapabilities）
    ├── settings.json                 默认供应商/模型、界面语言、网关令牌、Codex 行为与流式参数、同步设置
    ├── agents.json                   下发快照
    ├── api-tokens.json               程序化访问用的 API 令牌（只存 sha256）
    ├── sync-conflicts.json           待仲裁的同步冲突（凭据已打码）
    ├── sync-state.json               双向同步的内容基线（只存哈希，不存原文，无接口）
    └── requests.jsonl                请求日志
```

Agent 文件的写前备份**不在数据目录**，而是落在被改文件的同目录
（`~/.codex/config.toml.bak-<时间戳>`），避免数据目录被清空后无法恢复。

`sync-conflicts.json` 单独成文件而不是塞进 `settings.json`：冲突可能累积很多条，
混进设置会让设置文件变成一个还在变大的列表，而两者的生命周期也不同（冲突解决完就该清空）。
它里面的凭据只保留打码形态，完整远端值另存为本机加密的 `remoteValueSealed`。

`sync-state.json` 是[双向同步](./sync.md#sync-statejson三方合并的基线)的三方合并基线：
记录每个供应商 / 设置 / Agent 连接方式的**内容哈希**，用来区分「只有一边变了」与
「两边真的改成了不同结果」。它不暴露任何接口，删除它只会让下一次同步退回「首次同步」
（按 `updatedAt` 判方向），不会丢数据。

所有 JSON 文件的外层结构：

```json
{ "schemaVersion": 1, "data": { ... } }
```

- 写入方式：临时文件 + `rename`，权限 0600；不会出现半截 JSON。
- 损坏或版本高于当前支持：改名为 `<文件名>.corrupt-<ISO 时间戳>`，以默认值启动。
- 备份不会自动清理，长期使用需自行清理目标文件同目录下的 `*.bak-<时间戳>`。

## 首次启动与初始化

1. 创建 `DATA_DIR`（若不存在）。
2. 解析或生成 `SESSION_SECRET`。
3. 创建 `t_default` 租户，补齐 `data/tenants/t_default/` 下的空数据文件。
4. 生成一次性**初始化令牌**（`setup_…`）并打印到控制台，同时写入 `data/setup.json`（只存 sha256）。
5. 打印控制台地址、网关地址。

此时**还没有任何账号**。打开控制台首页会被强制引导到设置页，在那里填：

- 初始化令牌（控制台打印的那个）；
- 你自己想要的用户名与口令（口令至少 8 位）。

提交成功后立即创建 `role=owner` 的管理员账号，令牌作废，可以直接登录。

> 为什么要令牌：默认路径下服务启动时是一扇"开着的门"（还没设密码）。
> 令牌只出现在控制台，因此**能读到控制台的人才算部署者**，避免端口暴露时被陌生人抢注成管理员。
> 令牌不会写进日志文件。

### 忘记初始化令牌

删除 `data/setup.json` 后重启，会重新生成并打印一次。

### 应急通道：ADMIN_PASSWORD

设置了 `ADMIN_PASSWORD` 环境变量时**跳过网页初始化**，直接用该口令创建 `ADMIN_USERNAME` 账号，
适合 Docker / systemd 等无交互部署：

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD='强口令' npm start
```

### 幂等与恢复

- 已存在账号时不会重复创建，也**不会覆盖**已改过的口令；重启不会重新发放令牌。
- 判断"是否已初始化"的依据是**默认租户里有没有账号**，而不是用户名是否等于 `ADMIN_USERNAME`
  —— 首次初始化时用户名由用户自填，可能不等于默认值。
- 若确实遗忘了口令：删除 `data/identity.json` 后重启可重建账号（会清空租户与账号数据）；
  同时建议删掉 `data/setup.json`，让服务重新发放初始化令牌。

## 生产部署

```bash
npm install
npm run build
HOST=0.0.0.0 PORT=8787 PUBLIC_BASE_URL=https://llm.example.com \
DATA_ENCRYPTION_KEY='<随机长字符串>' \
npm start
```

要点：

- `PUBLIC_BASE_URL` 必须是**客户端能访问到**的地址，它会写进 Agent 配置文件。
- 对外暴露务必放在 HTTPS 反向代理之后；会话 Cookie 在 `PUBLIC_BASE_URL` 为 https 时自动加 `Secure`。
- 反向代理需要关闭对 SSE 的缓冲（例如 nginx 的 `proxy_buffering off;`），否则流式响应会被攒住。
- 服务是无状态的（除 `data/`），用 systemd / pm2 / 容器托管都可以，但**不要多实例共享同一个 `data/`**：
  JSON 存储与内存缓存没有跨进程协调。
- Windows 上推荐用安装包 + WinSW 服务模式（`HOST=0.0.0.0`、ProgramData 下的数据与日志、
  防火墙放行 TCP 8787），见上文「Windows 服务模式」与 [windows.md](./windows.md)。

## 迁移

整个 `data/` 目录可直接复制到新机器。若 `DATA_ENCRYPTION_KEY` 不变，供应商 Key 仍可解密；
若更换了密钥，需要在控制台重新填写各供应商的 Key（网关令牌也要重新生成并重新下发 Agent 配置）。

### `api-tokens.json`

程序化访问用的 API 令牌（`api_` 前缀），位于 `data/tenants/<id>/api-tokens.json`。
与其他数据文件一样带 `{ schemaVersion, data }` 外层信封，令牌数组在 `data.tokens` 里：

```json
{
  "schemaVersion": 1,
  "data": {
    "tokens": [
      {
        "id": "tok_…",
        "tenantId": "t_default",
        "name": "CI 脚本",
        "tokenHash": "<sha256>",
        "prefix": "api_abc1234",
        "tail": "x9Yz",
        "scopes": ["providers:read", "logs:read"],
        "createdBy": "u_…",
        "createdAt": "2026-10-24T00:00:00.000Z",
        "lastUsedAt": null,
        "expiresAt": null,
        "revokedAt": null
      }
    ]
  }
}
```

只存 `sha256(token)`，不含明文，也无法从文件还原出令牌。`prefix` 是前 11 位（含 `api_`）、
`tail` 是后 4 位，两者合起来足够在列表里认出是哪一个。

删除整个文件即可清空所有令牌，**不需要重启**：存储没有内存缓存，每次鉴权都重新读盘。
但正在使用该文件的脚本会立刻 401。更推荐用 `DELETE /api/tokens/:id` 吊销 —— 它会保留记录，
将来能解释"某个令牌曾经存在过"。

> 注意：`revokedAt` 非 null 的记录会一直留在文件里，不自动清理。

### `ENABLE_DIAGNOSTICS`

设为 `1` 才开启 `/api/diagnostics/*`（默认关闭；其余任何值都视为关闭，不是"非空即开"）。

这些接口会回显转换后的上游请求体（含 prompt 片段），并能发起真实上游调用 ——
后者会**真实消耗上游额度**。它是为排查"跨协议转发到底有没有生效"这类问题临时打开的工具，
不是常开项。默认关闭 + 未开启时返回 404（不是 403：不告诉探测者"这里有个开关"）。

四个接口都要求 `settings:write` 权限，也就是说持有一个只读 API 令牌调不通它们。


### 设备互联（组网）的引擎选择

`GET/PATCH /api/networking/config` 里的 `engine` 决定用哪套实现做 EasyTier 组网。
它存在租户设置里（与其它设置一起），密钥字段落盘前经 `ctx.secrets.encode()` 加密。

| `engine` | 实现 | 适用场景 |
| --- | --- | --- |
| `builtin`（默认） | 本仓库 TS（`server/src/networking/easytier/`） | 两台机器 TCP 直连做配置同步；不想装 Rust 工具链 |
| `native` | `native/easytier-node/`（Rust + N-API） | 需要 NAT 穿透、端口转发、多跳中继、虚拟网卡 |

两者的能力边界不同，**默认值选 `builtin` 是因为它不依赖编译产物**，而不是因为它在所有场景都更强：

- `builtin` 已实测：握手（发起方与接受方两个角色）、数据面加解密、RPC 双向、
  OSPF 路由同步与广播。
- `builtin` **未实现**：NAT 穿透/打洞、MTU 协商、端口转发、多跳中继、TUN 虚拟网卡。
  它只做 TCP 隧道，拓扑是"对端主动连本机"。
- `native` 复用官方完整实现，上述能力都有；代价是需要 Rust 工具链编译，
  且本仓库改不动它的行为。

#### `listenPort`

只有 `builtin` 用它（默认 `11011`）。因为自研实现的是**接受方角色**——只监听、
不主动外连——所以对端必须主动连到 `本机地址:listenPort`。`native` 忽略它
（官方自己管理端口与打洞）。

`11011` 而不是官方的 `11010`，是为了两个引擎能在同一台机器上并存。

#### 降级是显式的

请求的引擎不可用时会改用另一个，并把事实写进 `GET /api/networking/status`：

- `engine`：实际生效的引擎
- `degradedFrom`：发生降级时是被替换掉的那个，否则 `null`
- `builtinAvailable` / `nativeAvailable`：两个引擎各自的可用性

**不要忽略 `degradedFrom`**：选了 `native` 却跑在 `builtin` 上时，NAT 穿透不会生效，
而这个问题在"两端都不报错、只是连不上"的表象下极难定位。

#### 自研引擎的 `functional` 判据不同

`native` 引擎的 `functional` 看"有没有拿到虚拟 IP"（没有 IP 说明 TUN 没建起来）。
`builtin` 不创建 TUN，所以它看**"有没有对端连上"**——这证明握手、加密、
OSPF 全链路都通了。两者的 `functionalReason` 也分别解释各自的失败原因。
