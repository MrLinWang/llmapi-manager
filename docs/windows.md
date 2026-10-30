# Windows 桌面应用

Windows 上的发行形态是 **Tauri 2 桌面应用**：窗口内嵌现有 Web UI（没有地址栏），
后端仍是本地 Node / Fastify sidecar，随 App 启动与停止。**不再安装 Windows 服务**，
也没有 WinSW、`services.msc` 里的 `llmapi-manager`，或 LocalSystem 服务账号。

本文档覆盖安装、启动与托盘、首次初始化、数据与日志、局域网访问、旧服务迁移、卸载、
端口冲突、SmartScreen / WebView2、构建与 CI。源码方式（`npm run dev` / `npm start`）
见 [development.md](./development.md) 与根目录 README。

> **验证状态（请务必阅读）**
>
> 本仓库的开发环境是 Linux，**没有在真实 Windows 上实测过桌面壳**。
> CI 的 `windows-desktop`（构建）与 `windows-desktop-smoke`（最小冒烟：启动 sidecar、
> 探测 `/api/health` 一类）只覆盖打包与启动，**不覆盖 GUI、托盘、首次初始化、局域网访问、
> 防火墙与旧服务迁移**。这些路径需要在真实 Windows 机器上按本文档手工验收。
> 不要因为 CI 通过就声称 Windows 桌面端已实测。

## 1. 形态：桌面应用，不是服务，也不是浏览器标签页

| | 旧形态（已废弃） | 现形态 |
| --- | --- | --- |
| 分发 | Inno Setup 安装器 + 便携 zip | Tauri NSIS 安装包 + 便携 zip |
| 进程 | WinSW 托管的 Windows 服务，开机常驻 | 桌面 App + 子进程 sidecar，随 App 启停 |
| 界面 | 浏览器打开的 `http://127.0.0.1:8787` | App 窗口内嵌 Web UI，无地址栏 |
| 监听 | 安装版默认 `0.0.0.0` | 默认 `127.0.0.1`，托盘显式开启后才监听局域网 |
| 数据 | `%ProgramData%\llmapi-manager\` | `%APPDATA%\llmapi-manager\` |
| 运行账号 | `LocalSystem`（或自定义服务账号） | 当前登录用户 |
| 首次初始化 | 控制台/服务日志打印令牌，或安装器写 `ADMIN_PASSWORD` | 桌面 launcher 捕获一次性令牌并自动打开初始化页 |
| 关闭行为 | 服务继续运行 | 窗口隐藏到托盘；托盘「退出」才停止网关 |

因此：

- 任务管理器里看到的是桌面 App 与它启动的 `node.exe` 子进程，**不是** Windows 服务；
- `Get-Service llmapi-manager` / `sc.exe query llmapi-manager` 在新装机器上应当**查不到**；
- 不再需要管理员权限运行日常使用，也不需要给服务账号授予用户目录权限。

## 2. 系统要求与产物

系统要求：

- Windows 10 / Windows 11，**x64**（ARM64 未验证）。
- **WebView2 Runtime**。安装包内置 WebView2 bootstrapper，缺失时会尝试安装；
  便携包不负责安装运行时，需要系统已有 WebView2（Windows 11 通常自带，
  Windows 10 一般随 Edge 更新存在）。
- 安装包按机器安装到 `Program Files`，安装时需要管理员确认；日常运行不需要管理员。

构建产物：

| 文件 | 说明 |
| --- | --- |
| `llmapi-manager-<version>-x64-setup.exe` | Tauri NSIS 安装包，安装桌面 App |
| `llmapi-manager-<version>-win-x64-portable.zip` | 便携包：解压后直接运行，不写安装目录 |
| `*.sha256` | 对应产物的 SHA256（若构建脚本生成） |

桌面包自带 Node 运行时，目标机器**不需要预装 Node**。端口固定为 **8787**。

安装包与 zip 都**没有代码签名**，SmartScreen 会提示“未知发布者”（见 §12）。

## 3. 安装

1. 下载 `llmapi-manager-<version>-x64-setup.exe` 与同名 `.sha256`（如有），先校验：

   ```powershell
   Get-FileHash .\llmapi-manager-<version>-x64-setup.exe -Algorithm SHA256
   # 与 .sha256 文件内容比对
   ```

2. 双击安装。SmartScreen 提示时点“更多信息”→“仍要运行”。
3. 安装完成后从开始菜单或桌面快捷方式启动 **LLM API Manager**。
4. 首次启动的初始化流程见 §5。

安装**不会**注册 Windows 服务，也不会创建 `services.msc` 条目。如果机器上还留有
旧版服务，请先按 §9 迁移或卸载。

### 便携包

1. 解压 `llmapi-manager-<version>-win-x64-portable.zip` 到任意可写目录。
2. 运行解压目录里的 `llmapi-manager.exe`（便携包内统一用这个文件名）。
3. 数据与日志**仍然写 `%APPDATA%\llmapi-manager\`**（不是包目录），所以便携包与安装版
   共用同一份用户数据；换目录解压不会复制配置。
4. 便携包不注册任何开机启动项或服务。

## 4. 启动、窗口、托盘与退出

- 启动后 App 先拉起本地 sidecar，等待 `/api/health` 通过，再在窗口里加载控制台。
  启动失败时窗口会停在加载页或显示错误，详细原因见 `%APPDATA%\llmapi-manager\log\`（§6）。
- 窗口**内嵌**控制台，没有地址栏、不能输入 URL。日常使用不需要浏览器；调试或需要
  对照浏览器行为时，仍可用浏览器访问同一地址 `http://127.0.0.1:8787`（仅本机）。
