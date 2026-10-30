; llmapi-manager Inno Setup 6 安装脚本
;
; 由 build-package.ps1 通过命令行 /D 传入 AppVersion / StageDir / OutputDir 后调用 ISCC。
;
; 安装流程：
;   1. 复制 stage 到 {app}；
;   2. [Code] 在 ssPostInstall 调用 scripts\windows\install-service.ps1，
;      生成 .env、安装并启动 WinSW 服务、做健康检查；
;   3. 完成页显示管理员账号 / 初始口令 / 控制台地址（口令只显示一次）。
;
; 支持的命令行参数（安装程序）：
;   /PORT=8787               覆盖监听端口（会同时写入 PUBLIC_BASE_URL 的默认值）
;   /PUBLICBASEURL=...       覆盖写进 Agent 配置的网关地址
;   /ALLOWINSECURESYNC=1     允许同步快照走明文 HTTP（仅可信内网）
;   /ADMINPASSWORD=...       指定初始管理员口令（不传则随机生成）
;   /CODEXBIN=...            指定 codex 可执行文件路径
;   /NOSERVICE=1             只复制文件，不安装 Windows 服务
;   /SILENT 或 /VERYSILENT   静默安装（没有完成页；初始口令见 %ProgramData%\llmapi-manager\install-result.env）
;
; 卸载：
;   - 默认保留 %ProgramData%\llmapi-manager 下的数据、日志和 .env（含 DATA_ENCRYPTION_KEY）。
;   - 需要彻底删除数据时，先在管理员 PowerShell 里运行：
;       "<安装目录>\scripts\windows\uninstall-service.ps1" -Purge
;     再从“应用和功能”卸载。

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef StageDir
  #define StageDir "..\..\dist\windows\stage\llmapi-manager-dev-win-x64"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist\windows"
#endif

#define MyAppName "LLM API Manager"
#define MyAppServiceName "llmapi-manager"

