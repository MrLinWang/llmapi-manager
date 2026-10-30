/**
 * Windows 运行时的纯函数测试。
 *
 * 本环境是 Linux，**不能真实运行 PowerShell / taskkill / Windows 服务**。
 * 因此这里只覆盖"任何平台都能验证"的部分：
 *
 * - PowerShell 脚本本身必须包含的要素（UTF-8 输出、CIM 字段、compressed JSON）
 * - 进程表 JSON / `CreationDate` 的解析（含 PowerShell 各种序列化形态）
 * - 命令行识别（反斜杠、引号、`.exe/.cmd/.bat`，且不误杀相似名字）
 * - `cmd.exe /d /s /c` 与 `taskkill /PID /T /F` 的组装
 * - Windows DNS 输出的解析与失败回落
 *
 * 真正的 Windows 集成行为（PowerShell 在中文代码页下的实际输出、taskkill 退出码、
 * 服务包装器）需要在 Windows CI 或用户机器上验证——这里不假装已经实测。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  WINDOWS_PROCESS_TABLE_SCRIPT,
  afterCodexExecutable,
  classifyDaemonStopFailure,
  findCodexClients,
  isCodexClientCommand,
  parseWindowsCreationDate,
  parseWindowsProcessTable,
  resolveCodexInvocation,
  windowsTaskkillInvocation,
} from '../src/agents/processes';
import {
  WINDOWS_DNS_SCRIPT,
  parseResolvConf,
  parseWindowsDnsServerOutput,
  resolveSystemDnsServer,
} from '../src/networking/easytier/udpStack';
import { getWarnings, resetWarnings } from '../src/resilience';

afterEach(() => {
  resetWarnings();
});

/** 2026-01-01T00:00:10.000Z；所有 CreationDate 用例都以它为基准 */
const NOW = Date.parse('2026-01-01T00:00:10.000Z');
const TEN_SECONDS_AGO = '2026-01-01T00:00:00.000Z';
const TEN_SECONDS_AGO_MS = 1767225600000;

describe('Windows 进程表探测脚本', () => {
  it('用 CIM 取 pid/CreationDate/CommandLine，并强制 UTF-8 + compressed JSON', () => {
    // 缺 [Console]::OutputEncoding 时中文/非 ASCII 命令行会被按 GBK 输出，
    // Node 按 UTF-8 解码成乱码，isCodexClientCommand 匹配不上。
    // 缺 -Compress 时 ConvertTo-Json 会跨行，解析需要额外处理（这里刻意只认单行）。
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toContain('Get-CimInstance Win32_Process');
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toContain('ProcessId');
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toContain('CreationDate');
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toContain('CommandLine');
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toContain('[Console]::OutputEncoding');
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toContain('UTF8');
    expect(WINDOWS_PROCESS_TABLE_SCRIPT).toContain('ConvertTo-Json -Compress');
  });
});

