<#
.SYNOPSIS
构建 llmapi-manager 的 Windows x64 发行包（便携 zip + 可选 Inno Setup 安装包）。

.DESCRIPTION
步骤：
  1. 在仓库根执行 npm ci（可 -SkipNpmCi）与 npm run build；
  2. 下载并校验 Node 22 LTS x64 zip 与 WinSW 2.12（也可用本地缓存/自定义路径）；
  3. 组装 stage：node.exe、server/dist、server/package.json、server 生产依赖、
     web/dist、WinSW 可执行文件、scripts/windows、docs/windows.md、LICENSE 等；
  4. 生成 `dist/windows/llmapi-manager-<version>-win-x64.zip`；
  5. 若找到 Inno Setup 6 的 ISCC.exe，生成
     `dist/windows/llmapi-manager-setup-<version>-x64.exe`。

固定的上游版本与 SHA256 见脚本顶部常量；Node 校验以 nodejs.org 的 SHASUMS256.txt
为权威，WinSW 因为上游不发布校验文件，使用本仓库固定值（追加/升级版本时需人工核对）。
本脚本只支持 Windows（需要 node.exe / robocopy / PowerShell 5.1+）。
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$OutputDir = '',
    [string]$NodeVersion = '22.23.4',
    [string]$NodeZipPath = '',
    [string]$NodeSha256 = '',
    [string]$WinSwExePath = '',
    [switch]$SkipNpmCi,
    [switch]$SkipBuild,
    [switch]$NoInstaller,
    [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

# 固定上游版本（升级时同时更新 URL/版本/哈希，并在 docs/windows.md 记录来源与日期）
$NodeDefaultVersion = '22.23.4'
$NodeDefaultSha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
$WinSwVersion = '2.12.0'
$WinSwSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256 {
    param([string]$Path, [string]$Expected, [string]$What)
    $actual = Get-Sha256 -Path $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "$What SHA256 不匹配。期望：$Expected，实际：$actual（文件：$Path）"
    }
    Write-Host "$What SHA256 校验通过：$actual"
}

function Invoke-Download {
    param([string]$Url, [string]$Destination)
    $parent = Split-Path -Parent $Destination
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    Write-Host "下载：$Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Resolve-Npm {
    $candidate = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $candidate) {
        $candidate = Get-Command npm -ErrorAction SilentlyContinue
    }
    if ($null -eq $candidate) {
        throw '找不到 npm。请先安装 Node.js 22 LTS x64，并在 PATH 中可用。'
    }
    return $candidate.Source
}

# ---------------------------------------------------------------------------
# 0. 基本路径与版本
# ---------------------------------------------------------------------------
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')

if ([string]::IsNullOrWhiteSpace($Version)) {
    $rootPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
    $Version = [string]$rootPackage.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$') {
    throw "版本号格式不合法：$Version（应形如 0.1.0）"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $repoRoot 'dist\windows'
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir).TrimEnd('\')
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$packageId = "llmapi-manager-$Version-win-x64"
$stageRoot = Join-Path $OutputDir 'stage'
$stageDir = Join-Path $stageRoot $packageId
$zipPath = Join-Path $OutputDir ($packageId + '.zip')
$setupPath = Join-Path $OutputDir ("llmapi-manager-setup-$Version-x64.exe")

$cacheRoot = $env:TEMP
if ([string]::IsNullOrWhiteSpace($cacheRoot)) {
    $cacheRoot = Join-Path $OutputDir '_cache'
}
$cacheDir = Join-Path $cacheRoot 'llmapi-manager-build-cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

$npmExe = Resolve-Npm
$npmCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
    throw '找不到 node.exe。请先安装 Node.js 22 LTS x64，并在 PATH 中可用。'
}

Write-Host "仓库：$repoRoot"
Write-Host "版本：$Version"
Write-Host "输出：$OutputDir"
Write-Host "Node 运行时：$NodeVersion（固定 22 LTS x64）"
Write-Host "WinSW：$WinSwVersion"

# ---------------------------------------------------------------------------
# 1. 安装依赖并构建
# ---------------------------------------------------------------------------
Push-Location -LiteralPath $repoRoot
try {
    if (-not $SkipNpmCi.IsPresent) {
        Write-Section 'npm ci'
        & $npmExe ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci 失败（退出码 $LASTEXITCODE）"
        }
    } else {
        Write-Host '已按 -SkipNpmCi 跳过 npm ci。'
    }

    if (-not $SkipBuild.IsPresent) {
        Write-Section 'npm run build'
        & $npmExe run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build 失败（退出码 $LASTEXITCODE）"
        }
    } else {
        Write-Host '已按 -SkipBuild 跳过构建。'
    }
} finally {
    Pop-Location
}

