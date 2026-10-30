<#
.SYNOPSIS
llmapi-manager Windows 安装/卸载/便携启动脚本的共用函数。

.DESCRIPTION
由 install-service.ps1、uninstall-service.ps1、start-portable.ps1 通过点源（dot-source）引用：

    . (Join-Path $PSScriptRoot 'common.ps1')

约束：
  * 只使用 Windows PowerShell 5.1 自带的语法与 cmdlet（不依赖 PowerShell 7 专有语法，
    例如 ??、三元运算符、-AsHashtable、ForEach-Object -Parallel 等）。
  * 脚本文件必须保存为 **UTF-8 with BOM**。Windows PowerShell 5.1 对没有 BOM 的 .ps1
    按系统 ANSI 代码页解释，中文会乱码。
  * 所有路径操作用 -LiteralPath，避免 [] 被当成通配符。
#>

function Assert-Administrator {
    <#
    .SYNOPSIS
    确认当前进程已提升为管理员；否则抛出可读错误。
    #>
    [CmdletBinding()]
    param()

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal -ArgumentList $identity
    $isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        throw '此操作需要管理员权限。请右键“以管理员身份运行”PowerShell，或直接使用安装程序。'
    }
}

function New-RandomHex {
    <#
    .SYNOPSIS
    用密码学安全随机数生成十六进制字符串（默认 24 字节 = 48 个字符）。
    #>
    [CmdletBinding()]
    param(
        [int]$ByteCount = 24
    )

    if ($ByteCount -lt 1) {
        throw "ByteCount 必须是正整数，实际为 $ByteCount"
    }

    $bytes = New-Object -TypeName 'byte[]' -ArgumentList $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }

    $builder = New-Object System.Text.StringBuilder
    foreach ($b in $bytes) {
        [void]$builder.Append($b.ToString('x2'))
    }
    return $builder.ToString()
}

function Write-TextFileUtf8 {
    <#
    .SYNOPSIS
    以 UTF-8 写文本文件（默认不带 BOM）。

    .DESCRIPTION
    服务端读取 .env 时不会剥离 BOM，BOM 会让第一行键名变成 `<BOM>HOST` 从而失效，
    所以 .env 必须用 -WithBom:$false（默认）。只有给安装程序读取的中间结果文件
    才用 -WithBom。
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

function Read-EnvMap {
    <#
    .SYNOPSIS
    读取 .env 为有序字典（保留未知键，供升级时原样写回）。

    .DESCRIPTION
    只做“键 = 值”的机械解析，与 server/src/config.ts 的 applyEnvFile 保持一致：
    忽略空行与 # 注释、去掉键值两端空白、保留值两侧的引号原文（写回时原样输出）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path
    )

    # 用不区分大小写的比较器：Windows 环境变量名本身不区分大小写，
    # 避免用户手写成 host= 时又生成一条 HOST=，服务端读到哪条就变得不确定。
    $map = New-Object System.Collections.Specialized.OrderedDictionary -ArgumentList ([System.StringComparer]::OrdinalIgnoreCase)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $map
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
        $key = $trimmed.Substring(0, $eq).Trim()
        $value = $trimmed.Substring($eq + 1).Trim()
        if ($key.Length -eq 0) {
            continue
        }
        $map[$key] = $value
    }
    return $map
}

function Resolve-ProgramDataDir {
    <#
    .SYNOPSIS
    解析服务数据根目录，默认 %ProgramData%\llmapi-manager。
    #>
    [CmdletBinding()]
    param(
        [string]$Override = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Override)) {
        return [System.IO.Path]::GetFullPath($Override).TrimEnd('\')
    }

    $base = $env:ProgramData
    if ([string]::IsNullOrWhiteSpace($base)) {
        $base = [Environment]::GetFolderPath('CommonApplicationData')
    }
    if ([string]::IsNullOrWhiteSpace($base)) {
        throw '无法确定 ProgramData 目录，请用 -ProgramDataDir 显式指定。'
    }
    return (Join-Path $base 'llmapi-manager')
}