- **关闭窗口 = 隐藏到托盘**，默认不会退出：网关继续运行，已下发的 Agent 配置仍可用。
  第一次关闭窗口时会提示“App 仍在托盘运行”。
- 托盘菜单：
  - **打开控制台**：重新显示窗口；
  - **允许局域网访问**：切换 sidecar 的监听范围（见 §7），切换后会重启 sidecar；
  - **退出**：停止 sidecar 并结束 App。**只有这里会真正停掉网关**。
- 托盘图标还在说明 App 仍在运行；sidecar 是否健康以窗口能否加载与 `/api/health` 为准
  （sidecar 崩溃时 App 可能仍在托盘并显示错误）。

> 不要用“结束 `node.exe`”来退出 App：那会让桌面壳与 sidecar 状态不一致。需要停止时
> 用托盘「退出」；App 异常无响应时再在任务管理器结束整个 App（含子进程）。

## 5. 首次初始化

首次启动（默认租户里还没有账号）：

1. 桌面 launcher 启动 sidecar，并从 sidecar 的 stdout 捕获一次性初始化令牌
   （形如 `setup_...`）。
2. App 自动打开内嵌的 `/setup#token=...`，令牌已带入，不需要用户从控制台复制。
3. 用户设置**自己的**管理员用户名与口令（口令至少 8 位），提交后进入控制台。
4. 令牌立即作废，后续初始化接口一律拒绝，不会覆盖已有管理员。

已有账号时：App 打开登录页/控制台，不再生成初始化令牌。

**初始化中途退出**：下次启动时桌面 launcher 会让 sidecar 重新生成令牌（轮换
`data/setup.json`），然后再次自动打开初始化页。桌面版**不需要**“从控制台抄令牌”这一步。

> 桌面版没有控制台窗口。如果初始化页没有自动带令牌，先退出 App 再启动一次，
> 不要手工编辑 `setup.json`。若账号其实已创建，重启后直接进入登录页是正常现象。

`ADMIN_PASSWORD` 环境变量仍可用于 Linux/Docker 等无交互部署，但**不是 Windows 桌面的
正常初始化路径**：桌面版不会替你写 `.env`，也不建议把口令放在环境变量里。

## 6. 数据、日志与加密密钥

桌面版的所有可变数据都在当前用户的 `%APPDATA%` 下：

```
%APPDATA%\llmapi-manager\
├── data\            租户数据（供应商、设置、Agent 快照、请求日志、同步基线……）
├── log\             运行日志（服务端 app.log 与桌面壳捕获的 sidecar 输出）
├── desktop.env      只存 DATA_ENCRYPTION_KEY（仅当前用户可读）
└── （桌面偏好，如 LAN 开关，也保存在此目录；非机密，可删除后重建）
```

- `%APPDATA%` 通常展开为 `C:\Users\<用户名>\AppData\Roaming`。
- `desktop.env` 由桌面壳生成，内容是 `DATA_ENCRYPTION_KEY=...`。**不要删除或外传**：
  丢失后已加密的上游 API Key / 网关令牌无法解密，只能重新填写。