$serverEntry = Join-Path $repoRoot 'server\dist\index.js'
$webIndex = Join-Path $repoRoot 'web\dist\index.html'
if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
    throw "缺少构建产物：$serverEntry"
}
if (-not (Test-Path -LiteralPath $webIndex -PathType Leaf)) {
    throw "缺少构建产物：$webIndex"
}

# ---------------------------------------------------------------------------
# 2. 准备 Node 运行时
# ---------------------------------------------------------------------------
Write-Section '准备 Node 运行时'

$nodeZip = $NodeZipPath
if ([string]::IsNullOrWhiteSpace($nodeZip)) {
    $nodeZip = Join-Path $cacheDir ("node-v$NodeVersion-win-x64.zip")
    if (-not (Test-Path -LiteralPath $nodeZip -PathType Leaf)) {
        Invoke-Download -Url ("https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip") -Destination $nodeZip
    } else {
        Write-Host "使用缓存的 Node 包：$nodeZip"
    }
} else {
    $nodeZip = [System.IO.Path]::GetFullPath($nodeZip)
}
if (-not (Test-Path -LiteralPath $nodeZip -PathType Leaf)) {
    throw "Node zip 不存在：$nodeZip"
}

$expectedNodeSha = $NodeSha256
if ([string]::IsNullOrWhiteSpace($expectedNodeSha) -and $NodeVersion -eq $NodeDefaultVersion) {
    $expectedNodeSha = $NodeDefaultSha256
}
if ([string]::IsNullOrWhiteSpace($expectedNodeSha)) {
    $shaFile = Join-Path $cacheDir ("SHASUMS256-v$NodeVersion.txt")
    if (-not (Test-Path -LiteralPath $shaFile -PathType Leaf)) {
        Invoke-Download -Url ("https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt") -Destination $shaFile
    }
    $zipName = "node-v$NodeVersion-win-x64.zip"
    $match = Get-Content -LiteralPath $shaFile |
        Where-Object { $_ -match ('\s' + [regex]::Escape($zipName) + '\s*$') } |
        Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($match)) {
        throw "在 $shaFile 中找不到 $zipName 的 SHA256 记录"
    }
    $expectedNodeSha = (($match -split '\s+')[0])
}
Assert-Sha256 -Path $nodeZip -Expected $expectedNodeSha -What 'Node 运行时 zip'

$extractRoot = Join-Path $cacheDir ("node-v$NodeVersion-win-x64-extract")
$nodeExePath = Join-Path $extractRoot 'node.exe'
if (-not (Test-Path -LiteralPath $nodeExePath -PathType Leaf)) {
    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Write-Host "解压 Node 运行时到：$extractRoot"
    Expand-Archive -Path $nodeZip -DestinationPath $extractRoot -Force
    $foundNode = Get-ChildItem -LiteralPath $extractRoot -Filter 'node.exe' -Recurse -File | Select-Object -First 1
    if ($null -eq $foundNode) {
        throw "Node zip 中找不到 node.exe：$nodeZip"
    }
    $nodeExePath = $foundNode.FullName
}
$nodeSourceDir = Split-Path -Parent $nodeExePath

# ---------------------------------------------------------------------------
# 3. 准备 WinSW
# ---------------------------------------------------------------------------
Write-Section '准备 WinSW 服务 wrapper'
$winSwSource = $WinSwExePath
if ([string]::IsNullOrWhiteSpace($winSwSource)) {
    $winSwSource = Join-Path $cacheDir ("WinSW-$WinSwVersion-x64.exe")
    if (-not (Test-Path -LiteralPath $winSwSource -PathType Leaf)) {
        Invoke-Download -Url ("https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-x64.exe") -Destination $winSwSource
    } else {
        Write-Host "使用缓存的 WinSW：$winSwSource"
    }
} else {
    $winSwSource = [System.IO.Path]::GetFullPath($winSwSource)
}
if (-not (Test-Path -LiteralPath $winSwSource -PathType Leaf)) {
    throw "WinSW 可执行文件不存在：$winSwSource"
}
Assert-Sha256 -Path $winSwSource -Expected $WinSwSha256 -What "WinSW $WinSwVersion x64"

# ---------------------------------------------------------------------------
# 4. 组装 stage
# ---------------------------------------------------------------------------
Write-Section '组装 stage'
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'server') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'web') | Out-Null

Copy-Item -LiteralPath $nodeExePath -Destination (Join-Path $stageDir 'node.exe') -Force
Copy-Item -LiteralPath $winSwSource -Destination (Join-Path $stageDir 'llmapi-manager-service.exe') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'server\package.json') -Destination (Join-Path $stageDir 'server\package.json') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'server\dist') -Destination (Join-Path $stageDir 'server\dist') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'web\dist') -Destination (Join-Path $stageDir 'web\dist') -Recurse -Force

