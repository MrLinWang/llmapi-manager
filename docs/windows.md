# Windows 安装与运维

本文档描述在 Windows 上使用 **安装包（Inno Setup）**、**便携包** 与 **WinSW 服务脚本** 部署
llmapi-manager 的方式。源码运行方式（`npm run dev` / `npm start`）见
[development.md](./development.md) 与根目录 README。

> **验证状态（请务必阅读）**
>
> 本仓库的脚本与安装器是在 Linux 环境里编写的，**没有在真实 Windows 上实测过**。
> CI 的 `windows-smoke` 只覆盖“解压便携包 → 启动 node.exe → `/api/health` + 前端首页”
> 这条最小路径；**服务安装、ACL 授权、防火墙规则、Inno 完成页、自定义服务账号**
> 需要在 Windows CI 或用户机器上验证。`installer.iss` 也只能在 Windows 上由 Inno Setup
> 编译（Linux 无法运行 ISCC）。
>
> 首次在 Windows 上验证时，建议先用便携包跑通，再用 `install-service.ps1` 手动安装服务，
> 最后才用安装器。

## 1. 产物与系统要求

构建产物在 `dist/windows/`：

| 文件 | 说明 |
| --- | --- |
| `llmapi-manager-<version>-win-x64.zip` | 便携包：解压即用，数据在包目录内 |
| `llmapi-manager-setup-<version>-x64.exe` | Inno Setup 安装器（构建机装有 Inno Setup 6 时才会生成） |
| `*.sha256` | 对应产物的 SHA256 校验文件 |

系统要求：

- Windows 10 / Windows 11 / Windows Server 2016 及以上，**x64**（ARM64 可通过 x64 模拟运行，
  但未验证）。
- 安装服务需要管理员权限。
- 默认监听 `0.0.0.0:8787`；端口被占用时可在安装时改端口，或编辑 `.env` 后重启服务。

运行时固定为 **Node.js 22 LTS x64**（构建时下载并校验，不依赖目标机器安装 Node）。
服务 wrapper 为 **WinSW 2.12.0 x64**。

## 2. 安装（安装器）

1. 下载 `llmapi-manager-setup-<version>-x64.exe` 与同名 `.sha256`，在 PowerShell 里校验：

   ```powershell
   Get-FileHash .\llmapi-manager-setup-<version>-x64.exe -Algorithm SHA256
   # 与 .sha256 文件内容比对
   ```

2. 双击安装。安装包**没有代码签名**，Windows SmartScreen 可能提示“Windows 已保护你的电脑”：
   点“更多信息”→“仍要运行”。企业环境请先用 SHA256 校验，再决定是否放行。

3. 安装向导默认目录为 `C:\Program Files\llmapi-manager`。可选任务：

   - **在 Windows 防火墙中放行服务端口（仅专用网络）**：默认不勾选；需要其它设备访问时勾选。
   - 端口、`PUBLIC_BASE_URL`、初始口令、`CODEX_BIN` 等可通过命令行参数覆盖（见 §9）。

4. 安装结束时，完成页会显示：

   ```
   控制台地址：http://127.0.0.1:8787
   管理员账号：admin
   初始口令：<随机口令>
   数据目录：C:\ProgramData\llmapi-manager\data
   日志目录：C:\ProgramData\llmapi-manager\log
   ```

   **初始口令只显示这一次**。安装器在健康检查通过后会把 `ADMIN_PASSWORD` 从 `.env` 删除；
   口令同时写入 `%ProgramData%\llmapi-manager\install-result.env` 供静默安装读取，
   非静默安装会在完成页读取后删除该文件。

5. 安装完成后登录控制台，在「设置」中修改口令。之后安装/升级**不会**再用 `ADMIN_PASSWORD`
   覆盖已有账号（`server/src/bootstrap.ts` 只在“默认租户还没有账号”时建号）。

安装结果：

- 程序文件：`C:\Program Files\llmapi-manager\`
- `.env`：`C:\Program Files\llmapi-manager\.env`（ACL 仅 Administrators + SYSTEM + 服务账号）
- 数据/日志：`C:\ProgramData\llmapi-manager\data`、`...\log`
- 服务名：`llmapi-manager`（WinSW 包装，自动启动，崩溃自动重启）
- 服务账号：默认 `LocalSystem`

## 3. 便携版

1. 解压 `llmapi-manager-<version>-win-x64.zip`，得到 `llmapi-manager-<version>-win-x64\` 目录。
2. 双击 `start-portable.cmd`。
3. 首次运行会在包目录生成 `.env`（数据目录、日志目录都在包内），并在控制台打印一次性
   **初始化令牌**；打开 `http://127.0.0.1:8787`，按设置页提示创建管理员。