- 文件权限按当前用户收紧（`desktop.env` 只授予当前用户与 SYSTEM）。同一台机器的其它
  标准用户默认读不到，但管理员可以。
- 日志目录与数据目录分开，迁移 `data\` 时不会带走日志。
- Agent 文件的写前备份仍落在被改文件的同目录（如 `~\.codex\config.toml.bak-<时间戳>`），
  不在 `%APPDATA%` 下。
- 旧服务时代的 `%ProgramData%\llmapi-manager\` **不会被桌面版读取**；需要旧数据时按 §9 迁移。

日志排查：

```powershell
Get-Content "$env:APPDATA\llmapi-manager\log\app.log" -Tail 100 -Wait
Get-ChildItem "$env:APPDATA\llmapi-manager\log"
```

`app.log` 由服务端日志器写入，会按 key 名与正则打码，不会主动写完整 API Key、
网关令牌或口令。`desktop-server.log` 是桌面壳对 sidecar stdout/stderr 的原样捕获，
可能包含启动横幅（含一次性初始化令牌）；请把它当作当前用户目录下的敏感文件，
排查完可删除。初始化令牌在完成初始化后即作废。

## 7. 局域网访问、防火墙与同步

默认只监听 `127.0.0.1:8787`，**只有本机能访问**。当这台 Windows 机器要作为配置同步的
`master` 或 `peer`（即其它设备要拉取它的快照）时，才需要开放局域网：

1. 托盘菜单勾选 **允许局域网访问**。App 会重启 sidecar，把监听地址切到 `0.0.0.0:8787`；
   取消勾选则切回 `127.0.0.1`。
2. 在**管理员** PowerShell 里放行入站 TCP 8787（**专用网络 / Private**）：

   ```powershell
   New-NetFirewallRule -DisplayName "LLM API Manager (TCP 8787)" `
     -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8787 `
     -Profile Private
   ```

3. 确认监听与规则：

   ```powershell
   Get-NetTCPConnection -LocalPort 8787 -State Listen
   Get-NetFirewallRule -DisplayName 'LLM API Manager*' | Format-Table DisplayName,Enabled,Profile
   ```

4. 对端填 `http://<这台机器的局域网 IP>:8787`（例如 `http://192.168.1.20:8787`），
   **不要填 `127.0.0.1`**——那是对端自己。

`PUBLIC_BASE_URL` 在桌面版中默认**固定为 `http://127.0.0.1:8787`**，不会因为开了局域网
而改变：本机 Agent 走回环最稳。只有“其它设备上的 Agent 也要经这台网关”时，才需要另行
设置这个值（桌面版不引导这一步，属高级/手工场景）。

必须知道的边界：

- 开启局域网后，控制台、网关与管理接口都会对局域网可达，不只是同步快照。只在可信网络
  临时开启，用完取消勾选。