$licensePath = Join-Path $repoRoot 'LICENSE'
if (Test-Path -LiteralPath $licensePath -PathType Leaf) {
    Copy-Item -LiteralPath $licensePath -Destination (Join-Path $stageDir 'LICENSE') -Force
}
$envExample = Join-Path $repoRoot '.env.example'
if (Test-Path -LiteralPath $envExample -PathType Leaf) {
    Copy-Item -LiteralPath $envExample -Destination (Join-Path $stageDir '.env.example') -Force
}
$nodeLicense = Join-Path $nodeSourceDir 'LICENSE'
if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
    $licenseDir = Join-Path $stageDir 'licenses'
    New-Item -ItemType Directory -Force -Path $licenseDir | Out-Null
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $licenseDir 'node-LICENSE.txt') -Force
}

# 运行时脚本（不含构建脚本与 Inno 脚本）
$runtimeScriptDir = Join-Path $stageDir 'scripts\windows'
New-Item -ItemType Directory -Force -Path $runtimeScriptDir | Out-Null
$notForRuntime = @('build-package.ps1', 'installer.iss', 'portable-launcher.cmd')
Get-ChildItem -LiteralPath (Join-Path $repoRoot 'scripts\windows') -File |
    Where-Object { $notForRuntime -notcontains $_.Name } |
    ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $runtimeScriptDir -Force
    }
Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts\windows\portable-launcher.cmd') -Destination (Join-Path $stageDir 'start-portable.cmd') -Force

$docsDir = Join-Path $stageDir 'docs'
New-Item -ItemType Directory -Force -Path $docsDir | Out-Null
# docs/windows.md 里链接到 sync.md / development.md；只复制 windows.md 会让安装后的
# 文档出现断链。把整份 docs/ 与两份 README 一起带上（体积可忽略）。
$docsSource = Join-Path $repoRoot 'docs'
if (Test-Path -LiteralPath $docsSource -PathType Container) {
    Get-ChildItem -LiteralPath $docsSource -Filter '*.md' -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $docsDir -Force
    }
}
foreach ($readmeName in @('README.md', 'README.zh-CN.md')) {
    $readmePath = Join-Path $repoRoot $readmeName
    if (Test-Path -LiteralPath $readmePath -PathType Leaf) {
        Copy-Item -LiteralPath $readmePath -Destination $stageDir -Force
    }
}

Write-TextFileUtf8 -Path (Join-Path $stageDir 'VERSION') -Text ($Version + "`r`n")
Write-TextFileUtf8 -Path (Join-Path $stageDir 'console.url') -Text ("[InternetShortcut]`r`nURL=http://127.0.0.1:8787`r`n")

# ---------------------------------------------------------------------------
# 5. 只复制 server 的生产依赖（等价于 npm ci --omit=dev -w server 的安装闭包）
# ---------------------------------------------------------------------------
Write-Section '收集服务端生产依赖'
$serverPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'server\package.json') -Raw | ConvertFrom-Json
$serverPackageName = [string]$serverPackage.name