4. 关闭控制台窗口（或 Ctrl+C）即停止；便携版不注册服务、不开机自启。

便携版与安装版的区别：

| | 便携版 | 安装版 |
| --- | --- | --- |
| 数据位置 | 包目录 `data\` / `log\` | `%ProgramData%\llmapi-manager\` |
| 监听地址 | `127.0.0.1`（仅本机） | `0.0.0.0`（局域网可访问，需防火墙） |
| 管理员初始化 | 控制台打印一次性令牌 | 随机 `ADMIN_PASSWORD`，完成页显示 |
| 开机自启 | 否 | 是（WinSW 服务） |
| 端口/PublicBaseUrl | 改包内 `.env` | 安装参数或安装目录 `.env` |

把便携包安装为服务（管理员 PowerShell）：

```powershell
# 在便携包根目录执行；默认复制到 C:\Program Files\llmapi-manager
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 -EnableFirewall
```

## 4. 手动安装/升级服务

`scripts\windows\install-service.ps1` 是安装器的实际执行者，也可以单独使用。
所有参数都可省略，省略时使用下列默认值。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-SourceDir` | 脚本上两级目录 | 发行包根目录（含 `node.exe`、`server\`、`web\`、`llmapi-manager-service.exe`） |
| `-InstallDir` | `C:\Program Files\llmapi-manager` | 安装目录 |
| `-ServiceName` | `llmapi-manager` | Windows 服务名（同时用于 WinSW id） |
| `-DisplayName` | `LLM API Manager` | 服务显示名 |
| `-Port` | `8787` | 监听端口，写入 `.env` 的 `PORT` |
| `-PublicBaseUrl` | `http://127.0.0.1:<Port>` | 写进 Agent 配置的网关地址（不带 `/v1`） |
| `-AgentHomeDir` | 当前用户家目录 | `AGENT_HOME_DIR`；其下 `.codex` / `.claude` 会授权给服务账号 |
| `-ProgramDataDir` | `%ProgramData%\llmapi-manager` | 数据/日志根目录 |
| `-AdminUsername` | `admin` | 首次创建账号的用户名 |
| `-AdminPassword` | 随机 | 首次创建账号的口令；已有账号时不会覆盖 |
| `-CodexBin` | 自动探测 | `CODEX_BIN`，服务调用 codex 的绝对路径 |
| `-SyncAllowInsecure` | 关闭 | 写入 `SYNC_ALLOW_INSECURE=1`（仅可信内网） |
| `-EnableFirewall` | 关闭 | 添加入站 TCP 端口规则（Private profile） |
| `-ServiceAccount` | `LocalSystem` | `LocalSystem` / `LocalService` / `NetworkService` / `DOMAIN\user` |
| `-ServiceAccountPassword` | 空 | 自定义账号必填；会授予“作为服务登录” |
| `-SkipCopy` | 关闭 | 文件已就位（安装器场景） |
| `-SkipHealthCheck` | 关闭 | 只启动不轮询健康检查（排障用） |
| `-HealthTimeoutSeconds` | 90 | 健康检查超时 |
| `-ResultFile` | 空 | 写安装结果 key=value（安装器读取；含明文口令，注意 ACL） |

示例：

```powershell
# 升级：先解压新版本便携包，再用新包覆盖安装（保留 .env 与 ProgramData 数据）
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 `
  -SourceDir . -EnableFirewall

# 改端口 + 局域网访问地址
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 `
  -Port 9000 -PublicBaseUrl http://192.168.1.20:9000 -EnableFirewall

# 只允许本机访问（不监听 0.0.0.0 需要手工改 .env 的 HOST，再重启服务）
```

脚本行为：

