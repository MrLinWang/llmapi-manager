<#
.SYNOPSIS
[legacy] 把 llmapi-manager 安装为 Windows 服务（WinSW 2.12 wrapper），并完成首次初始化。

.DESCRIPTION
**本脚本已退役，仅保留给旧版机器做修复/回滚，不再随桌面版发布。**
桌面版（Tauri 2）不再安装 Windows 服务；从旧服务升级请改用
`scripts/windows/migrate-from-service.ps1`。本脚本依赖旧版 `build-package.ps1`
产出的发行包布局（该脚本已从仓库删除），不要用于新安装。

适用于两种场景：

  1. Inno Setup 安装包：文件已经解压到 {app}，安装器调用
     `install-service.ps1 -SourceDir {app} -InstallDir {app} -SkipCopy ...`
  2. 便携包手动安装为服务：直接运行
     `powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1`
     脚本会把便携包复制到 `C:\Program Files\llmapi-manager`。

行为要点：
  * 生成/保留 `<安装目录>\.env`：HOST=0.0.0.0、PORT、PUBLIC_BASE_URL、
    DATA_DIR/LOG_DIR（ProgramData）、AGENT_HOME_DIR（安装用户）、随机
    DATA_ENCRYPTION_KEY、可选 SYNC_ALLOW_INSECURE / CODEX_BIN、随机 ADMIN_PASSWORD。
  * 首次启动由 ADMIN_PASSWORD 创建管理员；健康检查通过后把 ADMIN_PASSWORD
    从 .env 删除（口令只通过安装完成页或控制台显示一次）。
  * 升级：保留已有 .env（含 DATA_ENCRYPTION_KEY）、保留 ProgramData 里的数据。
  * 给服务账号授予 `.codex` / `.claude` 与 ProgramData 的修改权限。
  * 失败时回滚文件/服务，并输出日志位置。

注意：本脚本必须在 Windows 上以管理员身份运行；仓库 CI 的 Linux 环境只能做静态检查。
#>
[CmdletBinding()]
param(
    [string]$SourceDir = '',
    [string]$InstallDir = '',
    [string]$ServiceName = 'llmapi-manager',
    [string]$DisplayName = 'LLM API Manager',
    [string]$Description = 'Self-hosted LLM API console and gateway (Node.js + WinSW)',
    [string]$ServiceAccount = 'LocalSystem',
    [string]$ServiceAccountPassword = '',
    [int]$Port = 8787,
    [string]$PublicBaseUrl = '',
    [string]$AgentHomeDir = '',
    [string]$ProgramDataDir = '',
    [string]$AdminUsername = 'admin',
    [string]$AdminPassword = '',
    [string]$CodexBin = '',
    [switch]$SyncAllowInsecure,
    [switch]$EnableFirewall,
    [switch]$SkipCopy,
    [switch]$SkipHealthCheck,
    [int]$HealthTimeoutSeconds = 90,
    [string]$ResultFile = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Format-PathForEnv {
    param([string]$Value)
    return '"' + $Value + '"'
}

function Show-LogTail {
    param([string]$Path, [int]$Lines = 40)
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        Write-Host "---- $Path（最后 $Lines 行）----" -ForegroundColor Yellow
        Get-Content -LiteralPath $Path -Tail $Lines | ForEach-Object { Write-Host $_ }
    }
}

