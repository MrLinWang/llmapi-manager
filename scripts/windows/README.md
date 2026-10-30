# scripts/windows

Windows 便携包、Inno Setup 安装器与 WinSW 服务脚本。用户文档在
[`docs/windows.md`](../../docs/windows.md)；本文件只记录维护者需要知道的约定。

## 文件

| 文件 | 作用 |
| --- | --- |
| `build-package.ps1` | 构建 Windows x64 便携 zip +（可选）Inno 安装包 |
| `install-service.ps1` | 安装/升级 Windows 服务（安装器在结束时调用它） |
| `uninstall-service.ps1` | 停止/删除服务、删防火墙，默认保留数据 |
| `start-portable.ps1` | 便携包前台启动；首次运行生成包内 `.env` |
| `portable-launcher.cmd` | 构建时复制为包根目录的 `start-portable.cmd` |
| `common.ps1` | 共用函数（管理员检查、随机串、.env 解析、ACL、robocopy 等） |
| `winsw.xml.template` | WinSW 2.12 服务配置模板 |
| `installer.iss` | Inno Setup 6 安装脚本 |

## 构建

在 Windows 上：

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts\windows\build-package.ps1
```

输出在 `dist/windows/`。详细参数与离线构建方式见 `docs/windows.md` §14。

## 约定

- **Windows PowerShell 5.1 兼容**：不要使用 `??`、`?.`、三元运算符、`-AsHashtable`、
  `ForEach-Object -Parallel`、`Join-Path -AdditionalChildPath` 等 PowerShell 7 专有语法。
  CI 的 Windows job 用 `shell: powershell`（5.1）做语法解析检查。
- **脚本文件必须是 UTF-8 with BOM**：Windows PowerShell 5.1 对没有 BOM 的 `.ps1` 按系统
  ANSI 代码页解码，中文会乱码。`.iss` 也用 BOM（兼容 Inno 6.0–6.2）。
  `.cmd` 只用 ASCII（按 OEM/ANSI 读取）。
- **`.env` 必须无 BOM**：服务端 `applyEnvFile` 不会剥 BOM，带 BOM 会让第一行键名失效。
  `common.ps1` 的 `Write-TextFileUtf8` 默认就是无 BOM。
- **ACL 用 SID 而不是本地化名称**：`*S-1-5-18`(SYSTEM)、`*S-1-5-32-544`(Administrators)、
  `*S-1-5-19`/`*S-1-5-20`(LocalService/NetworkService)。
- **数据目录**：安装版固定 `%ProgramData%\llmapi-manager`；升级/卸载默认保留，`.env` 也会
  复制到 `%ProgramData%\llmapi-manager\.env`，否则丢了 `DATA_ENCRYPTION_KEY` 旧数据无法解密。
- **版本与 SHA256 常量集中在 `build-package.ps1` 顶部**。升级 Node/WinSW 时同时更新
  常量与 `docs/windows.md` §15。WinSW 上游不提供校验文件，哈希需人工从 release 资产计算。
- **不要声称已在 Windows 实测**：本仓库开发环境是 Linux。改动后至少在 CI 的
  `windows-package` / `windows-smoke` 两个 job 里验证，服务相关改动需在 Windows 机器上手工验证。

## CI

`.github/workflows/ci.yml`：

- `test`：ubuntu + windows 矩阵，Node 22，`npm ci` / `npm run typecheck` / `npm test`；
- `windows-package`：构建 zip，尝试用 choco 安装 Inno Setup 生成 exe，上传 artifact；
- `windows-smoke`：下载 artifact、解压、启动 `node.exe`，检查 `/api/health` 与前端首页。
