# scripts/windows

Windows 桌面版构建脚本，以及（已退役、仅作迁移/清理的）旧版 Windows 服务脚本。
用户文档在 [`docs/windows.md`](../../docs/windows.md)；本文件只记录维护者需要知道的约定。

## 文件

| 文件 | 作用 |
| --- | --- |
| `build-desktop.ps1` | 构建 Windows 桌面版：准备 `src-tauri/runtime` → `npm run desktop:build`（Tauri/NSIS）→ 输出 setup exe + 便携 zip + sha256 |
| `build-common.ps1` | 构建期共用工具：下载、SHA256、UTF-8 写文件、zip、定位 npm / Node 运行时 |
| `migrate-from-service.ps1` | 旧 WinSW 服务 → 桌面版数据目录的一次性迁移（管理员运行） |
| `legacy-service/common.ps1` | 旧服务脚本的共用函数（冻结，仅 legacy 使用） |
| `legacy-service/install-service.ps1` | 旧版服务安装（已退役；只用于旧机器修复/回滚） |
| `legacy-service/uninstall-service.ps1` | 旧版服务卸载 + 防火墙清理（已退役；只用于旧版清理） |
| `legacy-service/winsw.xml.template` | 旧版 WinSW 2.12 服务配置模板（冻结） |
| `README.md` | 本文件 |

`build-package.ps1`、`installer.iss`、`start-portable.ps1`、`portable-launcher.cmd`
已删除：桌面版不再生成 Inno 安装包/便携启动脚本，安装器由 Tauri NSIS 生成。

## 桌面构建

在 Windows 构建机上（需要 Node 22 x64、Rust stable + MSVC Build Tools、WebView2）：

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\windows\build-desktop.ps1
```

步骤与产物：

1. `npm ci`（`-SkipNpmCi` 跳过）与 `npm run build`（`-SkipBuild` 跳过）产出
   `server/dist`、`web/dist`；
2. 准备 `src-tauri/runtime`（Tauri `bundle.resources` 的来源），布局固定为：

   ```
   src-tauri/runtime/
     node.exe
     server/dist/index.js
     server/package.json
     server/node_modules/        # 仅 server 的生产依赖闭包
     web/dist/
     LICENSE
     docs/*.md
     licenses/node-LICENSE.txt
   ```

3. `npm run desktop:build`（= `tauri build`，`-SkipDesktopBuild` 跳过）；
4. 复制到 `dist/windows/`：

   | 产物 | 说明 |
   | --- | --- |
   | `llmapi-manager-<version>-x64-setup.exe` | NSIS 安装包（Tauri 默认名会被改名成这个） |
   | `llmapi-manager-<version>-win-x64-portable.zip` | 便携包：`llmapi-manager.exe` + `runtime/` 同级，解压即用 |
   | `*.sha256` | 对应产物的 SHA256（`<hash>  <文件名>`，ASCII） |

便携包里的 `runtime/` 与安装包内资源是同一份 stage：桌面端会从 exe 同级
`runtime/`（便携）或 Tauri `resource_dir()/runtime`（安装版）启动
`runtime/node.exe server/dist/index.js`。**如果改了 `src-tauri/src/sidecar.rs`
的运行时布局，必须同步改本脚本第 2 步。**

常用参数：

- `-NodeVersion` / `-NodeZipPath` / `-NodeSha256`：覆盖 Node 运行时（离线构建时传本地 zip）；
- `-RuntimeDir`：只在需要时改 stage 目录（必须是 `src-tauri/` 下的子目录）；
- `-OutputDir`：改输出目录；
- `-NoPortableZip`：只出安装包；
- `-Version`：仅用于校验，必须与 `src-tauri/tauri.conf.json` 的 `version` 一致
  （版本号以 Tauri 配置为准，避免安装包与应用版本不一致）。

Node 运行时固定为 **22.23.4 win-x64**，SHA256 常量在 `build-desktop.ps1` 顶部：

```
cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20
```

升级时同时更新脚本顶部的 `$NodeDefaultVersion` / `$NodeDefaultSha256` 与 `docs/windows.md` 的版本说明。

## 旧服务迁移

`migrate-from-service.ps1` 用于从旧 WinSW 服务升级到桌面版（**首次启动桌面版之前**运行），
需要管理员 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\migrate-from-service.ps1
```

它会：停止/删除 `llmapi-manager` 服务 → 删除旧防火墙规则
（`LLM API Manager (TCP *)`）→ 把 `%ProgramData%\llmapi-manager\data` 复制到
`%APPDATA%\llmapi-manager\data` → 从旧 `.env` 导入 `DATA_ENCRYPTION_KEY` 到
`%APPDATA%\llmapi-manager\desktop.env`。

约定：

- **源数据不删**；目标已存在则跳过（不覆盖）；停止/删除服务、复制数据、导入密钥失败
  都以非零退出码结束（防火墙规则清理失败只告警）；
- `desktop.env` 必须**无 BOM**（桌面端 Rust 逐行 `strip_prefix` 解析）；
- 旧 `.env` 位置依次尝试 `-LegacyEnvFile`、`%ProgramData%\llmapi-manager\.env`、
  旧服务安装目录（从 `sc.exe qc` 解析），服务仍安装时最后一项才命中；
- 迁移脚本**不依赖** `legacy-service/` 下的旧脚本，避免误触发旧安装逻辑。

旧服务卸载（不迁移数据）仍可用 `legacy-service/uninstall-service.ps1`；这两个脚本
不再随桌面版发布，只从仓库或构建机运行。

## 约定

- **Windows PowerShell 5.1 兼容**：不要使用 `??`、`?.`、三元运算符、`-AsHashtable`、
  `ForEach-Object -Parallel`、`Join-Path -AdditionalChildPath` 等 PowerShell 7 专有语法。
  CI 的 `windows-desktop` job 用 `shell: powershell`（5.1）解析全部脚本并实际构建。
- **`.ps1` 必须 UTF-8 with BOM**：Windows PowerShell 5.1 对没有 BOM 的 `.ps1` 按系统
  ANSI 代码页解码，中文会乱码。`build-common.ps1` 的 `Write-TextFileUtf8` 默认**不带**
  BOM——那是给 `.env` / `desktop.env` 用的，别混用。
- **JSON / YAML 不要 BOM**（`tauri.conf.json`、`ci.yml`）；`.cmd` 只用 ASCII。
- **路径操作用 `-LiteralPath`**，避免 `[]` 被当成通配符。
- **版本与 SHA256 常量集中在 `build-desktop.ps1` 顶部**；`build-common.ps1` 只放通用工具，
  不写死版本。
- **不要声称已在 Windows 实测**：本仓库开发环境是 Linux。改动后看 CI 的
  `windows-desktop` / `windows-desktop-smoke`，服务迁移/ACL/防火墙/托盘等仍需真实
  Windows 机器验证。

## CI

`.github/workflows/ci.yml`：

- `test`：ubuntu + windows 矩阵，Node 22，`npm ci` / `npm run typecheck` / `npm test`；
- `windows-desktop`：windows-latest，Node 22 + Rust stable，`npm ci` 后运行
  `build-desktop.ps1 -SkipNpmCi`，上传 `windows-desktop` artifact（`dist/windows/*`）；
- `windows-desktop-smoke`：下载 artifact、解压便携包，用 `runtime/node.exe` 启动
  `server/dist/index.js`，检查 `/api/health` 与前端首页。**不启动 GUI**，也不验证
  托盘、首次初始化、防火墙与迁移脚本。