1. 检查管理员权限与发行包完整性；
2. 停止并卸载已有同名服务（升级时）；
3. 把旧文件移到安装目录下的 `.rollback-<时间戳>`，复制新文件；
4. 生成/更新 `.env`（保留未知键与已有 `DATA_ENCRYPTION_KEY`）；
5. 生成 `llmapi-manager-service.xml`（WinSW 配置）；
6. 安装并启动服务，轮询 `http://127.0.0.1:<Port>/api/health`；
7. 健康检查通过后从 `.env` 删除 `ADMIN_PASSWORD`，写 `console.url`；
8. 失败时停服务、换回旧文件、恢复旧 `.env`，并输出日志路径。

## 5. `.env` 与服务配置

安装版 `.env` 位于安装目录根（`C:\Program Files\llmapi-manager\.env`）。服务端按进程
工作目录读取它；WinSW 的 `<workingdirectory>` 已设为安装目录。

| 键 | 安装器写入 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听所有网卡；只允许本机时改成 `127.0.0.1` |
| `PORT` | `8787` | 监听端口 |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8787` | **写进 Agent 配置**的地址，不带 `/v1`。其它设备要直连时改成 `http://<本机IP>:8787` 或域名 |
| `DATA_DIR` | `%ProgramData%\llmapi-manager\data` | 租户数据 |
| `LOG_DIR` | `%ProgramData%\llmapi-manager\log` | 运行日志与 WinSW 日志 |
| `AGENT_HOME_DIR` | 安装用户家目录 | 其下 `.codex` / `.claude` 是 Agent 配置目标 |
| `DATA_ENCRYPTION_KEY` | 随机 64 位十六进制 | **必须保留**。丢失后已加密的上游 API Key / 网关令牌无法解密 |
| `ADMIN_USERNAME` | `admin` | 仅首次建号使用 |
| `ADMIN_PASSWORD` | 随机（仅首次） | 健康检查通过后删除 |
| `SYNC_ALLOW_INSECURE` | 仅 `-SyncAllowInsecure` 时 | 允许同步快照走明文 HTTP，仅可信内网 |
| `CODEX_BIN` | 自动探测/手动 | codex 可执行文件的绝对路径（`.exe`/`.cmd`/`.bat`） |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `TRUST_PROXY` | 不写入 | 放在 HTTPS 反向代理后时设 `1`（只信任回环代理的转发头） |

`HOST=0.0.0.0` 与 `PUBLIC_BASE_URL=127.0.0.1` 的区别：

- `HOST` 是**监听**地址，决定哪些网卡能连进来；
- `PUBLIC_BASE_URL` 是**下发给 Agent** 的地址。安装器默认写 `127.0.0.1`，因为大多数用户
  只在本机使用；若 Agent 在别的机器上，必须改成那台机器能访问到的地址，否则下发的
  `base_url` 会指向 Agent 自己的回环地址。
- 改动 `.env` 后重启服务生效：`Restart-Service llmapi-manager`。

## 6. 服务账号与 `AGENT_HOME_DIR`

### 默认：LocalSystem

服务以 `LocalSystem` 运行。LocalSystem 对用户目录通常已有完全控制权限，安装器仍会显式给
`%USERPROFILE%\.codex` 与 `.claude` 授予修改权限（`icacls` 继承 `(OI)(CI)M`），避免因
用户目录 ACL 被收紧后 Agent 下发失败。

安装器写入的 `AGENT_HOME_DIR` 是**执行安装的用户**的家目录（Inno 传环境变量
`{%USERPROFILE}`；手动运行取 `$env:USERPROFILE`）。如果服务后来换成另一个账号运行，
它仍会写到这个目录。

### 自定义服务账号

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 `
  -ServiceAccount 'CONTOSO\svc-llmapi' -ServiceAccountPassword '<口令>' `
  -AgentHomeDir 'C:\Users\alice'