describe('Windows 进程表解析', () => {
  it('解析 JSON 数组并计算已运行秒数', () => {
    const table = JSON.stringify([
      { ProcessId: 111, CreationDate: TEN_SECONDS_AGO, CommandLine: 'codex.exe exec hi' },
      { ProcessId: 222, CreationDate: TEN_SECONDS_AGO, CommandLine: 'C:\\Windows\\explorer.exe' },
    ]);
    expect(parseWindowsProcessTable(table, NOW)).toEqual([
      { pid: 111, elapsedSeconds: 10, command: 'codex.exe exec hi' },
      { pid: 222, elapsedSeconds: 10, command: 'C:\\Windows\\explorer.exe' },
    ]);
  });

  it('只有一条记录时 ConvertTo-Json 输出对象，也要接受', () => {
    const table = JSON.stringify({
      ProcessId: 333,
      CreationDate: TEN_SECONDS_AGO,
      CommandLine: 'codex.exe',
    });
    expect(parseWindowsProcessTable(table, NOW)).toEqual([
      { pid: 333, elapsedSeconds: 10, command: 'codex.exe' },
    ]);
  });

  it('兼容 /Date(ms)/ 与 7 位小数秒 + 时区的 ISO 时间', () => {
    // PowerShell 5.1 的 ConvertTo-Json 序列化 DateTime 的实际形态随版本而变。
    expect(parseWindowsCreationDate(`/Date(${TEN_SECONDS_AGO_MS})/`)).toBe(TEN_SECONDS_AGO_MS);
    const fractional = '2026-01-01T08:00:00.1234567+08:00';
    expect(parseWindowsCreationDate(fractional)).toBe(TEN_SECONDS_AGO_MS + 123);
    // 秒级时间戳也要认（有些 CIM 包装脚本会直接给秒）
    expect(parseWindowsCreationDate('1767225600')).toBe(TEN_SECONDS_AGO_MS);
    expect(parseWindowsCreationDate(1767225600)).toBe(TEN_SECONDS_AGO_MS);
  });

  it('无法解析 CreationDate 时 elapsedSeconds 记 0，而不是编造时间', () => {
    const table = JSON.stringify([
      { ProcessId: 444, CreationDate: 'not-a-date', CommandLine: 'codex.exe' },
      { ProcessId: 555, CommandLine: 'codex.exe' },
    ]);
    const parsed = parseWindowsProcessTable(table, NOW);
    expect(parsed.map((item) => item.elapsedSeconds)).toEqual([0, 0]);
  });

  it('跳过没有 CommandLine 的系统进程与非法 pid', () => {
    const table = JSON.stringify([
      { ProcessId: 0, CreationDate: TEN_SECONDS_AGO, CommandLine: 'System Idle Process' },
      { ProcessId: 666, CreationDate: TEN_SECONDS_AGO, CommandLine: null },
      { ProcessId: 'not-a-pid', CreationDate: TEN_SECONDS_AGO, CommandLine: 'codex.exe' },
      { ProcessId: 777, CreationDate: TEN_SECONDS_AGO, CommandLine: 'codex.exe' },
    ]);
    expect(parseWindowsProcessTable(table, NOW)).toEqual([
      { pid: 777, elapsedSeconds: 10, command: 'codex.exe' },
    ]);
  });

  it('空输出/损坏 JSON 返回空数组（调用方按"探测失败"处理）', () => {
    expect(parseWindowsProcessTable('', NOW)).toEqual([]);
    expect(parseWindowsProcessTable('{ not json', NOW)).toEqual([]);
  });

  it('findCodexClients 在 Windows 进程表里只挑出真正的 codex 客户端', () => {
    const table = JSON.stringify([
      { ProcessId: 101, CreationDate: TEN_SECONDS_AGO, CommandLine: 'codex.exe exec hi' },
      { ProcessId: 102, CreationDate: TEN_SECONDS_AGO, CommandLine: 'C:\\Windows\\explorer.exe' },
      { ProcessId: 103, CreationDate: TEN_SECONDS_AGO, CommandLine: 'codex.exe app-server' },
      { ProcessId: 104, CreationDate: TEN_SECONDS_AGO, CommandLine: 'C:\\tools\\mycodex.exe' },
    ]);
    const found = findCodexClients({ platform: 'win32', table, now: NOW });
    expect(found.map((item) => item.pid)).toEqual([101]);
  });

  it.skipIf(process.platform === 'win32')(
    '进程表探测失败时返回空并产生告警，而不是静默当成"没有进程"',
    () => {
      // Linux 上强制走 Windows 分支：powershell.exe 不存在 → 探测失败。
      // 这条用例同时固定住"告警键必须存在于 i18n 字典"（缺键时 renderZh 会抛错）。
      expect(findCodexClients({ platform: 'win32' })).toEqual([]);
      const warning = getWarnings().find(
        (item) => item.code === 'agents_process_table_unavailable',
      );
      expect(warning?.messageKey).toBe('agents.process.tableUnavailable');
    },
  );
});