[Setup]
AppId={{6D2C4A0E-7A8B-4C53-9C0D-5AE5F7B2C1D3}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppVerName={#MyAppName} {#AppVersion}
AppPublisher=llmapi-manager
DefaultDirName={autopf}\llmapi-manager
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=llmapi-manager-setup-{#AppVersion}-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\node.exe
LicenseFile={#StageDir}\LICENSE
CloseApplications=no

[Tasks]
Name: "firewall"; Description: "在 Windows 防火墙中放行服务端口（仅专用网络）"; GroupDescription: "附加配置:"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".env,install-result.env,data\*,log\*"

[Icons]
Name: "{group}\{#MyAppName} 控制台"; Filename: "{app}\console.url"; Comment: "打开本地控制台"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\console.url"; Description: "打开管理控制台"; Flags: postinstall shellexec nowait skipifsilent unchecked

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\windows\uninstall-service.ps1"" -InstallDir ""{app}"" -ServiceName ""{#MyAppServiceName}"" -KeepFiles -Quiet"; Flags: runhidden waituntilterminated; RunOnceId: "StopLLMApiManagerService"

[UninstallDelete]
; 这些文件是安装后生成的，不在卸载器的安装清单里；数据在 ProgramData，默认保留。
Type: files; Name: "{app}\.env"
Type: files; Name: "{app}\console.url"
Type: files; Name: "{app}\llmapi-manager-service.xml"
Type: files; Name: "{app}\.env.bak-*"
Type: filesandordirs; Name: "{app}\.rollback-*"
Type: dirifempty; Name: "{app}"

[Code]
var
  ServiceInstallAttempted: Boolean;
  ServiceInstallOk: Boolean;
  ServiceInstallSkipped: Boolean;
  ServiceInstallError: String;
  InstallResultFile: String;

function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function ParamValue(const Name, DefaultValue: String): String;
begin
  Result := ExpandConstant('{param:' + Name + '|' + DefaultValue + '}');
end;

function ReadResultValue(const FileName, Key: String): String;
var
  Lines: TArrayOfString;
  I, P: Integer;
  Line: String;
begin
  Result := '';
  if not LoadStringsFromFile(FileName, Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Lines[I];
    P := Pos('=', Line);
    if (P > 0) and (Copy(Line, 1, P - 1) = Key) then
    begin
      Result := Copy(Line, P + 1, Length(Line) - P);
      Exit;
    end;
  end;
end;

function RunServiceInstall(): Boolean;
var
  ResultCode: Integer;
  Params, Port, PublicBaseUrl, AdminPassword, CodexBin, AppDir: String;
begin
  Result := False;
  AppDir := ExpandConstant('{app}');
  InstallResultFile := ExpandConstant('{commonappdata}\llmapi-manager\install-result.env');

  Port := ParamValue('PORT', '8787');
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + AppDir + '\scripts\windows\install-service.ps1"' +
    ' -SourceDir "' + AppDir + '"' +
    ' -InstallDir "' + AppDir + '"' +
    ' -SkipCopy' +
    ' -Port ' + Port +
    ' -AgentHomeDir "' + ExpandConstant('{%USERPROFILE}') + '"' +
    ' -ResultFile "' + InstallResultFile + '"';

  if WizardIsTaskSelected('firewall') then
    Params := Params + ' -EnableFirewall';

  PublicBaseUrl := ParamValue('PUBLICBASEURL', '');
  if PublicBaseUrl <> '' then
    Params := Params + ' -PublicBaseUrl "' + PublicBaseUrl + '"';

  if ParamValue('ALLOWINSECURESYNC', '0') = '1' then
    Params := Params + ' -SyncAllowInsecure';

  AdminPassword := ParamValue('ADMINPASSWORD', '');
  if AdminPassword <> '' then
    Params := Params + ' -AdminPassword "' + AdminPassword + '"';

  CodexBin := ParamValue('CODEXBIN', '');
  if CodexBin <> '' then
    Params := Params + ' -CodexBin "' + CodexBin + '"';

  if not Exec(PowerShellExe(), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    ServiceInstallError := '无法启动 Windows PowerShell（' + PowerShellExe() + '）。';
    Exit;
  end;

  Result := (ResultCode = 0);
  if not Result then
  begin
    ServiceInstallError := ReadResultValue(InstallResultFile, 'error');
    if ServiceInstallError = '' then
      ServiceInstallError := '安装服务失败（PowerShell 退出码 ' + IntToStr(ResultCode) + '）。';
  end;
end;

procedure StopServiceBeforeInstall();
var
  ResultCode: Integer;
  Params: String;
begin
  // 升级时旧服务可能还在运行，node.exe 被占用会让 [Files] 覆盖文件失败。
  // 在 ssInstall（复制文件之前）先停掉服务并等它真正进入 Stopped。
  Params := '-NoProfile -ExecutionPolicy Bypass -Command "' +
    'if (Get-Service -Name ''{#MyAppServiceName}'' -ErrorAction SilentlyContinue) {' +
    ' Stop-Service -Name ''{#MyAppServiceName}'' -Force -ErrorAction SilentlyContinue;' +
    ' try { (Get-Service -Name ''{#MyAppServiceName}'').WaitForStatus(''Stopped'', ''00:00:30'') } catch { } }"';
  Exec(PowerShellExe(), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    StopServiceBeforeInstall();
  end;

  if CurStep = ssPostInstall then
  begin
    if ParamValue('NOSERVICE', '0') = '1' then
    begin
      ServiceInstallSkipped := True;
      ServiceInstallOk := False;
    end
    else
    begin
      ServiceInstallAttempted := True;
      ServiceInstallOk := RunServiceInstall();
    end;

    if (not ServiceInstallOk) and (not ServiceInstallSkipped) and (not WizardSilent) then
    begin
      MsgBox(
        '程序文件已复制，但 Windows 服务没有安装成功：' + #13#10 + #13#10 +
        ServiceInstallError + #13#10 + #13#10 +
        '修复问题后可在管理员 PowerShell 中重新运行：' + #13#10 +
        '"' + ExpandConstant('{app}') + '\scripts\windows\install-service.ps1" -SourceDir "' +
        ExpandConstant('{app}') + '" -InstallDir "' + ExpandConstant('{app}') + '" -SkipCopy' + #13#10 + #13#10 +
        '日志目录：' + ReadResultValue(InstallResultFile, 'logDir'),
        mbError, MB_OK);
    end;
  end;
end;

function BuildFinishedCaption(): String;
var
  Url, UserName, Password, DataDir, LogDir: String;
begin
  if ServiceInstallSkipped then
  begin
    Result := '程序文件已安装，但按 /NOSERVICE=1 跳过了 Windows 服务安装。' + #13#10 +
      '稍后可在管理员 PowerShell 中运行：' + #13#10 +
      '"' + ExpandConstant('{app}') + '\scripts\windows\install-service.ps1"';
    Exit;
  end;

  if not ServiceInstallOk then
  begin
    Result := '程序文件已安装，但服务安装失败。' + #13#10 +
      '错误：' + ServiceInstallError + #13#10 + #13#10 +
      '请查看日志目录：' + ReadResultValue(InstallResultFile, 'logDir') + #13#10 +
      '修复后重新运行 install-service.ps1。';
    Exit;
  end;

  Url := ReadResultValue(InstallResultFile, 'url');
  UserName := ReadResultValue(InstallResultFile, 'username');
  Password := ReadResultValue(InstallResultFile, 'password');
  DataDir := ReadResultValue(InstallResultFile, 'dataDir');
  LogDir := ReadResultValue(InstallResultFile, 'logDir');

  Result := 'LLM API Manager 已安装，并已作为 Windows 服务（自动启动）运行。' + #13#10 + #13#10 +
    '控制台地址：' + Url + #13#10 +
    '管理员账号：' + UserName + #13#10;
  if Password <> '' then
    Result := Result + '初始口令：' + Password + #13#10 +
      '（口令只显示这一次；登录后请在「设置」中修改）' + #13#10
  else
    Result := Result + '（沿用已有管理员账号，未生成新口令）' + #13#10;
  Result := Result + #13#10 +
    '数据目录：' + DataDir + #13#10 +
    '日志目录：' + LogDir + #13#10;
end;

procedure SetFinishedText(const S: String);
var
  Y, Delta, RadioGap, Ignored: Integer;
begin
  // 完成页默认只给 FinishedLabel 一个固定高度；直接改 Caption 会被截断、且会盖住
  // 下面的 RunList / Yes/No 单选。这里按 Inno 内部 ChangeFinishedLabel 的做法重新排版。
  WizardForm.FinishedLabel.Caption := S + #13#10;
  Ignored := WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
  Y := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height;
  RadioGap := WizardForm.NoRadio.Top - WizardForm.YesRadio.Top;
  Delta := Y - WizardForm.YesRadio.Top;
  WizardForm.IncTopDecHeight(WizardForm.RunList, Delta);
  WizardForm.YesRadio.Top := Y;
  WizardForm.NoRadio.Top := Y + RadioGap;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    SetFinishedText(BuildFinishedCaption());
    // 非静默安装：口令已显示在完成页，立即删除含明文口令的中间结果文件。
    // 安装失败时保留该文件用于排查；静默安装没有完成页，也保留它供管理员读取。
    if (not WizardSilent) and (ServiceInstallOk or ServiceInstallSkipped) and FileExists(InstallResultFile) then
      DeleteFile(InstallResultFile);
  end;
end;