```

- 脚本会把账号写进 WinSW 的 `<serviceaccount>` 并开启 `allowservicelogon`（授予“作为服务登录”）。
- 给 `C:\ProgramData\llmapi-manager` 与 `AGENT_HOME_DIR\.codex` / `.claude` 授予修改权限。
- 自定义账号还必须能**读取**安装目录（`C:\Program Files` 默认给 Users/Authenticated Users
  读+执行；如果公司策略收紧了，需手工授权）。
- 服务账号切换后，之前由 LocalSystem 创建的文件所有权不变，但 ACL 已包含新账号，通常可直接用。

手工修正 ACL 示例：

```powershell
icacls "C:\Users\alice\.codex" /grant "CONTOSO\svc-llmapi:(OI)(CI)M"
icacls "C:\ProgramData\llmapi-manager" /grant "CONTOSO\svc-llmapi:(OI)(CI)M"
Restart-Service llmapi-manager
```

## 7. 防火墙

安装器/脚本**不会默认放开端口**。需要在局域网访问时：

- 安装向导里勾选“在 Windows 防火墙中放行服务端口（仅专用网络）”；或
- 手动执行 `install-service.ps1 -EnableFirewall`；或
- 手工添加规则：

```powershell
New-NetFirewallRule -DisplayName "LLM API Manager (TCP 8787)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 `
  -Profile Private -Program "C:\Program Files\llmapi-manager\node.exe"
```

规则只对 **Private** 网络配置（家庭/公司内网）生效，公网配置不放开。改端口后要同步改规则
（脚本会按“LLM API Manager (TCP <端口>)”重建）。验证：

```powershell
Get-NetFirewallRule -DisplayName 'LLM API Manager*' | Format-Table DisplayName,Enabled,Profile
```

> 服务本身是明文 HTTP。跨不可信网络请放在 HTTPS 反向代理之后，并设置 `TRUST_PROXY=1`
> 与 `PUBLIC_BASE_URL=https://...`；不要把 8787 直接暴露到公网。

## 8. `CODEX_BIN`

服务以 LocalSystem（或其他服务账号）运行时，**看不到安装用户的 PATH**，直接执行 `codex` 会失败。
安装器会尝试 `where.exe codex` 并挑选 `.exe`/`.cmd`/`.bat` 写入 `CODEX_BIN`；探测不到时
可以手工指定：

```powershell
where.exe codex
# C:\Users\alice\AppData\Roaming\npm\codex.cmd

# 写入 .env 后重启
notepad "C:\Program Files\llmapi-manager\.env"
Restart-Service llmapi-manager
```

注意：

- 必须是**绝对路径**，且指向 `.cmd` / `.exe` / `.bat`（服务端会用 `cmd.exe /d /s /c` 调 `.cmd`）。
- 升级时保留已有 `CODEX_BIN`；文件不存在会在安装日志中告警，但不会擅自删除。
- `AGENT_HOME_DIR` 决定写入哪个用户的 `.codex`/`.claude`，`CODEX_BIN` 决定结束哪个 codex 进程；
  两者通常应指向同一个用户。

## 9. 命令行参数（安装器）

静默安装在 CI/批量部署里常用：

```powershell
llmapi-manager-setup-0.1.0-x64.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART `
  /PORT=9000 /PUBLICBASEURL=http://192.168.1.20:9000 /ALLOWINSECURESYNC=1
