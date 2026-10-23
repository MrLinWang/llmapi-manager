# 配置

配置来自环境变量与 `.env` 文件。服务会依次查找 `server/.env`（进程 cwd）与仓库根目录的 `.env`，
前者优先；进程环境变量始终优先，已存在的同名变量不会被 `.env` 覆盖。

从仓库根目录执行 `cp .env.example .env` 即可得到一份带注释的模板。npm workspaces
执行脚本时 cwd 是 `server/`，所以 `.env` 放在仓库根目录也能被正确读取。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。对外暴露请改 `0.0.0.0` 并配 HTTPS 反向代理 |
| `PORT` | `8787` | 监听端口 |
| `PUBLIC_BASE_URL` | 由 `HOST:PORT` 推导 | **写进 Agent 配置**的网关地址（不带 `/v1`）。反向代理或容器部署必须显式设置 |
| `DATA_DIR` | `data` | 数据目录。相对路径按**进程 cwd** 解析：`npm start` / `npm run dev` 经 workspaces 切换后 cwd 是 `server/`，所以默认落在 `server/data`；想固定在仓库根可设 `../data` 或绝对路径 |
| `ADMIN_USERNAME` | `admin` | 初始管理员用户名，仅首次创建账号时使用 |
| `ADMIN_PASSWORD` | 无 | 应急通道：设置后跳过网页初始化，直接以此口令创建 `ADMIN_USERNAME` 账号 |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥；未设置时生成并存入 `data/instance.json` |
| `DATA_ENCRYPTION_KEY` | 无 | 凭据落盘加密密钥（任意字符串，内部派生 AES-256）；不设则明文并告警 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | 仓库根 `log/` | 运行日志目录；设为 `off` 则只输出到控制台 |
| `LOG_MAX_BYTES` | `5242880`（5MB） | 单个日志文件的滚动阈值 |
| `LOG_MAX_FILES` | `5` | 保留的历史日志文件个数 |
| `AGENT_HOME_DIR` | OS 家目录 | Agent 配置根目录（其下为 `.codex`、`.claude`） |
| `CODEX_HOME` | 无 | 仅用于定位 Codex 配置目录（结束 Codex 进程时设进子进程环境）。设了就优先于 `AGENT_HOME_DIR/.codex` |

`CODEX_HOME` 是 Codex 自己的约定变量，本服务只读不算：它决定 `codex app-server daemon stop`
在哪个目录下执行。目录不存在时不会强行设置（codex 会对不存在的路径报错，而"本机还没配过 Codex"
不该算失败）。写入 Agent 文件的路径仍由 `AGENT_HOME_DIR` 决定。

`PUBLIC_BASE_URL` 的特殊处理：当 `HOST` 是 `0.0.0.0` 或 `::` 时，推导结果会回落成 `127.0.0.1`，
因为监听地址对客户端没有意义。此时若客户端不在本机，必须显式设置。

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
├── instance.json                     会话签名密钥
├── setup.json                        首次初始化状态（一次性令牌哈希，完成后清空）
└── tenants/<tenantId>/
    ├── providers.json                供应商
    ├── settings.json                 默认供应商/模型、网关令牌、Codex 行为开关
    ├── agents.json                   下发快照
    ├── requests.jsonl                请求日志
    └── backups/<agentId>/*           下发前的原文件备份
```

所有 JSON 文件的外层结构：

```json
{ "schemaVersion": 1, "data": { ... } }
```

- 写入方式：临时文件 + `rename`，权限 0600；不会出现半截 JSON。
- 损坏或版本高于当前支持：改名为 `<文件名>.corrupt-<ISO 时间戳>`，以默认值启动。
- 备份不会自动清理，长期使用需自行清理 `backups/`。

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

## 迁移

整个 `data/` 目录可直接复制到新机器。若 `DATA_ENCRYPTION_KEY` 不变，供应商 Key 仍可解密；
若更换了密钥，需要在控制台重新填写各供应商的 Key（网关令牌也要重新生成并重新下发 Agent 配置）。