- 链路是**明文 HTTP**。局域网同步要么用 HTTPS 反向代理 + `TRUST_PROXY=1`，要么只在
  完全可信的内网显式设置 `SYNC_ALLOW_INSECURE=1`（**两端都要设**）。快照里是上游 Key
  明文，详见 [sync.md](./sync.md#凭据为什么必须明文过网) 与 [security.md](./security.md)。
- Windows 把当前网络识别为 **公用（Public）** 时，上面的 Private 规则不生效，表现为
  连接超时。把网络改成专用，或按需补一条对应配置档的规则——不要把规则开到公网。
- 端口固定 8787，不能改成别的端口来“绕开”占用（见 §8）。

## 8. 端口固定 8787，冲突时不自动换端口

桌面版把网关端口固定为 **8787**：`PUBLIC_BASE_URL`、已下发的 Agent 配置、同步地址都按
这个端口写死。端口被其它进程占用时，App 会**启动失败并报错**，不会自动改用 8787 之外的
端口（自动换端口会让旧 Agent 配置悄悄失效）。

处理：

```powershell
netstat -ano | findstr :8787
# 找到 PID 后确认是什么进程；确认可结束后：
taskkill /PID <pid> /F
```

如果占用者正是上一次残留的 sidecar（App 异常退出），先结束残留 `node.exe`，再重新启动 App。
不要试图通过改端口解决：桌面版没有提供端口配置入口。

## 9. 旧 Windows 服务迁移

只有从**旧版 WinSW 服务**升级过来的机器才需要这一节。新安装包不再注册服务，旧服务脚本
也只保留为 legacy 迁移/卸载路径，**不再推荐**日常使用。

迁移脚本会：

1. 停止并删除旧的 `llmapi-manager` Windows 服务（如果存在）；
2. 把 `%ProgramData%\llmapi-manager\data` 复制到 `%APPDATA%\llmapi-manager\data`；
3. 从旧 `.env` 导入 `DATA_ENCRYPTION_KEY` 到 `%APPDATA%\llmapi-manager\desktop.env`，
   使旧的上游 Key 密文仍能解密；
4. **保留源数据**（`%ProgramData%` 下的原目录不删除），便于回滚。

迁移脚本在**仓库或构建机**的 `scripts\windows\` 下，**不会被打进便携 zip**。
在首次启动桌面版之前，从仓库/构建机以管理员 PowerShell 运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\migrate-from-service.ps1
```

迁移后：

1. 启动桌面 App。若桌面数据目录还是空的，会直接使用迁移过来的数据；
2. 用旧账号登录，确认供应商、模型、Agent 配置与请求日志都在；
3. 用旧 `DATA_ENCRYPTION_KEY` 加密的供应商 Key 应能正常使用；若提示无法解密，
   检查 `desktop.env` 是否成功写入；
4. 验证无误后再手工删除 `%ProgramData%\llmapi-manager\`（脚本不会替你删源数据）。

旧服务卸载（不迁移数据）时，使用 `scripts/windows/legacy-service/` 下保留的旧脚本，
或先运行 `migrate-from-service.ps1` 再删除 `%ProgramData%`。新桌面版不需要、也不会再安装服务。

## 10. 升级

- **安装版**：先从托盘「退出」App，再运行新版本
  `llmapi-manager-<version>-x64-setup.exe` 覆盖安装。安装程序替换程序文件；
  `%APPDATA%\llmapi-manager\` 下的数据、日志与 `desktop.env` 默认保留，
  `DATA_ENCRYPTION_KEY` 不会重新生成。
- **便携包**：退出 App，解压新包覆盖旧程序文件。数据在 `%APPDATA%`，不受影响。
- 升级后启动 App，登录确认供应商/模型/Agent 配置仍在即可；不需要 `Restart-Service`。

需要回退版本时：退出 App 后重新安装旧版本安装包。数据与 `desktop.env` 不在程序目录里，
不会被安装程序覆盖，旧版本仍可读取。

## 11. 卸载与数据保留

- “设置 → 应用 → 已安装的应用”（或控制面板 → 程序和功能）卸载 **LLM API Manager**。
- 卸载器删除程序文件与快捷方式，**默认保留** `%APPDATA%\llmapi-manager\` 下的
  `data`、`log` 与 `desktop.env`。以后重装会复用，旧数据仍可解密。
- 保留的数据里仍可能有上游 Key 密文；不再需要时彻底删除：

  ```powershell
  Remove-Item "$env:APPDATA\llmapi-manager" -Recurse -Force
  ```

  这一步**不可恢复**，执行前确认已经备份或不再需要。
- 若机器上还留着旧服务，先按 §9 迁移/卸载，再删除 `%ProgramData%\llmapi-manager\`。
- 卸载**不会**删除已写入 Agent 的 `~\.codex` / `~\.claude` 配置；那些文件由 Agent 自己使用，
  需要时在 App 里先「还原」或手工清理。

## 12. SmartScreen 与 WebView2

- 安装包和 zip **未签名**。SmartScreen 的“Windows 已保护你的电脑”是预期行为：
  先用 SHA256 校验来源可信，再点“更多信息”→“仍要运行”。企业环境请按内部策略放行。
- 安装包内置 WebView2 bootstrapper；离线或被策略拦截时会安装失败，可先手工安装
  [WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
- 便携包要求系统已有 WebView2；没有时窗口无法创建。
- 只支持 Windows 10/11 x64；ARM64 未验证。

## 13. 构建与 CI

桌面壳在 `src-tauri/`（Rust + Tauri 2），加载页在 `desktop/`，构建脚本为
`scripts/windows/build-desktop.ps1`。

构建机需要：

- Node.js 22 LTS x64（与仓库其它构建一致）；
- Rust 工具链（stable）与 MSVC Build Tools（Tauri 的 Windows 目标）；
- WebView2 Runtime（本机运行安装包时也需要）；
- 能访问 npm / crates.io 的网络（或预先配置镜像）。

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File .\scripts\windows\build-desktop.ps1
```

脚本会先构建 `web/dist` 与 `server/dist`，再调用 Tauri 打包 NSIS 安装包，并组装便携 zip；
默认输出到 `dist\windows\`。具体参数以脚本输出为准。

开发时不要每次都打包：

```bash
npm run desktop:dev
```

它会启动 Vite + server 并打开 Tauri 开发窗口（需要 Rust/WebView2）。生产使用安装包，
不要用 `desktop:dev` 当部署方式。

CI 的 **`windows-desktop`**（构建）与 **`windows-desktop-smoke`**（冒烟）job 在
`windows-latest` 上运行；它们**不启动 GUI**，也不验证托盘、首次初始化、防火墙或迁移脚本。
Windows 桌面端最终以真实机器验收为准。

## 14. 故障排查

### App 启动后窗口空白 / 一直加载

sidecar 没起来或健康检查失败。看：

```powershell
Get-Content "$env:APPDATA\llmapi-manager\log\desktop-server.log" -Tail 100
Get-Content "$env:APPDATA\llmapi-manager\log\app.log" -Tail 100
```

常见原因：8787 被占用（§8）、安装包缺少 Node 运行时、`desktop.env` 权限异常、
杀软隔离了 `node.exe`。

### 初始化页没有令牌 / 反复要求初始化

- 先退出 App 再启动一次：桌面 launcher 会重新生成令牌。
- 确认 `%APPDATA%\llmapi-manager\data\setup.json` 可写；损坏时看 `app.log`。
- 如果账号已经创建，正常表现是打开登录页而不是初始化页。

### 托盘图标不见了 / 关不掉

- 托盘图标被折叠时，点任务栏的“^”展开。
- 用托盘「退出」停止网关；App 无响应时在任务管理器结束 **LLM API Manager** 及其
  `node.exe` 子进程，再重新启动。

### 其它设备访问不了

1. 托盘是否勾选「允许局域网访问」（勾选后 sidecar 会重启）；
2. 防火墙规则是否存在且 Profile 为 Private；当前网络是否被识别为“公用”；
3. 用 `http://<本机IP>:8787/api/health` 在本机与对端各测一次；
4. 同步还要满足 HTTPS / `SYNC_ALLOW_INSECURE=1` 的协议检查，见 [sync.md](./sync.md#windows-与局域网)。

### 旧数据没有出现

- 确认迁移脚本是在首次启动桌面版**之前**运行的，且复制到了
  `%APPDATA%\llmapi-manager\data`；
- 确认 `desktop.env` 里有 `DATA_ENCRYPTION_KEY`；没有它时旧密文无法解密；
- 看 `app.log` 是否有 `credential_decrypt_failed` 告警。

### 端口被占用

见 §8。桌面版没有换端口选项。

### SmartScreen 拦截 / WebView2 缺失

见 §12。

## 15. 验证边界与已知限制

- **未在真实 Windows 实测**：本仓库开发环境是 Linux。CI 的 `windows-desktop` /
  `windows-desktop-smoke` 只构建与冒烟；GUI、托盘、首次初始化、局域网、防火墙、迁移脚本
  都需要在真实 Windows 上验收。
- **端口固定 8787**：没有自动换端口，也没有图形化端口配置。
- **未签名**：SmartScreen 提示是预期行为，没有代码签名证书。
- **Windows 没有 headless/服务模式**：桌面版必须由用户登录会话启动；服务器/无人值守部署
  请继续用 Linux + `npm start`（服务模式不变）。
- **局域网是明文 HTTP**：开启后控制台与网关都在局域网上可达；同步快照里是上游 Key 明文，
  只在可信网络临时开启，优先 HTTPS。
- **EasyTier 原生模块**：`native/easytier-node` 只有 Linux 构建产物，Windows 包不包含它；
  同局域网 HTTP 同步不依赖它，继续用 `builtin` 引擎。
- 旧服务数据不会自动出现，必须显式运行迁移脚本；源数据默认保留，需手工清理。