```

| 参数 | 说明 |
| --- | --- |
| `/PORT=8787` | 覆盖端口（`PUBLIC_BASE_URL` 未指定时按它生成默认值） |
| `/PUBLICBASEURL=...` | 覆盖 `PUBLIC_BASE_URL` |
| `/ALLOWINSECURESYNC=1` | 写入 `SYNC_ALLOW_INSECURE=1` |
| `/ADMINPASSWORD=...` | 指定初始管理员口令；不传则随机生成 |
| `/CODEXBIN=...` | 指定 codex 可执行文件 |
| `/NOSERVICE=1` | 只复制文件，不安装服务 |
| `/SILENT`、`/VERYSILENT` | Inno 标准静默参数 |

**静默安装没有完成页**，初始口令不会显示。口令写入
`%ProgramData%\llmapi-manager\install-result.env`（ACL 收紧为管理员 / SYSTEM / 服务账号），读取后请立即删除该文件：

```powershell
Get-Content "C:\ProgramData\llmapi-manager\install-result.env"
Remove-Item "C:\ProgramData\llmapi-manager\install-result.env"
```

如果静默安装失败，脚本会把错误写进同一个文件的 `error=` 行，并保留日志路径。
注意：Inno 静默安装的进程退出码**不反映服务安装结果**；请检查 `install-result.env` 的
`success=0` / `error=` 行，以及 `sc.exe query llmapi-manager`。

## 10. 日志

| 路径 | 内容 |
| --- | --- |
| `%ProgramData%\llmapi-manager\log\app.log` | 服务运行日志（启动、网关错误、未处理异常） |
| `...\app.1.log` … | 滚动历史，默认最多 5 个、单文件 5MB（`LOG_MAX_BYTES` / `LOG_MAX_FILES`） |
| `...\llmapi-manager-service.out.log` | 服务标准输出（WinSW 收集） |
| `...\llmapi-manager-service.err.log` | 服务标准错误（启动失败优先看这里） |
| `%ProgramData%\llmapi-manager\install-result.env` | 安装结果/失败原因/初始口令（安装器临时文件） |
| Windows 事件查看器 → Windows 日志 → 系统 | 服务控制管理器错误（如“服务无法启动”） |

```powershell
Get-Content "C:\ProgramData\llmapi-manager\log\app.log" -Tail 100 -Wait
Get-Service llmapi-manager | Format-List Name,Status,StartType
```

日志会按 key 名与正则打码，不会主动写完整 API Key、网关令牌或口令；初始化令牌只打印到
服务首次启动的控制台（事件日志里看不到时，可删除数据重新初始化——见故障排查）。

## 11. 升级

推荐直接运行新版本安装器覆盖安装：

1. 备份 `C:\Program Files\llmapi-manager\.env` 与 `%ProgramData%\llmapi-manager`；
2. 运行新版本安装器（同一安装目录）。安装器会先停服务，再替换程序文件；
3. `.env` 与 ProgramData 数据**默认保留**；`DATA_ENCRYPTION_KEY` 不会重新生成；
4. 完成页会显示“沿用已有管理员账号，未生成新口令”；
5. 验证：`Get-Service llmapi-manager`、`Invoke-RestMethod http://127.0.0.1:8787/api/health`、
   登录控制台确认供应商/模型/Agent 配置还在。

手动升级（便携包 → 已安装服务）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-service.ps1 -SourceDir .
```

失败回滚：安装器/脚本会把旧程序文件暂存在安装目录的 `.rollback-<时间戳>`，失败时自动换回；
如果进程被强杀导致残留，可手工把 `.rollback-*` 里的内容移回安装目录后重新运行脚本。
数据目录与 `.env` 不在回滚范围内（它们始终保留）。

## 12. 卸载

### 安装版

“设置 → 应用 → 已安装的应用”卸载，或“控制面板 → 程序和功能”。

- 卸载器会停止并删除服务、删除防火墙规则、删除程序文件；
- **默认保留** `%ProgramData%\llmapi-manager\data`、`log` 以及一份
  `%ProgramData%\llmapi-manager\.env`（含 `DATA_ENCRYPTION_KEY`）。以后重装会自动复用，
  旧数据仍可解密；
- 保留的 `.env` 也意味着旧的上游 Key 密文还在；不再需要时请用下面的“彻底删除”。

### 彻底删除

先（在卸载前）用管理员 PowerShell 运行：

```powershell
& "C:\Program Files\llmapi-manager\scripts\windows\uninstall-service.ps1" -Purge
```

或者卸载后手工删除 `%ProgramData%\llmapi-manager`。`-Purge` 会删除数据、日志与保留的 `.env`，
**不可恢复**。

### 只用脚本卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-service.ps1
# 只停服务/删防火墙、保留安装目录：-KeepFiles
# 连数据一起删：-Purge
```

## 13. 故障排查

### 服务装上了但启动失败

1. 看 `%ProgramData%\llmapi-manager\log\llmapi-manager-service.err.log` 与 `app.log`；
2. `sc.exe query llmapi-manager` 看状态；
3. 事件查看器 → Windows 日志 → 系统，找服务控制管理器错误；
4. 常见原因：
   - 端口被占用：`netstat -ano | findstr :8787`，改端口或结束占用进程；
   - `.env` 第一行带 BOM：用记事本“另存为 UTF-8（无 BOM）”或重新运行安装脚本；
   - 安装目录下缺少 `server\node_modules`（发行包不完整）；
   - `DATA_DIR` / `LOG_DIR` 无写权限（检查 ProgramData ACL）；
   - `node.exe` 被杀软隔离。

### 健康检查一直失败

安装器/脚本会轮询 `http://127.0.0.1:<Port>/api/health`，90 秒超时。依次检查：