describe('Windows 命令行识别', () => {
  it('识别 .exe / .cmd / .bat、反斜杠路径与带引号的绝对路径', () => {
    expect(isCodexClientCommand('codex.exe')).toBe(true);
    expect(isCodexClientCommand('codex.cmd')).toBe(true);
    expect(isCodexClientCommand('codex.bat exec "hi"')).toBe(true);
    expect(isCodexClientCommand('C:\\tools\\codex.exe exec hi')).toBe(true);
    expect(isCodexClientCommand('"C:\\Program Files\\Codex\\codex.exe"')).toBe(true);
    expect(
      isCodexClientCommand('"C:\\Program Files\\Codex\\codex.exe" exec "hello world"'),
    ).toBe(true);
    // 注意：路径含空格时 Windows 启动进程**必然**加引号（CreateProcess 的要求），
    // 所以这里不处理"未加引号的含空格路径"——那种命令行本身就无法被正确解析。
    // Windows 文件名不区分大小写
    expect(isCodexClientCommand('CODEX.EXE')).toBe(true);
  });

  it('保留 afterCodexExecutable 的"可执行文件之后"语义', () => {
    expect(afterCodexExecutable('"C:\\Program Files\\Codex\\codex.exe" exec hi')).toBe(
      ' exec hi',
    );
    expect(afterCodexExecutable('codex.exe')).toBe('');
    expect(afterCodexExecutable('')).toBeNull();
  });

  it('不碰 app-server / 一次性命令（Windows 形态）', () => {
    expect(isCodexClientCommand('codex.exe app-server daemon stop')).toBe(false);
    expect(isCodexClientCommand('C:\\tools\\codex.cmd --version')).toBe(false);
    expect(isCodexClientCommand('codex.bat login')).toBe(false);
  });

  it('不误杀把 codex 当参数或相似名字的进程', () => {
    expect(isCodexClientCommand('C:\\tools\\mycodex.exe')).toBe(false);
    expect(isCodexClientCommand('C:\\tools\\codex-helper.exe exec')).toBe(false);
    expect(isCodexClientCommand('C:\\tools\\codex.cmd.bak')).toBe(false);
    expect(isCodexClientCommand('node.exe C:\\tools\\codex.exe')).toBe(false);
    expect(isCodexClientCommand('vim C:\\notes\\codex')).toBe(false);
    // cmd.exe 包装进程本身不是 codex 客户端；它启动的 codex 子进程会作为独立行出现，
    // 而 taskkill /T 负责连同子进程树一起结束。
    expect(isCodexClientCommand('C:\\Windows\\System32\\cmd.exe /d /s /c codex')).toBe(false);
  });
});

describe('Windows 进程结束与 codex 调用', () => {
  it('结束进程用 taskkill /PID <pid> /T /F', () => {
    expect(windowsTaskkillInvocation(4321)).toEqual({
      file: 'taskkill',
      args: ['/PID', '4321', '/T', '/F'],
    });
  });

  it('Windows 上通过 cmd.exe /d /s /c 调用 codex', () => {
    expect(resolveCodexInvocation(undefined, ['app-server', 'daemon', 'stop'], 'win32')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '"codex app-server daemon stop"'],
      windowsVerbatimArguments: true,
    });
  });

  it('CODEX_BIN 含空格时保留内层引号（cmd /s 只剥最外层）', () => {
    expect(
      resolveCodexInvocation('C:\\Program Files\\Codex\\codex.cmd', ['app-server'], 'win32'),
    ).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\Codex\\codex.cmd" app-server"'],
      windowsVerbatimArguments: true,
    });
  });

  it('daemon stop 失败原因同时识别 POSIX 与 Windows 文案', () => {
    // Windows cmd.exe 的"找不到命令"文案与 POSIX 完全不同：
    // 只认 ENOENT 会让 Windows 用户看到泛泛的"停止守护进程失败"。
    expect(
      classifyDaemonStopFailure(
        "'codex' is not recognized as an internal or external command, operable program or batch file.",
      ),
    ).toBe('commandMissing');
    expect(
      classifyDaemonStopFailure('The system cannot find the path specified.'),
    ).toBe('commandMissing');
    expect(classifyDaemonStopFailure('spawn codex ENOENT')).toBe('commandMissing');
    expect(classifyDaemonStopFailure('Error: daemon is not running')).toBe('notRunning');
    expect(classifyDaemonStopFailure('unexpected exit code 7')).toBe('failed');
  });

  it('POSIX 上直接 exec codex，CODEX_BIN 缺省回落 `codex`', () => {
    expect(resolveCodexInvocation(undefined, ['--version'], 'linux')).toEqual({
      file: 'codex',
      args: ['--version'],
    });
    expect(resolveCodexInvocation('  ', ['--version'], 'linux')).toEqual({
      file: 'codex',
      args: ['--version'],
    });
    expect(resolveCodexInvocation('/usr/local/bin/codex', ['--version'], 'darwin')).toEqual({
      file: '/usr/local/bin/codex',
      args: ['--version'],
    });
  });
});