function Write-EnvFileContent {
    param(
        [string]$Path,
        [System.Collections.Specialized.OrderedDictionary]$Values
    )

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# llmapi-manager 服务配置（由 scripts/windows/install-service.ps1 生成）')
    $lines.Add('# 修改后重启服务：Restart-Service ' + $ServiceName)
    $lines.Add('# 数据/日志在 ProgramData 下，升级与卸载默认保留。')
    $lines.Add('')
    $lines.Add('HOST=' + $Values['HOST'])
    $lines.Add('PORT=' + $Values['PORT'])
    $lines.Add('PUBLIC_BASE_URL=' + $Values['PUBLIC_BASE_URL'])
    $lines.Add('DATA_DIR=' + (Format-PathForEnv $Values['DATA_DIR']))
    $lines.Add('LOG_DIR=' + (Format-PathForEnv $Values['LOG_DIR']))
    $lines.Add('AGENT_HOME_DIR=' + (Format-PathForEnv $Values['AGENT_HOME_DIR']))
    $lines.Add('DATA_ENCRYPTION_KEY=' + $Values['DATA_ENCRYPTION_KEY'])
    $lines.Add('ADMIN_USERNAME=' + $Values['ADMIN_USERNAME'])
    if ($Values.Contains('ADMIN_PASSWORD')) {
        $lines.Add('ADMIN_PASSWORD=' + $Values['ADMIN_PASSWORD'])
    }
    if ($Values.Contains('SYNC_ALLOW_INSECURE')) {
        $lines.Add('SYNC_ALLOW_INSECURE=' + $Values['SYNC_ALLOW_INSECURE'])
    }
    if ($Values.Contains('CODEX_BIN')) {
        $lines.Add('CODEX_BIN=' + (Format-PathForEnv $Values['CODEX_BIN']))
    }
    if ($Values.Contains('LOG_LEVEL')) {
        $lines.Add('LOG_LEVEL=' + $Values['LOG_LEVEL'])
    }

    $managed = @(
        'HOST', 'PORT', 'PUBLIC_BASE_URL', 'DATA_DIR', 'LOG_DIR', 'AGENT_HOME_DIR',
        'DATA_ENCRYPTION_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD',
        'SYNC_ALLOW_INSECURE', 'CODEX_BIN', 'LOG_LEVEL'
    )
    $extra = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Values.Keys) {
        if ($managed -notcontains $key) {
            $extra.Add(([string]$key) + '=' + ([string]$Values[$key]))
        }
    }
    if ($extra.Count -gt 0) {
        $lines.Add('')
        $lines.Add('# 其它自定义配置（升级时保留）')
        foreach ($line in $extra) {
            $lines.Add($line)
        }
    }

    Write-TextFileUtf8 -Path $Path -Text (($lines -join "`r`n") + "`r`n")
}