- 端口是否真的在监听：`Get-NetTCPConnection -LocalPort 8787 -State Listen`；
- 服务是否 Running；
- `app.log` 末尾的启动错误；
- `PUBLIC_BASE_URL` 只影响下发给 Agent 的地址，不影响本机健康检查（健康检查固定用 127.0.0.1）；
- 如果 `.env` 里之前残留 `ADMIN_PASSWORD` 且账号已存在，服务不会报错——这是正常的，
  口令不会覆盖已有账号。

### 其它设备访问不了

1. 确认 `HOST=0.0.0.0` 并已重启服务；
2. 确认防火墙规则存在且 Profile 为 Private（当前网络是否被识别为“公用”）；
3. 用 `http://<本机IP>:8787/api/health` 在本机测，再用另一台机器测；
4. 需要给 Agent 下发地址时，把 `PUBLIC_BASE_URL` 改成对端可达地址并重启。

### 忘记管理员口令

`ADMIN_PASSWORD` 只在“默认租户还没有账号”时生效，**不能用来重置已有口令**。可选：

- 如果还能登录其它管理员账号：在「设置」中重置；
- 否则只能停止服务、备份并删除 `%ProgramData%\llmapi-manager\data` 后重新初始化
  （会丢供应商/模型/Agent 配置，且旧 API Key 密文无法恢复）。删除前务必备份。

### Agent 配置下发失败

- 确认 `AGENT_HOME_DIR` 指向**运行 Codex 的用户**家目录，而不是服务账号的家目录；
- 用 `icacls` 检查 `.codex` / `.claude` 是否有服务账号的修改权限；
- 确认 `CODEX_BIN` 存在且服务账号可执行；
- 服务端进程探测在 Windows 上用 `Get-CimInstance Win32_Process`，失败会产生
  `agents.process.tableUnavailable` 告警（见 `/api/health` 的 warnings）。

### 安装/升级失败

- 看 `%ProgramData%\llmapi-manager\install-result.env` 的 `error=` 与日志路径；
- 安装目录下 `.rollback-<时间戳>` 是失败时保留的旧文件；
- 用管理员 PowerShell 重新运行：
  `"<安装目录>\scripts\windows\install-service.ps1" -SourceDir "<安装目录>" -InstallDir "<安装目录>" -SkipCopy`
- 若提示“无法删除服务”，用 `sc.exe delete llmapi-manager` 后重试（先确认服务已停止）。

### PowerShell 执行策略 / 中文乱码

- 脚本统一用 `powershell.exe -ExecutionPolicy Bypass -File ...` 调用；
- 脚本文件保存为 UTF-8 **with BOM**；如果你手工改过编码，中文输出可能乱码，但不影响逻辑；
- `.env` 必须是 UTF-8 **无 BOM**（安装脚本会保证）。

### 下载失败（构建/CI）

`build-package.ps1` 需要访问 nodejs.org 与 github.com。代理环境请设置
`HTTP_PROXY` / `HTTPS_PROXY` 后重试，或事先下载好：

```powershell
# 离线构建：指定本地文件（仍会校验 SHA256）
powershell -ExecutionPolicy Bypass -File .\scripts\windows\build-package.ps1 `
  -NodeZipPath D:\cache\node-v22.23.4-win-x64.zip `
  -WinSwExePath D:\cache\WinSW-x64.exe
```

## 14. 构建发行包

