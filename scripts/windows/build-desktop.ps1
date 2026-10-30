<#
.SYNOPSIS
构建 llmapi-manager Windows 桌面应用（Tauri 2 + WebView2 + 内置 Node sidecar）。

.DESCRIPTION
构建顺序：

  1. `npm ci`（可 -SkipNpmCi）与 `npm run build`（可 -SkipBuild）：产出
     server/dist 与 web/dist；
  2. 准备 `src-tauri/runtime`（sidecar stage，由 Tauri 作为资源打进安装包）：
       node.exe、server/dist、server/package.json、server 的生产依赖闭包、
       web/dist、LICENSE、docs/*.md；
  3. 调用 `npm run desktop:build`（= `tauri build`，NSIS 安装包）；
  4. 把产物复制/改名到 `dist/windows/`：
       llmapi-manager-<version>-x64-setup.exe
       llmapi-manager-<version>-win-x64-portable.zip（exe 与 runtime/ 同级）
       以及各自的 .sha256。

Node 运行时版本与 SHA256 固定在脚本顶部；升级时同时更新常量与 docs/windows.md。
本脚本只支持 Windows（需要 node.exe / PowerShell 5.1+ / Rust stable + MSVC 生成工具）；
CI 的 windows-desktop job 会在 windows-latest 上执行它。
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$OutputDir = '',
    [string]$NodeVersion = '',
    [string]$NodeZipPath = '',
    [string]$NodeSha256 = '',
    [string]$RuntimeDir = '',
    [switch]$SkipNpmCi,
    [switch]$SkipBuild,
    [switch]$SkipDesktopBuild,
    [switch]$NoPortableZip
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-common.ps1')

# 固定上游版本（升级时同时更新这里、docs/windows.md 的来源说明，并人工核对 SHA256）
$NodeDefaultVersion = '22.23.4'
$NodeDefaultSha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
$AppExeName = 'llmapi-manager.exe'

if ([string]::IsNullOrWhiteSpace($NodeVersion)) {
    $NodeVersion = $NodeDefaultVersion
}
$effectiveNodeSha = $NodeSha256
if ([string]::IsNullOrWhiteSpace($effectiveNodeSha) -and $NodeVersion -eq $NodeDefaultVersion) {
    $effectiveNodeSha = $NodeDefaultSha256
}

# ---------------------------------------------------------------------------
# 0. 基本路径、版本与参数校验
# ---------------------------------------------------------------------------
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$srcTauriDir = Join-Path $repoRoot 'src-tauri'
$tauriConfPath = Join-Path $srcTauriDir 'tauri.conf.json'

if (-not (Test-Path -LiteralPath $tauriConfPath -PathType Leaf)) {
    throw "缺少 Tauri 配置：$tauriConfPath。桌面端由 src-tauri/ 提供，请先同步仓库。"
}

$tauriConf = Get-Content -LiteralPath $tauriConfPath -Raw | ConvertFrom-Json
if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -ne [string]$tauriConf.version) {
    throw "-Version（$Version）与 src-tauri/tauri.conf.json 的 version（$($tauriConf.version)）不一致：桌面产物版本必须与 Tauri 配置相同。"
}
$Version = [string]$tauriConf.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'src-tauri/tauri.conf.json 缺少 version。'
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$') {
    throw "版本号格式不合法：$Version（应形如 0.1.0）"
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $repoRoot 'dist\windows'
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir).TrimEnd('\')
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if ([string]::IsNullOrWhiteSpace($RuntimeDir)) {
    $RuntimeDir = Join-Path $srcTauriDir 'runtime'
}
$RuntimeDir = [System.IO.Path]::GetFullPath($RuntimeDir).TrimEnd('\')
# 只允许操作 src-tauri 下的 runtime 目录：这个目录会被整个删除重建，
# 参数写错时不能让它落到仓库根或用户目录上。
if ($RuntimeDir -ieq $srcTauriDir -or
    -not $RuntimeDir.StartsWith($srcTauriDir + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "RuntimeDir 必须是 src-tauri 下的子目录：$RuntimeDir"
}

$setupPath = Join-Path $OutputDir ("llmapi-manager-$Version-x64-setup.exe")
$portableZipPath = Join-Path $OutputDir ("llmapi-manager-$Version-win-x64-portable.zip")
$portableDirName = "llmapi-manager-$Version-win-x64"

$cacheRoot = $env:TEMP
if ([string]::IsNullOrWhiteSpace($cacheRoot)) {
    $cacheRoot = Join-Path $OutputDir '_cache'
}
$cacheDir = Join-Path $cacheRoot 'llmapi-manager-build-cache'

$npmExe = Resolve-NpmCommand
$rootPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$desktopBuildScript = [string]$rootPackage.scripts.'desktop:build'
if ([string]::IsNullOrWhiteSpace($desktopBuildScript)) {
    throw "package.json 缺少 desktop:build 脚本（应为 tauri build）。本脚本不再直接调用 cargo/tauri，避免两处构建契约分叉。"
}

Write-Host "仓库：$repoRoot"
Write-Host "版本：$Version（来自 src-tauri/tauri.conf.json）"
Write-Host "输出：$OutputDir"
Write-Host "runtime：$RuntimeDir"
Write-Host "Node 运行时：$NodeVersion win-x64"

# ---------------------------------------------------------------------------
# 1. 安装依赖并构建 web/server
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
        Write-Section 'npm run build（web + server）'
        & $npmExe run build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run build 失败（退出码 $LASTEXITCODE）"
        }
    } else {
        Write-Host '已按 -SkipBuild 跳过 web/server 构建。'
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
# 2. 准备 src-tauri/runtime（Tauri bundle.resources 的来源）
# ---------------------------------------------------------------------------
Write-Section '准备 src-tauri/runtime（Node sidecar stage）'
if (Test-Path -LiteralPath $RuntimeDir) {
    Remove-Item -LiteralPath $RuntimeDir -Recurse -Force
}
$serverStageDir = Join-Path $RuntimeDir 'server'
$webStageDir = Join-Path $RuntimeDir 'web'
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $serverStageDir | Out-Null
New-Item -ItemType Directory -Force -Path $webStageDir | Out-Null

$node = Resolve-NodeRuntime -NodeVersion $NodeVersion -CacheDir $cacheDir -NodeZipPath $NodeZipPath -NodeSha256 $effectiveNodeSha
Copy-Item -LiteralPath $node.NodeExe -Destination (Join-Path $RuntimeDir 'node.exe') -Force

Copy-Item -LiteralPath (Join-Path $repoRoot 'server\package.json') -Destination (Join-Path $serverStageDir 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'server\dist') -Destination (Join-Path $serverStageDir 'dist') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'web\dist') -Destination (Join-Path $webStageDir 'dist') -Recurse -Force

$licensePath = Join-Path $repoRoot 'LICENSE'
if (Test-Path -LiteralPath $licensePath -PathType Leaf) {
    Copy-Item -LiteralPath $licensePath -Destination (Join-Path $RuntimeDir 'LICENSE') -Force
}

# 随应用带上用户文档，桌面端离线时也能查（docs/*.md 之间有相对链接，整份复制）
$docsSource = Join-Path $repoRoot 'docs'
if (Test-Path -LiteralPath $docsSource -PathType Container) {
    $docsStageDir = Join-Path $RuntimeDir 'docs'
    New-Item -ItemType Directory -Force -Path $docsStageDir | Out-Null
    Get-ChildItem -LiteralPath $docsSource -Filter '*.md' -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $docsStageDir -Force
    }
}

# 分发 node.exe 需要附带 Node 自己的 LICENSE
$nodeLicense = Join-Path $node.SourceDir 'LICENSE'
if (Test-Path -LiteralPath $nodeLicense -PathType Leaf) {
    $licensesDir = Join-Path $RuntimeDir 'licenses'
    New-Item -ItemType Directory -Force -Path $licensesDir | Out-Null
    Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $licensesDir 'node-LICENSE.txt') -Force
}

# ---------------------------------------------------------------------------
# 3. 只复制 server 的生产依赖闭包（等价于 npm ci --omit=dev -w server）
# ---------------------------------------------------------------------------
Write-Section '收集 server 生产依赖'
$serverPackage = Get-Content -LiteralPath (Join-Path $repoRoot 'server\package.json') -Raw | ConvertFrom-Json
$serverPackageName = [string]$serverPackage.name
if ([string]::IsNullOrWhiteSpace($serverPackageName)) {
    throw 'server/package.json 缺少 name，无法解析生产依赖。'
}

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

$serverModuleDir = Join-Path $serverStageDir 'node_modules'
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

# stage 自检：sidecar 启动必需的文件与依赖
foreach ($required in @(
    'node.exe',
    'server\package.json',
    'server\dist\index.js',
    'web\dist\index.html',
    'server\node_modules\fastify',
    'server\node_modules\@fastify\cookie',
    'server\node_modules\@fastify\static'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $RuntimeDir $required))) {
        throw "runtime stage 缺少：$required"
    }
}

$runtimeSize = (Get-ChildItem -LiteralPath $RuntimeDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host ("runtime 大小：{0:N1} MB" -f ($runtimeSize / 1MB))

# ---------------------------------------------------------------------------
# 4. Tauri 打包（NSIS）
# ---------------------------------------------------------------------------
Push-Location -LiteralPath $repoRoot
try {
    if (-not $SkipDesktopBuild.IsPresent) {
        Write-Section 'npm run desktop:build（tauri build → NSIS）'
        & $npmExe run desktop:build
        if ($LASTEXITCODE -ne 0) {
            throw "npm run desktop:build 失败（退出码 $LASTEXITCODE）"
        }
    } else {
        Write-Host '已按 -SkipDesktopBuild 跳过 tauri build（沿用 src-tauri/target 里的已有产物）。'
    }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 5. 定位桌面主程序
# ---------------------------------------------------------------------------
Write-Section '定位桌面可执行文件'
$releaseDir = Join-Path $srcTauriDir 'target\release'
$releaseExe = Join-Path $releaseDir $AppExeName
if (-not (Test-Path -LiteralPath $releaseExe -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $releaseDir -PathType Container)) {
        throw "找不到 Tauri release 目录：$releaseDir。请确认 npm run desktop:build 成功。"
    }
    $candidates = @(Get-ChildItem -LiteralPath $releaseDir -Filter '*.exe' -File -ErrorAction SilentlyContinue)
    if ($candidates.Count -eq 1) {
        $releaseExe = $candidates[0].FullName
        Write-Host "未找到 $AppExeName，改用 release 目录下唯一的 exe：$releaseExe"
    } elseif ($candidates.Count -eq 0) {
        throw "release 目录下没有任何 exe：$releaseDir。请确认 npm run desktop:build 成功。"
    } else {
        $names = ($candidates | ForEach-Object { $_.Name }) -join ', '
        throw ("release 目录下有多个 exe，无法确定应用主程序：$names。请检查 src-tauri/Cargo.toml 是否只有一个 bin。")
    }
}

# ---------------------------------------------------------------------------
# 6. 复制 NSIS 安装包并改名
# ---------------------------------------------------------------------------
Write-Section '复制 NSIS 安装包'
$nsisDir = Join-Path $srcTauriDir 'target\release\bundle\nsis'
$setupSource = $null
if (Test-Path -LiteralPath $nsisDir -PathType Container) {
    $setupSource = Get-ChildItem -LiteralPath $nsisDir -Filter '*.exe' -File |
        Where-Object { $_.Name -match '-setup\.exe$' } |
        Select-Object -First 1
    if ($null -eq $setupSource) {
        $setupSource = Get-ChildItem -LiteralPath $nsisDir -Filter '*.exe' -File | Select-Object -First 1
    }
}
if ($null -eq $setupSource) {
    throw "找不到 NSIS 安装包（$nsisDir）。请确认 src-tauri/tauri.conf.json 的 bundle.targets 包含 nsis。"
}
if (Test-Path -LiteralPath $setupPath -PathType Leaf) {
    Remove-Item -LiteralPath $setupPath -Force
}
Copy-Item -LiteralPath $setupSource.FullName -Destination $setupPath -Force
Write-Host "安装包：$setupPath"
Write-ChecksumFile -Path $setupPath

# ---------------------------------------------------------------------------
# 7. 便携 zip：exe 与 runtime/ 同级，解压即用
# ---------------------------------------------------------------------------
if (-not $NoPortableZip.IsPresent) {
    Write-Section '生成便携 zip'
    if ([string]::IsNullOrWhiteSpace($env:TEMP)) {
        $stageRoot = Join-Path $OutputDir ('_portable-' + [System.Guid]::NewGuid().ToString('N'))
    } else {
        $stageRoot = Join-Path $env:TEMP ('llmapi-manager-portable-' + [System.Guid]::NewGuid().ToString('N'))
    }
    $stageDir = Join-Path $stageRoot $portableDirName
    try {
        New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
        # 无论 release exe 实际叫什么，便携包内统一为 llmapi-manager.exe（桌面端按此名定位）
        Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $stageDir $AppExeName) -Force
        Copy-Item -LiteralPath $RuntimeDir -Destination (Join-Path $stageDir 'runtime') -Recurse -Force
        Compress-DirectoryToZip -SourceDir $stageDir -ZipPath $portableZipPath -IncludeBaseDirectory
        Write-ChecksumFile -Path $portableZipPath
    } finally {
        if (Test-Path -LiteralPath $stageRoot) {
            Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
} else {
    Write-Host '已按 -NoPortableZip 跳过便携 zip。'
}

# ---------------------------------------------------------------------------
# 8. 结果
# ---------------------------------------------------------------------------
Write-Section '完成'
Write-Host "输出目录：$OutputDir"
Write-Host "安装包：$setupPath"
if (-not $NoPortableZip.IsPresent) {
    Write-Host "便携 zip：$portableZipPath"
}
Write-Host "桌面主程序：$releaseExe"
Write-Host "Node 运行时：$NodeVersion（$($node.ZipPath)）"