describe('Windows DNS 探测', () => {
  it('用 Get-DnsClientServerAddress 并强制 UTF-8 + compressed JSON', () => {
    expect(WINDOWS_DNS_SCRIPT).toContain('Get-DnsClientServerAddress');
    expect(WINDOWS_DNS_SCRIPT).toContain('ConvertTo-Json -Compress');
    expect(WINDOWS_DNS_SCRIPT).toContain('[Console]::OutputEncoding');
  });

  it('解析数组、单字符串、对象包装与纯文本输出', () => {
    expect(parseWindowsDnsServerOutput('["10.20.30.40","8.8.8.8"]')).toBe('10.20.30.40');
    expect(parseWindowsDnsServerOutput('"10.20.30.40"')).toBe('10.20.30.40');
    expect(
      parseWindowsDnsServerOutput(JSON.stringify({ ServerAddresses: ['10.20.30.40'] })),
    ).toBe('10.20.30.40');
    expect(parseWindowsDnsServerOutput('10.20.30.40\r\n')).toBe('10.20.30.40');
  });

  it('跳过 IPv6 与非法地址，取下一个可用的 IPv4', () => {
    // UDP 转发是 udp4：把 IPv6 地址当目标只会让 DNS 静默失败，所以宁可跳过。
    expect(parseWindowsDnsServerOutput('["fe80::1%12","10.0.0.2"]')).toBe('10.0.0.2');
    expect(parseWindowsDnsServerOutput('["999.1.1.1"]')).toBeNull();
    expect(parseWindowsDnsServerOutput('[]')).toBeNull();
    expect(parseWindowsDnsServerOutput('')).toBeNull();
    expect(parseWindowsDnsServerOutput('  ')).toBeNull();
  });

  it('解析 /etc/resolv.conf 的第一个 nameserver，去掉 IPv6 scope', () => {
    expect(parseResolvConf('# generated\nnameserver 10.0.0.53\nnameserver 8.8.8.8\n')).toBe(
      '10.0.0.53',
    );
    expect(parseResolvConf('nameserver fe80::1%eth0\n')).toBe('fe80::1');
    expect(parseResolvConf('')).toBeNull();
    expect(parseResolvConf('# no nameserver here\n')).toBeNull();
  });

  it('win32 走 PowerShell，失败或无结果都回落 127.0.0.1', () => {
    expect(
      resolveSystemDnsServer({ platform: 'win32', exec: () => '["192.168.1.1"]' }),
    ).toBe('192.168.1.1');
    expect(
      resolveSystemDnsServer({
        platform: 'win32',
        exec: () => {
          throw new Error('powershell.exe not found');
        },
      }),
    ).toBe('127.0.0.1');
    expect(resolveSystemDnsServer({ platform: 'win32', exec: () => '[]' })).toBe('127.0.0.1');
  });

  it('非 Windows 读 resolv.conf，失败回落 127.0.0.1', () => {
    expect(
      resolveSystemDnsServer({
        platform: 'linux',
        readResolvConf: () => 'nameserver 127.0.0.53\n',
      }),
    ).toBe('127.0.0.53');
    expect(
      resolveSystemDnsServer({
        platform: 'linux',
        readResolvConf: () => {
          throw new Error('EACCES');
        },
      }),
    ).toBe('127.0.0.1');
    expect(
      resolveSystemDnsServer({ platform: 'linux', readResolvConf: () => '# nothing\n' }),
    ).toBe('127.0.0.1');
  });
});