在 **Windows** 构建机上（Linux 不能生成 Windows 安装器；CI 用 `windows-latest`）：

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File .\scripts\windows\build-package.ps1
```

可选参数：

| 参数 | 说明 |
| --- | --- |
| `-Version` | 版本号；默认读根 `package.json` |
| `-OutputDir` | 输出目录；默认 `dist\windows` |
| `-NodeVersion` | 运行时 Node 版本；默认 `22.23.4` |
| `-NodeZipPath` / `-NodeSha256` | 离线 Node zip / 自定义版本校验值 |
| `-WinSwExePath` | 离线 WinSW（仍校验固定 SHA256） |
| `-SkipNpmCi` / `-SkipBuild` | 复用已有依赖/产物（CI 已执行 npm ci 时用） |
| `-NoInstaller` | 只出便携 zip |
| `-NoZip` | 只出安装器 |

脚本会：

1. 组装 stage：`node.exe`、`server\dist`、`server\package.json`、仅 server 的生产依赖
   `server\node_modules`、`web\dist`、WinSW 可执行文件、`scripts\windows`、`docs\windows.md`、
   `.env.example`、`LICENSE`；
2. 校验 Node zip 与 WinSW 的 SHA256；
3. 生成便携 zip 与对应 `.sha256`；
4. 找到 `ISCC.exe` 时生成 Inno 安装包与 `.sha256`，否则只出 zip 并告警。

服务端运行时依赖通过 `npm ls --omit=dev --parseable --all -w @llmapi/server` 的安装闭包复制，
因此 **需要先 `npm ci`**；`-SkipNpmCi` 只适合 CI 中已经装好依赖的场景。

## 15. 上游来源与 SHA256

| 组件 | 版本 | 来源 | SHA256 |
| --- | --- | --- | --- |
| Node.js 运行时 | 22.23.4（win-x64 zip） | `https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip` | `cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20` |
| WinSW | 2.12.0（WinSW-x64.exe） | `https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe` | `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da` |
| Inno Setup | 6.x（构建机安装） | `https://jrsoftware.org/isinfo.php` | 上游安装包，未在仓库内固定 |

说明：

- Node 的校验值有两种保证：脚本内置默认版本的固定值，并可选地对照 nodejs.org 的
  `SHASUMS256.txt`；自定义 `-NodeVersion` 时必须从 `SHASUMS256.txt` 读取（或显式传
  `-NodeSha256`）。
- WinSW 的 GitHub Release **没有官方校验文件**，上表哈希是 2026-10-29 从官方 release
  资产下载后计算的。升级 WinSW 时必须重新计算并同时更新 `build-package.ps1` 中的
  `$WinSwSha256` 与本节，二者保持一致。
- Inno Setup 由构建机自行安装（CI 通过 `choco install innosetup`），版本不固定；
  `installer.iss` 只使用 Inno 6 的通用语法与 `{autopf}`、`LoadStringsFromFile` 等 6.x 能力。
- 仓库 CI（`.github/workflows/ci.yml`）的 `windows-package` job 在 `windows-latest` 上构建
  zip（并尝试安装 Inno Setup 生成 exe），`windows-smoke` job 解压 zip 启动 `node.exe` 做
  `/api/health` 与前端首页冒烟。**CI 不安装 Windows 服务**（需要管理员与真实服务控制管理器），
  所以服务相关路径仍需用户机验证。

## 16. 未签名与安全提示

- 安装包与 zip 都**没有代码签名**。Windows SmartScreen 会拦截“未知发布者”，这是预期行为；
  请先用 SHA256 校验来源可信，再选择“仍要运行”。
- 安装目录的 `.env` 含 `DATA_ENCRYPTION_KEY` 与（首次安装时）`ADMIN_PASSWORD`，ACL 已收紧为
  Administrators + SYSTEM + 服务账号；不要把 `.env` 复制到共享目录或提交到版本库。
- 服务默认监听 `0.0.0.0`，但防火墙规则只对 Private profile 放行；不要把 8787 直接暴露到公网，
  对外请使用 HTTPS 反向代理（并设置 `TRUST_PROXY=1`、`PUBLIC_BASE_URL=https://...`）。
- 多设备同步的快照里是明文上游 Key（见 [sync.md](./sync.md)）；在 Windows 上启用同步且
  需要跨机访问时，优先使用 HTTPS；仅可信内网才考虑 `SYNC_ALLOW_INSECURE=1`。

## 17. 已知限制

- **Node 22 生命周期**：安装包固定 Node 22 LTS x64（Jod，维护到 2027-04）。
  升级运行时只需改 `build-package.ps1` 的默认版本与哈希，并同步 §15。
- **EasyTier 原生模块未包含**：`native/easytier-node`（可选备用引擎）只有 Linux 构建产物，
  Windows 包不包含它。没有它时使用内置自研引擎，NAT 穿透/端口转发等能力不可用。
- **未在真实 Windows 实测**：见文首“验证状态”。CI 能覆盖的解压启动/健康检查路径之外，
  服务安装、ACL、防火墙、Inno 完成页、自定义服务账号都需要 Windows 环境验证。
- **服务账号与用户目录**：默认 LocalSystem + 安装用户家目录的组合已按最小必要授权；
  如果企业策略禁止 SYSTEM 写用户目录，请改用专用服务账号并手工核对 ACL。
