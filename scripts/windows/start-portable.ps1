<#
.SYNOPSIS
便携版启动脚本：不安装服务，直接在前台运行 llmapi-manager。

.DESCRIPTION
只能在**构建产物**（便携 zip 解压后的目录）里运行：它要求同级目录有 node.exe、
server\dist\index.js 与 web\dist\index.html。仓库源码目录请用 npm run dev / npm start。

首次运行会在包目录生成 .env：
  HOST=127.0.0.1（只允许本机访问；要让其它设备访问改成 0.0.0.0 并用防火墙放行）
  PORT / PUBLIC_BASE_URL / DATA_DIR / LOG_DIR / DATA_ENCRYPTION_KEY / AGENT_HOME_DIR

便携版不设置 ADMIN_PASSWORD：首次启动会在控制台打印一次性初始化令牌，
打开 http://127.0.0.1:8787 按提示创建管理员。
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$ListenHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "端口不合法：$Port"
}

$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$nodeExe = Join-Path $packageRoot 'node.exe'
$entry = Join-Path $packageRoot 'server\dist\index.js'

if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    throw "找不到 node.exe：$nodeExe`n请在解压后的便携包目录中运行本脚本（源码目录请用 npm start）。"
}
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw "找不到服务端入口：$entry`n便携包不完整，请重新解压。"
}
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'web\dist\index.html') -PathType Leaf)) {
    throw "找不到前端静态资源：$packageRoot\web\dist\index.html`n便携包不完整，请重新解压。"
}

$envFile = Join-Path $packageRoot '.env'
$dataDir = Join-Path $packageRoot 'data'
$logDir = Join-Path $packageRoot 'log'
$envCreated = $false

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $encryptionKey = New-RandomHex -ByteCount 32
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# llmapi-manager 便携版配置（首次运行自动生成，可手工编辑）')
    $lines.Add('# 只允许本机访问；要让其它设备访问，把 HOST 改成 0.0.0.0 并用防火墙放行端口。')
    $lines.Add('HOST=' + $ListenHost)
    $lines.Add('PORT=' + $Port)
    $lines.Add('PUBLIC_BASE_URL=http://127.0.0.1:' + $Port)
    $lines.Add('DATA_DIR="' + $dataDir + '"')
    $lines.Add('LOG_DIR="' + $logDir + '"')
    $lines.Add('DATA_ENCRYPTION_KEY=' + $encryptionKey)
    $lines.Add('ADMIN_USERNAME=admin')
    $lines.Add('AGENT_HOME_DIR="' + $env:USERPROFILE + '"')
    Write-TextFileUtf8 -Path $envFile -Text (($lines -join "`r`n") + "`r`n")
    $envCreated = $true
}

if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
}
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}

Write-Host ''
Write-Host 'LLM API Manager（便携版）' -ForegroundColor Cyan
Write-Host "包目录：$packageRoot"
Write-Host "控制台：http://127.0.0.1:$Port"
Write-Host "数据目录：$dataDir"
Write-Host "日志目录：$logDir"
if ($envCreated) {
    Write-Host '已生成 .env（含随机 DATA_ENCRYPTION_KEY）。' -ForegroundColor Green
}
Write-Host ''
Write-Host '首次启动若尚未创建管理员，控制台会打印一次性初始化令牌；' -ForegroundColor Yellow
Write-Host '打开上面的地址，用该令牌按提示创建管理员账号。' -ForegroundColor Yellow
Write-Host '按 Ctrl+C 停止。' -ForegroundColor Yellow
Write-Host ''

# 服务端按进程 cwd 读取 .env，所以必须切到包目录再启动
Push-Location -LiteralPath $packageRoot
try {
    & $nodeExe $entry
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
