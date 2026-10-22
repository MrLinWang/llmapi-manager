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
| `DATA_DIR` | `data` | 数据目录（相对仓库根或绝对路径） |
| `ADMIN_USERNAME` | `owner` | 初始管理员用户名，仅首次创建账号时使用 |
| `ADMIN_PASSWORD` | 随机生成 | 初始口令，仅首次使用；未设置时随机生成并只在控制台打印一次 |
| `SESSION_SECRET` | 自动生成 | 会话签名密钥；未设置时生成并存入 `data/instance.json` |
| `DATA_ENCRYPTION_KEY` | 无 | 凭据落盘加密密钥（任意字符串，内部派生 AES-256）；不设则明文并告警 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `AGENT_HOME_DIR` | OS 家目录 | Agent 配置根目录（其下为 `.codex`、`.claude`） |

`PUBLIC_BASE_URL` 的特殊处理：当 `HOST` 是 `0.0.0.0` 或 `::` 时，推导结果会回落成 `127.0.0.1`，
因为监听地址对客户端没有意义。此时若客户端不在本机，必须显式设置。

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
data/
├── identity.json                     租户与账号
├── instance.json                     会话签名密钥
└── tenants/<tenantId>/
    ├── providers.json                供应商
    ├── settings.json                 默认供应商/模型、网关令牌
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

## 首次启动做了什么

1. 创建 `DATA_DIR`（若不存在）。
2. 解析或生成 `SESSION_SECRET`。
3. 创建 `t_default` 租户与 `u_owner`（`role=owner`）：
   - 有 `ADMIN_PASSWORD` 就用它，否则随机生成；
   - 口令只在控制台打印一次，`identity.json` 里只存 scrypt 哈希。
4. 补齐 `data/tenants/t_default/` 下的空数据文件。
5. 打印控制台地址、网关地址与（如有）初始口令。

**幂等**：已存在账号时不会重复创建，也**不会覆盖**已改过的口令。
若确实遗忘了口令，删除 `data/identity.json` 后重启可重建账号（会清空租户与账号数据）。

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
