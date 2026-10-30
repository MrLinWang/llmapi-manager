<#
.SYNOPSIS
[legacy] 卸载 llmapi-manager Windows 服务。

.DESCRIPTION
**本脚本已退役，仅用于清理旧版 WinSW 服务**；桌面版请用“设置 → 应用”卸载。
从旧服务迁移数据请用 `scripts/windows/migrate-from-service.ps1`（它会停/删服务，
默认保留数据）。

默认行为（与旧安装包卸载一致）：
  * 停止并删除 Windows 服务；
  * 删除防火墙规则；
  * 把 .env 复制到 `%ProgramData%\llmapi-manager\.env` 后删除安装目录内容；
  * **保留** `%ProgramData%\llmapi-manager\data` 与 `log`（含 DATA_ENCRYPTION_KEY 的 .env），
    以后重装可以继续使用旧数据。

显式加 `-Purge` 才会连数据目录一起删除（不可恢复）。

参数：
  -KeepFiles 只停服务/删防火墙/保留数据，不删安装目录（Inno Setup 卸载时使用，
              程序文件由卸载器自己删除）。
  -Purge      删除 %ProgramData%\llmapi-manager（数据、日志、保留的 .env）。
  -Quiet      只输出错误，不打印进度。

注意：本脚本必须在 Windows 上以管理员身份运行。
#>
[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [string]$ServiceName = 'llmapi-manager',
    [string]$ProgramDataDir = '',
    [switch]$KeepFiles,
    [switch]$Purge,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Write-Info {
    param([string]$Text)
    if (-not $Quiet.IsPresent) {
        Write-Host $Text
    }
}

Assert-Administrator

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:ProgramFiles 'llmapi-manager'
} else {
    $InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
}
$InstallDir = $InstallDir.TrimEnd('\')

$ProgramDataDir = Resolve-ProgramDataDir -Override $ProgramDataDir
$EnvFile = Join-Path $InstallDir '.env'
$EnvPreservedFile = Join-Path $ProgramDataDir '.env'
$ServiceExe = Join-Path $InstallDir 'llmapi-manager-service.exe'
$ResultFile = Join-Path $ProgramDataDir 'install-result.env'

# ---------------------------------------------------------------------------
# 1. 停止并删除服务
# ---------------------------------------------------------------------------
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $service) {
    Write-Info "正在停止服务 $ServiceName ..."
    if ($service.Status -ne 'Stopped') {
        & sc.exe stop $ServiceName | Out-Null
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            $service.Refresh()
            if ($service.Status -eq 'Stopped') {
                break
            }
        }
        if ($service.Status -ne 'Stopped') {
            Write-Warning "服务 $ServiceName 未能在 30 秒内停止（当前：$($service.Status)）。继续尝试删除。"
        }
    }

    $uninstalled = $false
    if (Test-Path -LiteralPath $ServiceExe -PathType Leaf) {
        & $ServiceExe uninstall | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $uninstalled = $true
        }
    }
    if (-not $uninstalled) {
        & sc.exe delete $ServiceName | Out-Null
    }
    $gone = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        if ($null -eq (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
            $gone = $true
            break
        }
    }
    if (-not $gone) {
        throw "无法删除服务 $ServiceName。请用管理员 PowerShell 执行：sc.exe delete $ServiceName"
    }
    Write-Info "服务已删除：$ServiceName"
} else {
    Write-Info "未发现服务 $ServiceName，跳过。"
}

# ---------------------------------------------------------------------------
# 2. 删除防火墙规则
# ---------------------------------------------------------------------------
try {
    $rules = @(Get-NetFirewallRule -DisplayName 'LLM API Manager (TCP *' -ErrorAction SilentlyContinue)
    foreach ($rule in $rules) {
        Remove-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue | Out-Null
        Write-Info "已删除防火墙规则：$($rule.DisplayName)"
    }
} catch {
    Write-Warning "删除防火墙规则时出错（可手动在 Windows Defender 防火墙中删除）：$($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# 3. 处理安装结果文件（可能含初始口令，卸载时一律删除）
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $ResultFile -PathType Leaf) {
    Remove-Item -LiteralPath $ResultFile -Force -ErrorAction SilentlyContinue
    Write-Info "已删除安装结果文件：$ResultFile"
}

# ---------------------------------------------------------------------------
# 4. 保留数据 / 清理安装目录
# ---------------------------------------------------------------------------
if ($Purge.IsPresent) {
    if (Test-Path -LiteralPath $ProgramDataDir -PathType Container) {
        # 显式 -Purge 时连数据、日志和保留的 .env 一起删除
        Remove-Item -LiteralPath $ProgramDataDir -Recurse -Force
        Write-Info "已删除数据目录（-Purge）：$ProgramDataDir"
    }
} else {
    New-Item -ItemType Directory -Force -Path $ProgramDataDir | Out-Null
    if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
        Copy-Item -LiteralPath $EnvFile -Destination $EnvPreservedFile -Force
        try {
            Set-RestrictedFileAcl -Path $EnvPreservedFile -ServiceAccountAcl '*S-1-5-18'
        } catch {
            Write-Warning "无法收紧保留 .env 的 ACL：$($_.Exception.Message)"
        }
        Write-Info "已保留 .env（含 DATA_ENCRYPTION_KEY）：$EnvPreservedFile"
    }
    Write-Info "已保留数据目录：$(Join-Path $ProgramDataDir 'data')"
    Write-Info "已保留日志目录：$(Join-Path $ProgramDataDir 'log')"
    Write-Info '如需彻底删除数据，请重新运行并加 -Purge。'
}

if (-not $KeepFiles.IsPresent) {
    if (Test-Path -LiteralPath $InstallDir -PathType Container) {
        # 只删除“看起来确实是本程序”的安装目录，避免路径写错时误删
        $looksLikeUs =
            (Test-Path -LiteralPath (Join-Path $InstallDir 'node.exe')) -or
            (Test-Path -LiteralPath (Join-Path $InstallDir 'llmapi-manager-service.exe')) -or
            (Test-Path -LiteralPath (Join-Path $InstallDir 'server\dist\index.js'))
        $trimmed = $InstallDir.TrimEnd('\')
        $tooDangerous =
            ($trimmed.Length -le 3) -or
            ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:SystemRoot)).TrimEnd('\')) -or
            ($trimmed -ieq ([System.IO.Path]::GetFullPath($env:ProgramData)).TrimEnd('\'))
        if (-not $looksLikeUs -or $tooDangerous) {
            Write-Warning "安装目录看起来不是 llmapi-manager（$InstallDir），为安全起见不自动删除。请手工确认后删除。"
        } else {
            Write-Info "正在删除安装目录：$InstallDir"
            # 如果用户正好在安装目录里运行脚本，Windows 不允许删除当前工作目录；
            # 先切到系统目录再递归删除。
            Set-Location -LiteralPath $env:SystemRoot
            Remove-Item -LiteralPath $InstallDir -Recurse -Force
        }
    }
} else {
    Write-Info '已按 -KeepFiles 保留安装目录（程序文件由卸载器删除）。'
}

if (-not $Quiet.IsPresent) {
    Write-Host ''
    Write-Host '卸载完成。'
    if (-not $Purge.IsPresent) {
        Write-Host "数据与配置仍保留在：$ProgramDataDir"
    }
}
