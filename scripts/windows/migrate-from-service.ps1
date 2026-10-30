<#
.SYNOPSIS
把旧版 llmapi-manager Windows 服务（WinSW）迁移到桌面版的用户数据目录。

.DESCRIPTION
旧版本把 llmapi-manager 注册成 Windows 服务，数据在 `%ProgramData%\llmapi-manager`；
桌面版（Tauri + 内置 Node sidecar）以当前用户运行，数据在 `%APPDATA%\llmapi-manager`。
本脚本以管理员身份完成：

  1. 停止并删除旧的 `llmapi-manager` 服务（如果存在）；
  2. 删除旧服务创建/遗留的防火墙规则（`LLM API Manager (TCP *)`）；
  3. 把 `%ProgramData%\llmapi-manager\data` 复制到 `%APPDATA%\llmapi-manager\data`；
  4. 从旧 `.env` 导入 `DATA_ENCRYPTION_KEY` 到 `%APPDATA%\llmapi-manager\desktop.env`，
     否则旧的上游 Key 密文在新机器上无法解密。

安全约定：
  * **源数据一律保留**（不删 `%ProgramData%` 下的任何东西），便于回滚；
  * **目标已存在则跳过**，绝不覆盖桌面版已有数据/密钥；
  * 停止/删除服务、复制数据、导入密钥失败都以非零退出码结束；
    防火墙规则清理失败只告警（规则残留无害，不阻塞数据迁移）；
  * `desktop.env` 必须无 BOM：Rust 侧逐行 `strip_prefix("DATA_ENCRYPTION_KEY=")` 读取，
    BOM 会让第一行匹配不上。

建议在**首次启动桌面版之前**运行。如果桌面版已经启动过，它会先创建
`%APPDATA%\llmapi-manager\data`（空目录），此时本脚本按“目标已存在”跳过数据复制；
可以先退出 App、删除该空目录后重跑。

只支持 Windows，需要管理员 PowerShell。
本脚本刻意不依赖 legacy-service/ 下的旧脚本，避免旧安装逻辑被误触发。
#>
[CmdletBinding()]
param(
    [string]$ServiceName = 'llmapi-manager',
    [string]$LegacyProgramDataDir = '',
    [string]$TargetAppDataDir = '',
    [string]$LegacyEnvFile = '',
    [switch]$SkipServiceRemoval,
    [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Assert-Administrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal -ArgumentList $identity
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '此操作需要管理员权限。请右键“以管理员身份运行”PowerShell。'
    }
}