function Get-ServiceAccountIdentity {
    <#
    .SYNOPSIS
    把 -ServiceAccount 参数解析成 WinSW XML / icacls 需要的形式。

    .OUTPUTS
    PSCustomObject：Kind（LocalSystem / LocalService / NetworkService / Custom）、
    Domain、User、Display、Acl（icacls 用的账户标识：内置账户用 SID，自定义账户用 DOMAIN\user）。
    #>
    [CmdletBinding()]
    param(
        [string]$Account = 'LocalSystem'
    )

    $value = ''
    if ($null -ne $Account) {
        $value = $Account.Trim()
    }

    if ($value -eq '' -or $value -ieq 'LocalSystem' -or $value -ieq 'SYSTEM' -or $value -ieq 'NT AUTHORITY\SYSTEM') {
        return [pscustomobject]@{
            Kind    = 'LocalSystem'
            Domain  = 'NT AUTHORITY'
            User    = 'LocalSystem'
            Display = 'LocalSystem'
            Acl     = '*S-1-5-18'
        }
    }
    if ($value -ieq 'LocalService' -or $value -ieq 'NT AUTHORITY\LocalService') {
        return [pscustomobject]@{
            Kind    = 'LocalService'
            Domain  = 'NT AUTHORITY'
            User    = 'LocalService'
            Display = 'NT AUTHORITY\LocalService'
            Acl     = '*S-1-5-19'
        }
    }
    if ($value -ieq 'NetworkService' -or $value -ieq 'NT AUTHORITY\NetworkService') {
        return [pscustomobject]@{
            Kind    = 'NetworkService'
            Domain  = 'NT AUTHORITY'
            User    = 'NetworkService'
            Display = 'NT AUTHORITY\NetworkService'
            Acl     = '*S-1-5-20'
        }
    }

    $domain = '.'
    $user = $value
    if ($value.Contains('\')) {
        $idx = $value.IndexOf('\')
        $domain = $value.Substring(0, $idx)
        $user = $value.Substring($idx + 1)
    }
    if ([string]::IsNullOrWhiteSpace($user)) {
        throw "服务账号格式不正确：$Account（应为 LocalSystem / LocalService / NetworkService 或 DOMAIN\user）"
    }
    return [pscustomobject]@{
        Kind    = 'Custom'
        Domain  = $domain
        User    = $user
        Display = "$domain\$user"
        Acl     = "$domain\$user"
    }
}

function Invoke-Icacls {
    <#
    .SYNOPSIS
    调用 icacls，并在失败（退出码 >= 8）时抛出带命令上下文的错误。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Arguments = @()
    )

    & icacls.exe $Path @Arguments | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "icacls 失败（退出码 $code）：$Path $($Arguments -join ' ')"
    }
}

function Set-RestrictedFileAcl {
    <#
    .SYNOPSIS
    把文件的 ACL 收紧为“管理员 + SYSTEM + 服务账号只读”。

    .DESCRIPTION
    用于 .env（含 DATA_ENCRYPTION_KEY / 初始 ADMIN_PASSWORD）与安装结果文件。
    用 SID 而不是本地化账户名，避免中文/英文 Windows 的 Administrators 名称差异。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ServiceAccountAcl = '*S-1-5-18'
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "文件不存在，无法设置 ACL：$Path"
    }

    $aclArgs = @('/inheritance:r', '/grant:r', '*S-1-5-32-544:F', '*S-1-5-18:F')
    if (-not [string]::IsNullOrWhiteSpace($ServiceAccountAcl) -and $ServiceAccountAcl -ine '*S-1-5-18') {
        $aclArgs += ($ServiceAccountAcl + ':R')
    }
    Invoke-Icacls -Path $Path -Arguments $aclArgs
}

function Grant-DirectoryModify {
    <#
    .SYNOPSIS
    给目录（含继承）授予修改权限。

    .DESCRIPTION
    使用 (OI)(CI)M 继承标记；Windows 会把新 ACE 传播到已有子对象，
    因此不需要 /T 递归（大目录下 /T 会很慢）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AclEntry
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
    Invoke-Icacls -Path $Path -Arguments @('/grant', ($AclEntry + ':(OI)(CI)M'))
}

function Get-IdentityUsers {
    <#
    .SYNOPSIS
    读取 identity.json 里的用户列表；文件缺失或损坏时返回空数组。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$IdentityFile
    )

    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        return @()
    }
    try {
        $data = Get-Content -LiteralPath $IdentityFile -Raw -ErrorAction Stop | ConvertFrom-Json
    } catch {
        return @()
    }
    if ($null -eq $data -or $null -eq $data.users) {
        return @()
    }
    return @($data.users)
}

function Copy-DirectoryMirror {
    <#
    .SYNOPSIS
    用 robocopy /MIR 同步目录（robocopy 退出码 0-7 都表示成功）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source)) {
        return
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy.exe $Source $Destination /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    $code = $LASTEXITCODE
    if ($code -ge 8) {
        throw "复制目录失败：$Source -> $Destination（robocopy 退出码 $code）"
    }
}

function Write-InstallResultFile {
    <#
    .SYNOPSIS
    写安装结果 key=value 文件，供 Inno Setup 的 [Code] 用 LoadStringsFromFile 读取。

    .DESCRIPTION
    不用 JSON：Inno 6 的 LoadStringFromFile 参数是 AnsiString，读 UTF-8 会乱码；
    而 LoadStringsFromFile 明确支持 UTF-8（带不带 BOM 均可），逐行解析最稳。
    文件用 UTF-8 with BOM，兼容较老的 Inno 6。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Values
    )

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Values.Keys) {
        $value = $Values[$key]
        if ($null -eq $value) {
            $value = ''
        }
        $text = [string]$value
        # 结果文件是一行一个键值，换行会破坏解析；把值里的 CR/LF 压成空格。
        $text = $text.Replace("`r", ' ').Replace("`n", ' ')
        $lines.Add(([string]$key) + '=' + $text)
    }
    $content = ($lines -join "`r`n") + "`r`n"
    Write-TextFileUtf8 -Path $Path -Text $content -WithBom
}