Push-Location -LiteralPath $repoRoot
try {
    $lsOutput = @(& $npmExe ls --omit=dev --parseable --all -w $serverPackageName 2>$null)
    $lsCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($lsCode -ne 0) {
    throw "npm ls 失败（退出码 $lsCode）。请先完成 npm ci。"
}

$serverModuleDir = Join-Path $stageDir 'server\node_modules'
New-Item -ItemType Directory -Force -Path $serverModuleDir | Out-Null
$copied = 0
foreach ($line in $lsOutput) {
    $text = [string]$line
    if ([string]::IsNullOrWhiteSpace($text)) {
        continue
    }
    $full = [System.IO.Path]::GetFullPath($text.Trim())
    if (-not $full.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
    }
    $relative = $full.Substring($repoRoot.Length).TrimStart('\', '/')
    $prefix = 'node_modules\'
    if (-not $relative.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $relative.StartsWith('node_modules/', [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
    }
    $inside = $relative.Substring('node_modules'.Length).TrimStart('\', '/')
    if ($inside -ieq '@llmapi\server' -or $inside -ieq '@llmapi/server') {
        continue
    }
    # 嵌套依赖会随父包目录一起被复制，重复复制只会变慢
    if ($inside -match '[\\/]node_modules[\\/]') {
        continue
    }
    $destination = Join-Path $serverModuleDir $inside
    $destinationParent = Split-Path -Parent $destination
    if (-not [string]::IsNullOrWhiteSpace($destinationParent)) {
        New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null
    }
    Copy-Item -LiteralPath $full -Destination $destination -Recurse -Force
    $copied++
}
if ($copied -eq 0) {
    throw '没有复制到任何服务端依赖，请检查 npm ls 输出。'
}
Write-Host "已复制 $copied 个服务端生产依赖包。"

# 冒烟自检：入口与关键依赖必须存在
foreach ($required in @('server\node_modules\fastify', 'server\node_modules\@fastify\cookie', 'server\node_modules\@fastify\static')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stageDir $required))) {
        throw "stage 缺少依赖：$required"
    }
}

$stageSize = (Get-ChildItem -LiteralPath $stageDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("stage 大小：{0:N1} MB" -f ($stageSize / 1MB))

# ---------------------------------------------------------------------------
# 6. 生成便携 zip
# ---------------------------------------------------------------------------
if (-not $NoZip.IsPresent) {
    Write-Section '生成便携 zip'
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stageDir,
        $zipPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $true
    )
    $zipHash = Get-Sha256 -Path $zipPath
    $hashFile = $zipPath + '.sha256'
    Set-Content -LiteralPath $hashFile -Value ($zipHash + '  ' + [System.IO.Path]::GetFileName($zipPath)) -Encoding Ascii
    Write-Host "便携包：$zipPath"
    Write-Host "SHA256：$zipHash"
} else {
    Write-Host '已按 -NoZip 跳过便携 zip。'
}

# ---------------------------------------------------------------------------
# 7. 可选：Inno Setup 安装包
# ---------------------------------------------------------------------------
if (-not $NoInstaller.IsPresent) {
    Write-Section '生成 Inno Setup 安装包'
    $isccCandidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $isccCandidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $isccCandidates.Add((Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'))
    }
    $isccCommand = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($null -ne $isccCommand) {
        $isccCandidates.Add($isccCommand.Source)
    }

    $iscc = $null
    foreach ($candidate in $isccCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $iscc = $candidate
            break
        }
    }

    if ($null -eq $iscc) {
        Write-Warning '未找到 Inno Setup 6（ISCC.exe），跳过安装包，只生成便携 zip。'
        Write-Warning '安装 Inno Setup 6 后重新运行本脚本即可生成 exe；CI 里由 windows-package job 尝试安装。'
    } else {
        if (Test-Path -LiteralPath $setupPath) {
            Remove-Item -LiteralPath $setupPath -Force
        }

        # 直接把 installer.iss 拼到临时 wrapper 里，避免 ISPP 的 #include 在 Windows
        # 绝对路径（含空格/反斜杠）上解析失败。原脚本里的 #ifndef 默认值仍保留，
        # 但前面的 #define 会先命中。
        $includePath = Join-Path $PSScriptRoot 'installer.iss'
        $installerBody = [System.IO.File]::ReadAllText($includePath)
        if ($installerBody.Length -gt 0 -and $installerBody[0] -eq [char]0xFEFF) {
            $installerBody = $installerBody.Substring(1)
        }
        $generatedIss = Join-Path $OutputDir ('build-installer-' + $Version + '.iss')
        $generatedContent = @(
            '; 由 build-package.ps1 自动生成，请勿提交',
            '#define AppVersion "' + $Version + '"',
            '#define StageDir "' + $stageDir + '"',
            '#define OutputDir "' + $OutputDir + '"',
            $installerBody
        ) -join "`r`n"
        Write-TextFileUtf8 -Path $generatedIss -Text ($generatedContent + "`r`n") -WithBom

        Write-Host "调用 ISCC：$iscc"
        & $iscc $generatedIss
        $isccCode = $LASTEXITCODE
        Remove-Item -LiteralPath $generatedIss -Force -ErrorAction SilentlyContinue
        if ($isccCode -ne 0) {
            throw "ISCC 编译失败（退出码 $isccCode）。请查看上方输出。"
        }
        if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
            throw "ISCC 返回成功但找不到安装包：$setupPath"
        }
        $setupHash = Get-Sha256 -Path $setupPath
        $setupHashFile = $setupPath + '.sha256'
        Set-Content -LiteralPath $setupHashFile -Value ($setupHash + '  ' + [System.IO.Path]::GetFileName($setupPath)) -Encoding Ascii
        Write-Host "安装包：$setupPath"
        Write-Host "SHA256：$setupHash"
    }
} else {
    Write-Host '已按 -NoInstaller 跳过安装包。'
}

Write-Section '完成'
if (-not $NoZip.IsPresent) {
    Write-Host "便携 zip：$zipPath"
}
if (-not $NoInstaller.IsPresent -and (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    Write-Host "安装程序：$setupPath"
}
Write-Host "输出目录：$OutputDir"
