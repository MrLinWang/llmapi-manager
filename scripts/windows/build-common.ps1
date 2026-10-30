<#
.SYNOPSIS
Windows 构建脚本共用的下载、SHA256、UTF-8 与 zip 工具。

.DESCRIPTION
由 build-desktop.ps1 通过点源（dot-source）引用：

    . (Join-Path $PSScriptRoot 'build-common.ps1')

这里只放**构建期**工具。服务安装/卸载专用的东西（管理员检查、ACL、WinSW、
robocopy、ProgramData 路径、install-result 文件等）在 legacy-service/ 里，
不要再把它们加回本文件——桌面版不再安装 Windows 服务。

约束：
  * 只使用 Windows PowerShell 5.1 自带的语法与 cmdlet（不要 ??、?.、三元运算符、
    -AsHashtable、ForEach-Object -Parallel、Join-Path -AdditionalChildPath 等
    PowerShell 7 专有语法）。
  * 本文件必须保存为 **UTF-8 with BOM**，否则 5.1 会按系统 ANSI 代码页解码中文。
  * 路径操作用 -LiteralPath，避免 [] 被当成通配符。
#>

function Write-Section {
    <#
    .SYNOPSIS
    打印一个分节标题，便于把长构建日志分段。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Text
    )

    Write-Host ''
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Invoke-Download {
    <#
    .SYNOPSIS
    下载文件；父目录不存在时自动创建。

    .DESCRIPTION
    Windows PowerShell 5.1 默认可能仍协商 TLS 1.0，nodejs.org 会直接拒绝，
    因此显式要求 TLS 1.2。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $parent = Split-Path -Parent $Destination
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    try {
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    } catch {
        # 极老的 .NET 没有 Tls12 枚举值；此时让 Invoke-WebRequest 用默认协议，失败会自然报错。
        Write-Warning "无法显式设置 TLS 1.2：$($_.Exception.Message)"
    }
    Write-Host "下载：$Url"
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Get-Sha256 {
    <#
    .SYNOPSIS
    计算文件的 SHA256（小写十六进制）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256 {
    <#
    .SYNOPSIS
    校验文件 SHA256；不一致时抛错。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$What
    )

    $actual = Get-Sha256 -Path $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "$What SHA256 不匹配。期望：$Expected，实际：$actual（文件：$Path）"
    }
    Write-Host "$What SHA256 校验通过：$actual"
}

function Write-ChecksumFile {
    <#
    .SYNOPSIS
    为文件生成 `<sha256>  <文件名>` 校验文件（ASCII，与 sha256sum 输出兼容）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    $hash = Get-Sha256 -Path $Path
    $name = [System.IO.Path]::GetFileName($Path)
    $target = $Path + '.sha256'
    Set-Content -LiteralPath $target -Value ($hash + '  ' + $name) -Encoding Ascii
    Write-Host "SHA256：$hash（$target）"
}

function Write-TextFileUtf8 {
    <#
    .SYNOPSIS
    以 UTF-8 写文本文件（默认**不带 BOM**）。

    .DESCRIPTION
    桌面端 sidecar 的 .env / desktop.env 不能带 BOM：服务端 applyEnvFile 与
    Rust 侧按行 strip_prefix 解析，BOM 会让第一行键名变成 `<BOM>KEY` 从而失效。
    只有明确需要 BOM 的中间文件才用 -WithBom。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [switch]$WithBom
    )

    $encoding = New-Object System.Text.UTF8Encoding -ArgumentList ([bool]$WithBom.IsPresent)
    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

function Compress-DirectoryToZip {
    <#
    .SYNOPSIS
    把目录压缩成 zip；-IncludeBaseDirectory 时把目录名作为 zip 顶层。

    .DESCRIPTION
    不用 Compress-Archive：大目录（Node runtime + node_modules）下它慢得多，
    而且 5.1 的 Compress-Archive 对长路径更脆弱。直接调 .NET 的 ZipFile。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$ZipPath,
        [switch]$IncludeBaseDirectory
    )

    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        throw "压缩源目录不存在：$SourceDir"
    }
    $parent = Split-Path -Parent $ZipPath
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    if (Test-Path -LiteralPath $ZipPath -PathType Leaf) {
        Remove-Item -LiteralPath $ZipPath -Force
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $includeBase = $IncludeBaseDirectory.IsPresent
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        [System.IO.Path]::GetFullPath($SourceDir),
        [System.IO.Path]::GetFullPath($ZipPath),
        [System.IO.Compression.CompressionLevel]::Optimal,
        $includeBase
    )
    Write-Host "已生成 zip：$ZipPath"
}

function Resolve-NpmCommand {
    <#
    .SYNOPSIS
    找到 npm 可执行文件（Windows 上优先 npm.cmd）。
    #>
    [CmdletBinding()]
    param()

    $candidate = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $candidate) {
        $candidate = Get-Command npm -ErrorAction SilentlyContinue
    }
    if ($null -eq $candidate) {
        throw '找不到 npm。请先安装 Node.js 22 LTS x64，并把 npm 放进 PATH。'
    }
    return $candidate.Source
}

function Resolve-NodeRuntime {
    <#
    .SYNOPSIS
    下载/复用并校验 Node win-x64 zip，解压后返回 node.exe 的完整路径。

    .DESCRIPTION
    返回值：PSCustomObject，含 NodeExe（node.exe 全路径）、SourceDir（node.exe
    所在目录，用于顺带打包 Node 的 LICENSE）、ZipPath（实际使用的 zip）。

    SHA256 来源优先级：
      1. -NodeSha256（构建脚本顶部常量，固定版本时使用）；
      2. 否则下载 nodejs.org 的 SHASUMS256.txt 按文件名匹配。
    缓存目录下同时保留 zip 与解压结果，重复构建不会重复下载。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$NodeVersion,
        [Parameter(Mandatory = $true)][string]$CacheDir,
        [string]$NodeZipPath = '',
        [string]$NodeSha256 = ''
    )

    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

    $nodeZip = $NodeZipPath
    if ([string]::IsNullOrWhiteSpace($nodeZip)) {
        $nodeZip = Join-Path $CacheDir ("node-v$NodeVersion-win-x64.zip")
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

    $expected = $NodeSha256
    if ([string]::IsNullOrWhiteSpace($expected)) {
        $shaFile = Join-Path $CacheDir ("SHASUMS256-v$NodeVersion.txt")
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
        $expected = (($match -split '\s+')[0])
    }
    Assert-Sha256 -Path $nodeZip -Expected $expected -What "Node $NodeVersion win-x64 zip"

    $extractRoot = Join-Path $CacheDir ("node-v$NodeVersion-win-x64-extract")
    $nodeExe = Join-Path $extractRoot 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
        if (Test-Path -LiteralPath $extractRoot) {
            Remove-Item -LiteralPath $extractRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
        Write-Host "解压 Node 运行时到：$extractRoot"
        Expand-Archive -Path $nodeZip -DestinationPath $extractRoot -Force
        $found = Get-ChildItem -LiteralPath $extractRoot -Filter 'node.exe' -Recurse -File | Select-Object -First 1
        if ($null -eq $found) {
            throw "Node zip 中找不到 node.exe：$nodeZip"
        }
        $nodeExe = $found.FullName
    }

    return [pscustomobject]@{
        NodeExe   = $nodeExe
        SourceDir = (Split-Path -Parent $nodeExe)
        ZipPath   = $nodeZip
    }
}