function Enable-ServiceFirewallRule {
    param([int]$ListenPort, [string]$NodeExe)

    $ruleName = "LLM API Manager (TCP $ListenPort)"
    $command = Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Write-Warning '当前系统没有 New-NetFirewallRule（需要 Windows 8 / Server 2012 及以上），跳过防火墙配置。'
        return $false
    }

    try {
        Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue | Out-Null
        New-NetFirewallRule `
            -DisplayName $ruleName `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $ListenPort `
            -Profile Private `
            -Program $NodeExe `
            -Description 'llmapi-manager Windows 服务（仅专用网络）' | Out-Null
        Write-Host "已添加防火墙规则：$ruleName（Private profile，仅 TCP $ListenPort）"
        return $true
    } catch {
        Write-Warning "添加防火墙规则失败（服务仍会安装，但其它设备可能无法访问）：$($_.Exception.Message)"
        return $false
    }
}

function Wait-ForHealth {
    param([string]$Url, [int]$TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = '尚未收到响应'
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 5 -UseBasicParsing
            if ($null -ne $response -and $response.ok -eq $true) {
                return $response
            }
            $lastError = "health 返回 ok=$($response.ok)"
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Seconds 2
    }
    throw "健康检查超时（$Url）：$lastError"
}

function Assert-Payload {
    param([string]$Root, [string]$Label)

    $required = @(
        'node.exe',
        'server\package.json',
        'server\dist\index.js',
        'web\dist\index.html',
        'llmapi-manager-service.exe'
    )
    foreach ($relative in $required) {
        $path = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $path)) {
            throw "发行包缺少文件（$Label）：$path"
        }
    }
    $serverModules = Join-Path $Root 'server\node_modules'
    if (-not (Test-Path -LiteralPath $serverModules -PathType Container)) {
        throw "发行包缺少服务端依赖目录：$serverModules（请使用旧版 build-package.ps1 产出的发行包；该脚本已从仓库删除）"
    }
}

# ---------------------------------------------------------------------------
# 0. 参数与路径
# ---------------------------------------------------------------------------
Assert-Administrator

$scriptDir = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
    $SourceDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
} else {
    $SourceDir = [System.IO.Path]::GetFullPath($SourceDir)
}
$SourceDir = $SourceDir.TrimEnd('\')

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:ProgramFiles 'llmapi-manager'
} else {
    $InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
}
$InstallDir = $InstallDir.TrimEnd('\')

$ProgramDataDir = Resolve-ProgramDataDir -Override $ProgramDataDir

if ($InstallDir -match '^[A-Za-z]:$') {
    throw "安装目录不能是盘符根目录：$InstallDir"
}
if ($InstallDir -ieq $ProgramDataDir) {
    throw "安装目录不能与数据目录相同：$InstallDir"
}
if (-not [string]::IsNullOrWhiteSpace($env:SystemRoot) -and $InstallDir -ieq $env:SystemRoot.TrimEnd('\')) {
    throw "安装目录不能是 Windows 目录：$InstallDir"
}

if ([string]::IsNullOrWhiteSpace($AgentHomeDir)) {
    $AgentHomeDir = $env:USERPROFILE
}
$AgentHomeDir = [System.IO.Path]::GetFullPath($AgentHomeDir).TrimEnd('\')
if (-not (Test-Path -LiteralPath $AgentHomeDir -PathType Container)) {
    throw "AGENT_HOME_DIR 不存在：$AgentHomeDir（可用 -AgentHomeDir 指定当前用户家目录）"
}

if ([string]::IsNullOrWhiteSpace($PublicBaseUrl)) {
    $PublicBaseUrl = "http://127.0.0.1:$Port"
}
$PublicBaseUrl = $PublicBaseUrl.TrimEnd('/')
if ($PublicBaseUrl -notmatch '^https?://') {
    throw "PUBLIC_BASE_URL 必须以 http:// 或 https:// 开头：$PublicBaseUrl"
}

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "端口不合法：$Port"
}
if ($ServiceName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$') {
    throw "服务名只能包含字母、数字、下划线和短横线：$ServiceName"
}

$accountInfo = Get-ServiceAccountIdentity -Account $ServiceAccount
if ($accountInfo.Kind -eq 'Custom' -and [string]::IsNullOrEmpty($ServiceAccountPassword)) {
    throw '使用自定义服务账号时必须同时提供 -ServiceAccountPassword（该账号会被授予“作为服务登录”权限）。'
}

if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
    $ResultFile = [System.IO.Path]::GetFullPath($ResultFile)
}

$DataDir = Join-Path $ProgramDataDir 'data'
$LogDir = Join-Path $ProgramDataDir 'log'
$EnvFile = Join-Path $InstallDir '.env'
$EnvPreservedFile = Join-Path $ProgramDataDir '.env'
$ServiceExe = Join-Path $InstallDir 'llmapi-manager-service.exe'
$ServiceXml = Join-Path $InstallDir 'llmapi-manager-service.xml'
# WinSW 的日志名取自可执行文件基名（llmapi-manager-service.out.log），不是服务 id。
$ServiceLogBase = [System.IO.Path]::GetFileNameWithoutExtension($ServiceExe)
$WinswTemplate = Join-Path $scriptDir 'winsw.xml.template'
$ConsoleUrlFile = Join-Path $InstallDir 'console.url'
$RollbackStamp = Get-Date -Format 'yyyyMMddHHmmss'
$RollbackDir = Join-Path $InstallDir ('.rollback-' + $RollbackStamp)
$EnvBackup = $null
$SnapshotItems = @('node.exe', 'server', 'web', 'llmapi-manager-service.exe', 'start-portable.cmd', 'LICENSE', '.env.example', 'VERSION')
$SnapshotMoved = @()
$InstallDirExisted = Test-Path -LiteralPath $InstallDir -PathType Container
$ShouldCopy = -not ($SkipCopy.IsPresent -or ($SourceDir -ieq $InstallDir))
$ServiceExisted = $false
$ServiceWasRunning = $false
$ServiceUninstalled = $false
$FirewallRuleAdded = $false
$AdminPasswordRemoved = $false
$OwnerName = $AdminUsername

try {
    Write-Section '检查安装包内容'
    if ($ShouldCopy) {
        Assert-Payload -Root $SourceDir -Label '源目录'
    } else {
        Assert-Payload -Root $InstallDir -Label '安装目录'
    }
    if (-not (Test-Path -LiteralPath $WinswTemplate -PathType Leaf)) {
        throw "缺少 WinSW 配置模板：$WinswTemplate"
    }

    # -----------------------------------------------------------------------
    # 1. 停止已有服务（升级时 node.exe 正被占用，必须先把进程停掉）
    # -----------------------------------------------------------------------
    Write-Section '停止已有服务'
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $existingService) {
        $ServiceExisted = $true
        $ServiceWasRunning = ($existingService.Status -ne 'Stopped')
        if ($ServiceWasRunning) {
            Write-Host "正在停止服务 $ServiceName（当前状态：$($existingService.Status)）..."
            & sc.exe stop $ServiceName | Out-Null
            for ($i = 0; $i -lt 30; $i++) {
                Start-Sleep -Seconds 1
                $existingService.Refresh()
                if ($existingService.Status -eq 'Stopped') {
                    break
                }
            }
            if ($existingService.Status -ne 'Stopped') {
                throw "无法停止服务 $ServiceName（当前状态：$($existingService.Status)）。请先手动停止后重试。"
            }
        }
        Write-Host "服务已停止：$ServiceName"
    } else {
        Write-Host "未发现已安装的服务 $ServiceName（首次安装）。"
    }

    # -----------------------------------------------------------------------
    # 2. 复制文件（先把旧文件挪到 .rollback-*，失败时能换回来）
    # -----------------------------------------------------------------------
    if ($ShouldCopy) {
        Write-Section '复制文件'
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

        foreach ($item in $SnapshotItems) {
            $existing = Join-Path $InstallDir $item
            if (Test-Path -LiteralPath $existing) {
                New-Item -ItemType Directory -Force -Path $RollbackDir | Out-Null
                Move-Item -LiteralPath $existing -Destination $RollbackDir -Force
                $SnapshotMoved += $item
            }
        }

        Copy-Item -LiteralPath (Join-Path $SourceDir 'node.exe') -Destination $InstallDir -Force
        Copy-DirectoryMirror -Source (Join-Path $SourceDir 'server') -Destination (Join-Path $InstallDir 'server')
        Copy-DirectoryMirror -Source (Join-Path $SourceDir 'web') -Destination (Join-Path $InstallDir 'web')
        Copy-DirectoryMirror -Source (Join-Path $SourceDir 'scripts') -Destination (Join-Path $InstallDir 'scripts')
        if (Test-Path -LiteralPath (Join-Path $SourceDir 'docs')) {
            Copy-DirectoryMirror -Source (Join-Path $SourceDir 'docs') -Destination (Join-Path $InstallDir 'docs')
        }
        Copy-Item -LiteralPath (Join-Path $SourceDir 'llmapi-manager-service.exe') -Destination $InstallDir -Force

        foreach ($optional in @('start-portable.cmd', 'LICENSE', '.env.example', 'VERSION')) {
            $from = Join-Path $SourceDir $optional
            if (Test-Path -LiteralPath $from) {
                Copy-Item -LiteralPath $from -Destination $InstallDir -Force
            }
        }

        Write-Host "已复制到：$InstallDir"
    } else {
        Write-Host "文件已就位，跳过复制（-SkipCopy 或源目录即安装目录）。"
    }

    # -----------------------------------------------------------------------
    # 3. 准备数据/日志目录与 .env
    # -----------------------------------------------------------------------
    Write-Section '准备数据目录与 .env'
    if ($accountInfo.Kind -ne 'LocalSystem') {
        # 非 LocalSystem 账号需要读取/执行安装目录（Program Files 默认给 Users 读，
        # 但企业策略可能收紧；显式授权更稳）。
        Invoke-Icacls -Path $InstallDir -Arguments @('/grant', ($accountInfo.Acl + ':(OI)(CI)RX'))
    }
    New-Item -ItemType Directory -Force -Path $ProgramDataDir | Out-Null
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    Invoke-Icacls -Path $ProgramDataDir -Arguments @('/grant', ($accountInfo.Acl + ':(OI)(CI)M'))
    Write-Host "服务数据目录：$DataDir"
    Write-Host "服务日志目录：$LogDir"

    # 卸载时会把 .env 保留在 ProgramData，重装时优先复用，否则 DATA_ENCRYPTION_KEY 丢失会导致旧数据无法解密
    if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf) -and (Test-Path -LiteralPath $EnvPreservedFile -PathType Leaf)) {
        Copy-Item -LiteralPath $EnvPreservedFile -Destination $EnvFile -Force
        Write-Host "已复用上次卸载保留的配置：$EnvPreservedFile"
    }

    if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
        $EnvBackup = $EnvFile + '.bak-' + $RollbackStamp
        Copy-Item -LiteralPath $EnvFile -Destination $EnvBackup -Force
        Write-Host "已备份现有 .env：$EnvBackup"
    }

    $envValues = Read-EnvMap -Path $EnvFile

    $identityFile = Join-Path $DataDir 'identity.json'
    $existingUsers = @(Get-IdentityUsers -IdentityFile $identityFile)
    $initialized = $existingUsers.Count -gt 0

    $envValues['HOST'] = '0.0.0.0'
    $envValues['PORT'] = [string]$Port
    $envValues['PUBLIC_BASE_URL'] = $PublicBaseUrl
    $envValues['DATA_DIR'] = $DataDir
    $envValues['LOG_DIR'] = $LogDir
    $envValues['AGENT_HOME_DIR'] = $AgentHomeDir

    if (-not $envValues.Contains('DATA_ENCRYPTION_KEY') -or [string]::IsNullOrWhiteSpace([string]$envValues['DATA_ENCRYPTION_KEY'])) {
        $envValues['DATA_ENCRYPTION_KEY'] = New-RandomHex -ByteCount 32
        Write-Host '已生成新的 DATA_ENCRYPTION_KEY（保存在 .env，请勿删除；丢失后已加密的 API Key 无法解密）。'
    } else {
        Write-Host '沿用已有 DATA_ENCRYPTION_KEY。'
    }

    if (-not $envValues.Contains('LOG_LEVEL')) {
        $envValues['LOG_LEVEL'] = 'info'
    }

    $existingAdminPassword = ''
    if ($envValues.Contains('ADMIN_PASSWORD')) {
        $existingAdminPassword = [string]$envValues['ADMIN_PASSWORD']
    }

    if ($initialized) {
        # 已有账号：ADMIN_PASSWORD 不会覆盖已有口令。**先不删**（健康检查通过后统一删除），
        # 这样首次安装若在健康检查阶段失败，重试时仍能从 .env 找回口令。
        $AdminPassword = ''
        Write-Host "检测到已有账号数据，保留现有管理员，不生成新的初始口令。"
    } else {
        if (-not [string]::IsNullOrWhiteSpace($AdminPassword)) {
            Write-Host '使用 -AdminPassword 指定的初始口令。'
        } elseif (-not [string]::IsNullOrWhiteSpace($existingAdminPassword)) {
            $AdminPassword = $existingAdminPassword
            Write-Host '沿用 .env 中已有的 ADMIN_PASSWORD。'
        } else {
            $AdminPassword = New-RandomHex -ByteCount 18
            Write-Host '已生成随机初始管理员口令（安装完成后从 .env 删除）。'
        }
        $envValues['ADMIN_USERNAME'] = $AdminUsername
        $envValues['ADMIN_PASSWORD'] = $AdminPassword
    }
    if (-not $envValues.Contains('ADMIN_USERNAME') -or [string]::IsNullOrWhiteSpace([string]$envValues['ADMIN_USERNAME'])) {
        $envValues['ADMIN_USERNAME'] = $AdminUsername
    }

    if ($SyncAllowInsecure.IsPresent) {
        $envValues['SYNC_ALLOW_INSECURE'] = '1'
        Write-Host '已开启 SYNC_ALLOW_INSECURE（同步快照允许明文 HTTP，仅在可信内网使用）。'
    }

    if (-not [string]::IsNullOrWhiteSpace($CodexBin)) {
        $envValues['CODEX_BIN'] = $CodexBin
    } elseif (-not $envValues.Contains('CODEX_BIN') -or [string]::IsNullOrWhiteSpace([string]$envValues['CODEX_BIN'])) {
        $where = @()
        try {
            $where = @(& where.exe codex 2>$null)
        } catch {
            $where = @()
        }
        $candidate = $where |
            Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) -and ($_ -match '\.(exe|cmd|bat)$') } |
            Select-Object -First 1
        if ($candidate) {
            $envValues['CODEX_BIN'] = $candidate
            Write-Host "已自动检测到 CODEX_BIN：$candidate"
        } else {
            Write-Host '未检测到 codex 命令；如果服务需要结束 Codex 进程，可在 .env 中手动设置 CODEX_BIN 后重启服务。'
        }
    }
    if ($envValues.Contains('CODEX_BIN') -and -not [string]::IsNullOrWhiteSpace([string]$envValues['CODEX_BIN'])) {
        $codexPath = [string]$envValues['CODEX_BIN']
        if (-not (Test-Path -LiteralPath $codexPath -PathType Leaf)) {
            Write-Warning "CODEX_BIN 指向的文件不存在：$codexPath（保留该配置，稍后可修正）"
        }
    }

    Write-EnvFileContent -Path $EnvFile -Values $envValues
    Set-RestrictedFileAcl -Path $EnvFile -ServiceAccountAcl $accountInfo.Acl
    Write-Host "已写入 .env：$EnvFile"

    # AGENT_HOME_DIR 下的 .codex / .claude 需要服务账号可写，否则给 Agent 下发配置会失败
    foreach ($agentDirName in @('.codex', '.claude')) {
        $agentDir = Join-Path $AgentHomeDir $agentDirName
        New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
        Grant-DirectoryModify -Path $agentDir -AclEntry $accountInfo.Acl
    }
    Write-Host "已给服务账号 $($accountInfo.Display) 授予 $AgentHomeDir\.codex 与 .claude 的修改权限。"

    # -----------------------------------------------------------------------
    # 4. 生成 WinSW 配置
    # -----------------------------------------------------------------------
    Write-Section '生成 WinSW 服务配置'

    $serviceAccountBlock = ''
    if ($accountInfo.Kind -ne 'LocalSystem') {
        $escape = {
            param([string]$Value)
            return [System.Security.SecurityElement]::Escape($Value)
        }
        $domainXml = & $escape $accountInfo.Domain
        $userXml = & $escape $accountInfo.User
        $passwordXml = & $escape $ServiceAccountPassword
        $allowLogon = 'false'
        if ($accountInfo.Kind -eq 'Custom') {
            $allowLogon = 'true'
        }
        $serviceAccountBlock = @"
  <serviceaccount>
    <domain>$domainXml</domain>
    <user>$userXml</user>
    <password>$passwordXml</password>
    <allowservicelogon>$allowLogon</allowservicelogon>
  </serviceaccount>
"@
    }

    $template = [System.IO.File]::ReadAllText($WinswTemplate)
    $xml = $template
    $xml = $xml.Replace('__SERVICE_ID__', [System.Security.SecurityElement]::Escape($ServiceName))
    $xml = $xml.Replace('__DISPLAY_NAME__', [System.Security.SecurityElement]::Escape($DisplayName))
    $xml = $xml.Replace('__DESCRIPTION__', [System.Security.SecurityElement]::Escape($Description))
    $xml = $xml.Replace('__LOG_DIR__', [System.Security.SecurityElement]::Escape($LogDir))
    $xml = $xml.Replace('__SERVICE_ACCOUNT_BLOCK__', $serviceAccountBlock)
    Write-TextFileUtf8 -Path $ServiceXml -Text $xml
    Write-Host "已生成：$ServiceXml"

    # -----------------------------------------------------------------------
    # 5. 重新安装并启动服务
    # -----------------------------------------------------------------------
    Write-Section '安装并启动 Windows 服务'

    if ($ServiceExisted) {
        $ServiceUninstalled = $true
        & $ServiceExe uninstall | Out-Null
        $uninstallCode = $LASTEXITCODE
        if ($uninstallCode -ne 0) {
            throw "卸载旧服务失败（WinSW 退出码 $uninstallCode）。请用 sc.exe query $ServiceName 检查服务状态。"
        }
        Start-Sleep -Seconds 1
    }

    & $ServiceExe install | Out-Null
    $installCode = $LASTEXITCODE
    if ($installCode -ne 0) {
        throw "安装 Windows 服务失败（WinSW 退出码 $installCode）。可查看事件查看器 -> Windows 日志 -> 系统，或 %ProgramData%\llmapi-manager\log 下的 WinSW 日志。"
    }

    Start-Service -Name $ServiceName
    $started = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $svc -and $svc.Status -eq 'Running') {
            $started = $true
            break
        }
    }
    if (-not $started) {
        throw "服务 $ServiceName 未能在 30 秒内进入 Running 状态。请查看 $LogDir 下的 WinSW 日志（*.out.log / *.err.log）。"
    }
    Write-Host "服务已启动：$ServiceName"

    # -----------------------------------------------------------------------
    # 6. 健康检查（确认服务真的能提供服务，而不只是进程活着）
    # -----------------------------------------------------------------------
    $healthUrl = "http://127.0.0.1:$Port/api/health"
    if (-not $SkipHealthCheck.IsPresent) {
        Write-Section '健康检查'
        $health = Wait-ForHealth -Url $healthUrl -TimeoutSeconds $HealthTimeoutSeconds
        Write-Host "健康检查通过：$healthUrl（gateway: $($health.gatewayBaseUrl)）"
        if ($health.warnings -and $health.warnings.Count -gt 0) {
            Write-Host '启动告警：'
            foreach ($warning in $health.warnings) {
                Write-Host ("  - " + $warning)
            }
        }
    } else {
        Write-Host '已按 -SkipHealthCheck 跳过健康检查。'
    }

    # -----------------------------------------------------------------------
    # 7. 健康检查通过后删除 ADMIN_PASSWORD（口令只显示一次）。
    #    -SkipHealthCheck 是排障开关：此时不删，保留口令便于人工排查。
    # -----------------------------------------------------------------------
    if ($envValues.Contains('ADMIN_PASSWORD') -and -not $SkipHealthCheck.IsPresent) {
        $envValues.Remove('ADMIN_PASSWORD')
        Write-EnvFileContent -Path $EnvFile -Values $envValues
        Set-RestrictedFileAcl -Path $EnvFile -ServiceAccountAcl $accountInfo.Acl
        $AdminPasswordRemoved = $true
        Write-Host '已从 .env 删除 ADMIN_PASSWORD。'
    } elseif ($envValues.Contains('ADMIN_PASSWORD')) {
        Write-Host '已按 -SkipHealthCheck 跳过健康检查，暂不删除 .env 中的 ADMIN_PASSWORD。'
    }

    # 从数据文件读取真实管理员用户名（升级/手工改过用户名时比参数可靠）
    $usersAfterStart = @(Get-IdentityUsers -IdentityFile $identityFile)
    if ($usersAfterStart.Count -gt 0) {
        $owner = $usersAfterStart | Where-Object { $_.role -eq 'owner' } | Select-Object -First 1
        if ($null -ne $owner -and -not [string]::IsNullOrWhiteSpace([string]$owner.username)) {
            $OwnerName = [string]$owner.username
        }
    }

    # -----------------------------------------------------------------------
    # 8. 可选：防火墙 + 控制台快捷方式
    # -----------------------------------------------------------------------
    if ($EnableFirewall.IsPresent) {
        Write-Section '配置防火墙'
        $FirewallRuleAdded = Enable-ServiceFirewallRule -ListenPort $Port -NodeExe (Join-Path $InstallDir 'node.exe')
    } else {
        Write-Host '未请求配置防火墙（需要时加 -EnableFirewall，或在安装向导里勾选）。'
    }

    $consoleUrl = "[InternetShortcut]`r`nURL=$PublicBaseUrl`r`n"
    Write-TextFileUtf8 -Path $ConsoleUrlFile -Text $consoleUrl
    Write-Host "已写入控制台快捷方式：$ConsoleUrlFile"

    # -----------------------------------------------------------------------
    # 9. 结果输出
    # -----------------------------------------------------------------------
    $appLog = Join-Path $LogDir 'app.log'
    $serviceOutLog = Join-Path $LogDir ($ServiceLogBase + '.out.log')
    $serviceErrLog = Join-Path $LogDir ($ServiceLogBase + '.err.log')

    Write-Section '安装完成'
    Write-Host "服务名称：$ServiceName（自动启动，失败自动重启）"
    Write-Host "服务账号：$($accountInfo.Display)"
    Write-Host "安装目录：$InstallDir"
    Write-Host "数据目录：$DataDir"
    Write-Host "日志目录：$LogDir"
    Write-Host "控制台地址：$PublicBaseUrl"
    Write-Host "管理员账号：$OwnerName"
    if (-not [string]::IsNullOrWhiteSpace($AdminPassword)) {
        Write-Host ''
        Write-Host "初始管理员口令：$AdminPassword" -ForegroundColor Yellow
        Write-Host '该口令只显示这一次；登录后请在「设置」中修改。'
        Write-Host ''
    }
    if ($AdminPasswordRemoved) {
        Write-Host 'ADMIN_PASSWORD 已从 .env 删除；重启服务不会重新创建/覆盖账号。'
    }
    Write-Host "运行日志：$appLog"
    Write-Host "服务标准输出/错误：$serviceOutLog / $serviceErrLog"

    if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
        $resultValues = New-Object System.Collections.Specialized.OrderedDictionary
        $resultValues['success'] = '1'
        $resultValues['serviceName'] = $ServiceName
        $resultValues['username'] = $OwnerName
        $resultValues['password'] = $AdminPassword
        $resultValues['url'] = $PublicBaseUrl
        $resultValues['installDir'] = $InstallDir
        $resultValues['dataDir'] = $DataDir
        $resultValues['logDir'] = $LogDir
        $resultValues['appLog'] = $appLog
        $resultValues['serviceOutLog'] = $serviceOutLog
        $resultValues['serviceErrLog'] = $serviceErrLog
        $resultValues['completedAt'] = (Get-Date).ToString('s')
        $resultValues['error'] = ''
        Write-InstallResultFile -Path $ResultFile -Values $resultValues
        try {
            Set-RestrictedFileAcl -Path $ResultFile -ServiceAccountAcl $accountInfo.Acl
        } catch {
            Write-Warning "无法收紧安装结果文件 ACL：$($_.Exception.Message)"
        }
    }

    if (Test-Path -LiteralPath $RollbackDir) {
        Remove-Item -LiteralPath $RollbackDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not [string]::IsNullOrWhiteSpace($EnvBackup) -and (Test-Path -LiteralPath $EnvBackup)) {
        Remove-Item -LiteralPath $EnvBackup -Force -ErrorAction SilentlyContinue
    }
} catch {
    $failure = $_
    Write-Host ''
    Write-Host "安装失败：$($failure.Exception.Message)" -ForegroundColor Red

    # 尽力回滚：停服务 -> 换回旧文件 -> 恢复 .env -> 重新安装旧服务
    try {
        if ($ServiceUninstalled -and (Test-Path -LiteralPath $ServiceExe)) {
            & $ServiceExe stop 2>$null | Out-Null
            & $ServiceExe uninstall 2>$null | Out-Null
        }
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $svc) {
            if ($svc.Status -ne 'Stopped') {
                & sc.exe stop $ServiceName | Out-Null
                for ($i = 0; $i -lt 30; $i++) {
                    Start-Sleep -Seconds 1
                    $svc.Refresh()
                    if ($svc.Status -eq 'Stopped') {
                        break
                    }
                }
            }
            & sc.exe delete $ServiceName | Out-Null
            for ($i = 0; $i -lt 10; $i++) {
                Start-Sleep -Seconds 1
                if ($null -eq (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
                    break
                }
            }
        }

        if (Test-Path -LiteralPath $RollbackDir) {
            foreach ($item in @('server', 'web', 'node.exe', 'llmapi-manager-service.exe', 'start-portable.cmd', 'LICENSE', '.env.example', 'VERSION')) {
                $candidate = Join-Path $InstallDir $item
                if (Test-Path -LiteralPath $candidate) {
                    Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
            foreach ($item in $SnapshotMoved) {
                $from = Join-Path $RollbackDir $item
                if (Test-Path -LiteralPath $from) {
                    Move-Item -LiteralPath $from -Destination $InstallDir -Force
                }
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($EnvBackup) -and (Test-Path -LiteralPath $EnvBackup)) {
            Copy-Item -LiteralPath $EnvBackup -Destination $EnvFile -Force
            Write-Host '已恢复安装前的 .env。'
        }
        if (-not $InstallDirExisted -and (Test-Path -LiteralPath $InstallDir)) {
            # 首次安装失败：数据目录（可能已由服务创建 admin 账号）要保留，
            # 但安装目录里的 .env 含 DATA_ENCRYPTION_KEY / ADMIN_PASSWORD，必须先存到
            # ProgramData 的保留位置，再删半截安装目录。重装时会自动复用这份 .env。
            if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
                New-Item -ItemType Directory -Force -Path $ProgramDataDir | Out-Null
                Copy-Item -LiteralPath $EnvFile -Destination $EnvPreservedFile -Force
                Write-Host "已保留 .env 到：$EnvPreservedFile"
            }
            Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        }

        if ($ServiceExisted -and (Test-Path -LiteralPath $ServiceExe)) {
            & $ServiceExe install 2>$null | Out-Null
            if ($ServiceWasRunning) {
                Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
            }
            Write-Host '已尝试恢复安装前的服务。'
        }
        if ($FirewallRuleAdded) {
            $ruleName = "LLM API Manager (TCP $Port)"
            Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
                Remove-NetFirewallRule -ErrorAction SilentlyContinue | Out-Null
        }
    } catch {
        Write-Warning "回滚过程中又出错（请手工检查）：$($_.Exception.Message)"
    }

    $appLog = Join-Path $LogDir 'app.log'
    $serviceOutLog = Join-Path $LogDir ($ServiceLogBase + '.out.log')
    $serviceErrLog = Join-Path $LogDir ($ServiceLogBase + '.err.log')
    Write-Host ''
    Write-Host '排查日志：' -ForegroundColor Yellow
    Write-Host "  $appLog"
    Write-Host "  $serviceOutLog"
    Write-Host "  $serviceErrLog"
    Write-Host "  安装结果：$ResultFile"
    if (-not [string]::IsNullOrWhiteSpace($AdminPassword)) {
        Write-Host '  ADMIN_PASSWORD 仍在 .env 与 ProgramData 保留副本中（健康检查未通过，未删除）' -ForegroundColor Yellow
    }
    Show-LogTail -Path $serviceErrLog -Lines 40
    Show-LogTail -Path $serviceOutLog -Lines 40
    Show-LogTail -Path $appLog -Lines 40

    if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
        try {
            $resultValues = New-Object System.Collections.Specialized.OrderedDictionary
            $resultValues['success'] = '0'
            $resultValues['serviceName'] = $ServiceName
            $resultValues['username'] = ''
            $resultValues['password'] = ''
            $resultValues['url'] = $PublicBaseUrl
            $resultValues['installDir'] = $InstallDir
            $resultValues['dataDir'] = $DataDir
            $resultValues['logDir'] = $LogDir
            $resultValues['appLog'] = $appLog
            $resultValues['serviceOutLog'] = $serviceOutLog
            $resultValues['serviceErrLog'] = $serviceErrLog
            $resultValues['completedAt'] = (Get-Date).ToString('s')
            $resultValues['error'] = $failure.Exception.Message
            Write-InstallResultFile -Path $ResultFile -Values $resultValues
        } catch {
            Write-Warning "无法写入安装结果文件：$($_.Exception.Message)"
        }
    }

    exit 1
}