function Read-EnvValue {
    <#
    .SYNOPSIS
    从 .env 里读取一个键的值（去掉两端引号）；不存在时返回空串。
    #>
    param(
        [string]$Path,
        [string]$Key
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return ''
    }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $trimmed = $line.Trim()
        if ($trimmed.Length -eq 0 -or $trimmed.StartsWith('#')) {
            continue
        }
        $eq = $trimmed.IndexOf('=')
        if ($eq -le 0) {
            continue
        }
        $name = $trimmed.Substring(0, $eq).Trim()
        if (-not $name.Equals($Key, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $value = $trimmed.Substring($eq + 1).Trim()
        return $value.Trim('"').Trim("'")
    }
    return ''
}

function Resolve-ServiceInstallDir {
    <#
    .SYNOPSIS
    通过 `sc.exe qc` 找到旧服务的安装目录；取不到时返回空串。

    .DESCRIPTION
    旧版安装时 `.env` 在安装目录（通常是 `C:\Program Files\llmapi-manager`），
    只有卸载后才被复制到 `%ProgramData%\llmapi-manager\.env`。服务还在时要把
    DATA_ENCRYPTION_KEY 从安装目录的 .env 读出来。
    #>
    param([string]$Name)

    try {
        $output = @(& sc.exe qc $Name 2>$null)
    } catch {
        return ''
    }
    foreach ($line in $output) {
        $text = [string]$line
        if ($text -notmatch 'BINARY_PATH_NAME\s*:\s*(.+)$') {
            continue
        }
        $binary = $Matches[1].Trim()
        $exePath = $binary
        if ($exePath -match '^"([^"]+)"') {
            $exePath = $Matches[1]
        } else {
            $exePath = ($exePath -split '\s+')[0]
        }
        if ([string]::IsNullOrWhiteSpace($exePath)) {
            return ''
        }
        $dir = Split-Path -Parent $exePath
        if (-not [string]::IsNullOrWhiteSpace($dir) -and (Test-Path -LiteralPath $dir -PathType Container)) {
            return $dir
        }
    }
    return ''
}

$exitCode = 0
try {
    if ($env:OS -ne 'Windows_NT') {
        throw '本脚本只能在 Windows 上运行。'
    }
    Assert-Administrator

    # -----------------------------------------------------------------------
    # 0. 解析路径（允许用户显式覆盖，便于企业环境把数据放到非默认位置）
    # -----------------------------------------------------------------------
    if ([string]::IsNullOrWhiteSpace($LegacyProgramDataDir)) {
        $base = $env:ProgramData
        if ([string]::IsNullOrWhiteSpace($base)) {
            $base = [Environment]::GetFolderPath('CommonApplicationData')
        }
        if ([string]::IsNullOrWhiteSpace($base)) {
            throw '无法确定 ProgramData 目录，请用 -LegacyProgramDataDir 显式指定。'
        }
        $LegacyProgramDataDir = Join-Path $base 'llmapi-manager'
    }
    $LegacyProgramDataDir = [System.IO.Path]::GetFullPath($LegacyProgramDataDir).TrimEnd('\')

    if ([string]::IsNullOrWhiteSpace($TargetAppDataDir)) {
        $appData = $env:APPDATA
        if ([string]::IsNullOrWhiteSpace($appData)) {
            $appData = [Environment]::GetFolderPath('ApplicationData')
        }
        if ([string]::IsNullOrWhiteSpace($appData)) {
            throw '无法确定 APPDATA 目录，请用 -TargetAppDataDir 显式指定。'
        }
        $TargetAppDataDir = Join-Path $appData 'llmapi-manager'
    }
    $TargetAppDataDir = [System.IO.Path]::GetFullPath($TargetAppDataDir).TrimEnd('\')

    if ($TargetAppDataDir -ieq $LegacyProgramDataDir) {
        throw "目标目录与旧数据目录相同（$TargetAppDataDir），拒绝继续。"
    }

    $sourceData = Join-Path $LegacyProgramDataDir 'data'
    $targetData = Join-Path $TargetAppDataDir 'data'
    $targetEnv = Join-Path $TargetAppDataDir 'desktop.env'

    # 旧 .env 位置：显式参数 > ProgramData（卸载后保留的副本）> 服务安装目录（服务仍安装时）
    if (-not [string]::IsNullOrWhiteSpace($LegacyEnvFile)) {
        $LegacyEnvFile = [System.IO.Path]::GetFullPath($LegacyEnvFile)
    } else {
        $LegacyEnvFile = Join-Path $LegacyProgramDataDir '.env'
        if (-not (Test-Path -LiteralPath $LegacyEnvFile -PathType Leaf)) {
            $installDir = Resolve-ServiceInstallDir -Name $ServiceName
            if (-not [string]::IsNullOrWhiteSpace($installDir)) {
                $candidate = Join-Path $installDir '.env'
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    $LegacyEnvFile = $candidate
                }
            }
        }
    }

    Write-Host "旧数据目录：$LegacyProgramDataDir"
    Write-Host "旧配置：$LegacyEnvFile"
    Write-Host "桌面数据目录：$TargetAppDataDir"

    # -----------------------------------------------------------------------
    # 1. 停止并删除旧 Windows 服务
    # -----------------------------------------------------------------------
    Write-Section '停止并删除旧服务'
    if ($SkipServiceRemoval.IsPresent) {
        Write-Host '已按 -SkipServiceRemoval 跳过服务停止/删除。'
    } else {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -eq $service) {
            Write-Host "未发现旧服务 $ServiceName，跳过。"
        } else {
            if ($service.Status -ne 'Stopped') {
                Write-Host "正在停止服务 $ServiceName（当前：$($service.Status)）..."
                & sc.exe stop $ServiceName | Out-Null
                $stopped = $false
                for ($i = 0; $i -lt 30; $i++) {
                    Start-Sleep -Seconds 1
                    $service.Refresh()
                    if ($service.Status -eq 'Stopped') {
                        $stopped = $true
                        break
                    }
                }
                if (-not $stopped) {
                    throw "无法停止服务 $ServiceName（当前：$($service.Status)）。请先手动停止后重试。"
                }
            }

            & sc.exe delete $ServiceName | Out-Null
            $gone = $false
            for ($i = 0; $i -lt 15; $i++) {
                Start-Sleep -Seconds 1
                if ($null -eq (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
                    $gone = $true
                    break
                }
            }
            if (-not $gone) {
                throw "无法删除服务 $ServiceName。请用管理员 PowerShell 执行：sc.exe delete $ServiceName"
            }
            Write-Host "服务已停止并删除：$ServiceName"
        }
    }

    # -----------------------------------------------------------------------
    # 2. 删除旧防火墙规则（规则本身无害，删不掉只告警，不阻塞数据迁移）
    # -----------------------------------------------------------------------
    Write-Section '删除旧防火墙规则'
    if ($SkipFirewall.IsPresent) {
        Write-Host '已按 -SkipFirewall 跳过防火墙规则清理。'
    } else {
        try {
            $rules = @(Get-NetFirewallRule -DisplayName 'LLM API Manager (TCP *' -ErrorAction SilentlyContinue)
            foreach ($rule in $rules) {
                Remove-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Out-Null
                Write-Host "已删除防火墙规则：$($rule.DisplayName)"
            }
            if ($rules.Count -eq 0) {
                Write-Host '未发现旧防火墙规则。'
            }
        } catch {
            Write-Warning "删除防火墙规则失败（可在 Windows Defender 防火墙中手动删除）：$($_.Exception.Message)"
        }
    }

    # -----------------------------------------------------------------------
    # 3. 复制数据（源保留；目标存在则跳过）
    # -----------------------------------------------------------------------
    Write-Section '复制旧数据'
    if (-not (Test-Path -LiteralPath $sourceData -PathType Container)) {
        Write-Host "未发现旧服务数据目录，跳过数据复制：$sourceData"
    } elseif (Test-Path -LiteralPath $targetData) {
        Write-Host "目标数据目录已存在，跳过数据复制（不会覆盖）：$targetData"
    } else {
        New-Item -ItemType Directory -Force -Path $TargetAppDataDir | Out-Null
        # robocopy /E 复制子目录（含空目录）；退出码 0-7 都算成功，>=8 才是错误。
        & robocopy.exe $sourceData $targetData /E /COPY:DAT /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
        $robocopyCode = $LASTEXITCODE
        if ($robocopyCode -ge 8) {
            throw "复制旧数据失败（robocopy 退出码 $robocopyCode）：$sourceData -> $targetData"
        }
        Write-Host "已复制旧数据到：$targetData（源目录保留）"
    }

    # -----------------------------------------------------------------------
    # 4. 导入 DATA_ENCRYPTION_KEY（目标存在则跳过）
    # -----------------------------------------------------------------------
    Write-Section '导入 DATA_ENCRYPTION_KEY'
    $legacyKey = Read-EnvValue -Path $LegacyEnvFile -Key 'DATA_ENCRYPTION_KEY'
    if (Test-Path -LiteralPath $targetEnv -PathType Leaf) {
        Write-Host "目标配置已存在，跳过密钥导入（不会覆盖）：$targetEnv"
    } elseif ([string]::IsNullOrWhiteSpace($legacyKey)) {
        if (Test-Path -LiteralPath $sourceData -PathType Container) {
            throw "未在旧配置中找到 DATA_ENCRYPTION_KEY（查找：$LegacyEnvFile）。缺少密钥时，旧数据里已加密的上游 Key 将无法解密；请用 -LegacyEnvFile 指定旧 .env，或手工把 DATA_ENCRYPTION_KEY 写入 $targetEnv 后重试。"
        }
        Write-Host '未发现旧配置或 DATA_ENCRYPTION_KEY，无需导入（按全新安装处理）。'
    } else {
        New-Item -ItemType Directory -Force -Path $TargetAppDataDir | Out-Null
        $text = 'DATA_ENCRYPTION_KEY=' + $legacyKey + "`r`n"
        # 必须无 BOM：桌面端 Rust 按行 strip_prefix 解析第一行
        $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
        [System.IO.File]::WriteAllText($targetEnv, $text, $encoding)
        Write-Host "已导入 DATA_ENCRYPTION_KEY 到：$targetEnv"
    }

    Write-Section '完成'
    Write-Host "桌面数据目录：$targetData"
    Write-Host "源数据保留在：$LegacyProgramDataDir（确认无误后可手工删除）"
    Write-Host '接下来启动桌面 App，用旧账号登录并确认供应商/模型/Agent 配置都在。'
} catch {
    Write-Host ''
    Write-Host "迁移失败：$($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}

if ($exitCode -ne 0) {
    exit $exitCode
}
