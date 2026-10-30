import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UiLanguage } from '../domain/settings';
import { translate } from '../i18n';
import { addWarning } from '../resilience';

/**
 * 结束本机正在运行的 Agent 客户端进程。
 *
 * 为什么需要它：Codex CLI 只在**启动时**读一次配置与模型目录。改完配置后如果不重启，
 * 用户会在 `/model` 里看到旧模型列表，看起来像"配置没生效"。参考实现（cc-switch）
 * 也是先 `codex app-server daemon restart` 再让用户重开 TUI。
 *
 * 实现上分三层，彼此不替代——少任何一层都有明确的故障形态：
 *
 * 1. **官方入口**：`codex app-server daemon stop` 让 TUI 连的那个托管 daemon 退出。
 *    这是官方入口，比自己 pkill 安全，它会自己处理停机宽限期与锁文件。
 *    但它要写 `~/.codex`，目录只读或 daemon 状态异常时会失败。
 * 2. **pid 文件兜底**：读 `app-server-daemon/*.pid` 里 daemon 自己写的 pid 精确结束。
 *    第 1 层失败后 daemon 仍在跑，用户会看到"点了退出进程但 Codex 还能用"。
 * 3. **TUI 进程**：`codex`（无子命令）进程本身。它没有官方退出入口，只能按进程表
 *    精确匹配后发信号。匹配规则刻意保守，见 isCodexClientCommand。
 */

export interface AgentProcess {
  pid: number;
  /** 进程已运行秒数 */
  elapsedSeconds: number;
  command: string;
}

export interface StopProcessesResult {
  /** 尝试过停止的方式，用于给用户看 */
  actions: string[];
  /** 实际被结束的进程 */
  killed: AgentProcess[];
  /** 结束前探测到的进程（用于"本来就没在跑"的提示） */
  found: AgentProcess[];
  /** 命令失败时的说明，不影响整体成功语义 */
  warnings: string[];
}

/**
 * Windows 进程表探测脚本。
 *
 * 为什么用 `Get-CimInstance Win32_Process` 而不是 `tasklist`：`tasklist` 不输出命令行，
 * 而命令行是识别 Codex 客户端的唯一依据（argv[0] 必须是 codex）。CIM 的
 * `ProcessId/CreationDate/CommandLine` 三者正好对应 POSIX `ps` 的 pid/etime/command。
 *
 * `[Console]::OutputEncoding = UTF8` 必须显式设置：Windows PowerShell 5.1 在中文
 * 代码页（936）下会把命令行里的非 ASCII 字符编码成 GBK，Node 按 UTF-8 解码会得到乱码，
 * 匹配就失效了。`-Compress` 让输出是一行 JSON，避免意外换行。
 */
export const WINDOWS_PROCESS_TABLE_SCRIPT =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ' +
  'Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress';

/** 读取整张进程表；失败返回 null（调用方据此说明"无法探测"）。 */
function readProcessTable(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'win32') {
      return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_TABLE_SCRIPT],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    }
    // -ww：输出不是终端时，Linux 的 procps 默认会截断命令行。
    return execFileSync('ps', ['-ww', '-Ao', 'pid=,etime=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // 探测失败不能静默当成"没有进程"：用户会以为点「退出进程」真的没东西可停。
    // 与存储损坏一样，把原因放进启动告警（code 去重，不会刷屏）。
    if (platform === 'win32') {
      addWarning('agents_process_table_unavailable', 'agents.process.tableUnavailable');
    }
    return null;
  }
}

/** `etime` 形如 `12:34`、`1-02:03:04`、`5` —— 统一换算成秒。 */
export function parseElapsedSeconds(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  const daysSplit = trimmed.split('-');
  const days = daysSplit.length > 1 ? Number(daysSplit[0]) : 0;
  const clock = daysSplit.length > 1 ? daysSplit[1] : daysSplit[0];
  const parts = clock.split(':').map((item) => Number(item));
  if (parts.some((item) => !Number.isFinite(item))) return 0;
  const [h, m, s] = parts.length === 3 ? parts : [0, ...pad(parts)];
  return days * 86_400 + h * 3_600 + m * 60 + s;
}

function pad(parts: number[]): [number, number] {
  return parts.length === 2 ? [parts[0], parts[1]] : [0, parts[0] ?? 0];
}

/**
 * Codex 可执行文件在 Windows 上的可能名字。
 *
 * npm 安装的 `codex` 在 Windows 上是 `codex.cmd`（包一层 node）；用安装器/解压版
 * 则可能是 `codex.exe`。`.bat` 是用户自建包装脚本的常见后缀。这里**只认这几个
 * 精确名字**，不做前缀/包含匹配——`codex-helper.exe`、`mycodex.exe` 都是别的程序。
 */
const WINDOWS_CODEX_EXECUTABLES = new Set(['codex', 'codex.exe', 'codex.cmd', 'codex.bat']);

/**
 * 取 argv[0]：按空白切分，但尊重双引号/单引号（Windows 路径常含空格，
 * 例如 `"C:\Program Files\Codex\codex.exe"`）。
 */
function splitArgv0(command: string): { token: string; rest: string } | null {
  let index = 0;
  while (index < command.length && /\s/.test(command[index])) index += 1;
  if (index >= command.length) return null;

  let token: string;
  const quote = command[index];
  if (quote === '"' || quote === "'") {
    index += 1;
    const start = index;
    while (index < command.length && command[index] !== quote) index += 1;
    token = command.slice(start, index);
    // 跳过收尾引号；没有也继续（截断的命令行不该让整个探测崩掉）
    if (index < command.length) index += 1;
  } else {
    const start = index;
    while (index < command.length && !/\s/.test(command[index])) index += 1;
    token = command.slice(start, index);
  }
  return { token, rest: command.slice(index) };
}

/** 取路径最后一段并按 Windows 语义不区分大小写比较。同时兼容 `/` 与 `\`。 */
function executableBaseName(token: string): string {
  const unquoted = token.replace(/^["']|["']$/g, '');
  const base = unquoted.split(/[\\/]/).pop() ?? unquoted;
  return base.toLowerCase();
}

function isCodexExecutable(token: string): boolean {
  return WINDOWS_CODEX_EXECUTABLES.has(executableBaseName(token));
}

/**
 * 若这条命令**确实在运行 codex 可执行文件**，返回可执行文件之后的部分，否则 null。
 *
 * 两条约束缺一不可：
 *
 * 1. argv[0] 的 basename 必须是 codex（`codex` / `codex.exe` / `codex.cmd` / `codex.bat`），
 *    或紧跟 `exec -a codex` 这种 wrapper —— 排除 `mycodex`、`codex-foo`。
 * 2. **`codex` 必须是命令行的第一个词**（除了 `exec -a` 这种显式替换 argv[0] 的包装）。
 *
 * 第 2 条是踩过的坑：只校验字符边界时，`vim /home/notes/codex`、`tail -f /var/log/codex`、
 * `git -C /srv/codex status` 全都会被判成"codex 客户端"并被 SIGTERM —— 用户的编辑器和
 * 日志进程会被无端杀掉。进程表里 `codex` 作为参数出现的频率远高于作为可执行文件出现。
 *
 * Windows 形态（反斜杠、引号、`.exe/.cmd/.bat`）必须一视同仁：`Get-CimInstance` 返回的
 * CommandLine 就是用户启动时的原始命令行，带引号的绝对路径是最常见的形式。
 */
export function afterCodexExecutable(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === '') return null;

  // 情形 A：argv[0] 就是 codex（含 `/usr/local/bin/codex`、`C:\...\codex.exe`、
  // `"C:\Program Files\Codex\codex.exe"` 这类绝对路径与带引号写法）
  const argv0 = splitArgv0(trimmed);
  if (argv0 !== null && isCodexExecutable(argv0.token)) return argv0.rest;

  // 情形 B：`exec -a codex ...` / `bash -c 'exec -a codex ...'` 这类显式替换 argv[0] 的包装
  const wrapped = /\bexec\s+-a\s+codex\s+/;
  const match = wrapped.exec(trimmed);
  if (match) return trimmed.slice(match.index + match[0].length - 1);

  return null;
}

/**
 * 判断一条命令行是不是"该被结束的 Codex 客户端"。
 *
 * 只结束 **TUI / exec 这类会自己缓存模型的进程**；`app-server daemon` 由官方命令处理，
 * `--version`、`login` 等一次性命令跑完就退，不该动。
 */
export function isCodexClientCommand(command: string): boolean {
  const rest = afterCodexExecutable(command);
  if (rest === null) return false;
  // rest 以空格开头（`codex exec …` 的可执行文件后就是空格），
  // 直接 split 会得到前导空串，必须先 trim 再过滤。
  const words = rest.trim().split(/\s+/).filter((item) => item !== '');
  // 跳过 `-c key=value` / `--config=...` 之类的全局选项，找真正子命令
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === '-c' || word === '--config') {
      index += 2;
      continue;
    }
    if (word.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  // 有选项但没子命令时（`codex --version`、`codex --help`）是一次性命令，
  // 不能当成 TUI——否则会把用户查版本的进程杀掉。
  if (words.length > 0 && index >= words.length) return false;
  const subcommand = words[index];
  // 完全没有参数 = 交互式 TUI
  if (subcommand === undefined) return true;

  /**
   * 明确"不是长驻客户端"的子命令。除此之外一律当作客户端处理。
   *
   * 这里刻意用白名单排除法而不是"只认 exec/TUI"：未知形态的命令行说明我们的预期
   * 已经过时（子命令会随版本增删），此时按客户端处理更安全。取舍的依据是两种错的
   * 代价不对称——漏杀的表现是"用户以为重启了其实没有"，配置看着对却不生效，
   * 极难排查；误杀一个瞬时命令只是白杀一次，用户重跑即可。
   */
  const NON_CLIENT_SUBCOMMANDS = new Set([
    'app-server',
    'login',
    'logout',
    'update',
    'mcp',
    'debug',
    'completion',
    'help',
    'version',
    'apply',
    'resume',
  ]);
  if (NON_CLIENT_SUBCOMMANDS.has(subcommand)) return false;
  // `--version` / `--help` 这类以 - 开头的已被上面的选项跳过逻辑处理，
  // 走到这里的都是普通子命令：exec 与 TUI 都算客户端。
  return true;
}

/**
 * 结束 Codex 的托管 daemon 与它的 updater。
 *
 * 为什么不只靠 `codex app-server daemon stop`：那条命令要写 `~/.codex`（锁文件、
 * pid 文件）。目录只读、或 daemon 状态异常时它会失败，而失败之后 daemon 仍在跑——
 * 用户点"退出进程"却看到 Codex 依然可用，只能手动 `pkill -9 -f codex`。
 *
 * 所以这里读 `app-server-daemon/*.pid` 里记录的 pid 作为兜底：
 * 那些文件是 daemon 自己写的，比按命令行猜更准（daemon 的参数形态会随版本变）。
 */
function stopManagedDaemonProcesses(
  codexHome: string,
  language: UiLanguage,
  platform: NodeJS.Platform,
): { killed: number; warnings: string[] } {
  const warnings: string[] = [];
  let killed = 0;
  const pidFiles = ['daemon.pid', 'daemon-updater.pid'];

  for (const name of pidFiles) {
    const file = path.join(codexHome, 'app-server-daemon', name);
    let pid: number;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
      if (typeof record.pid !== 'number') continue;
      pid = record.pid;
    } catch {
      // 文件不存在或格式变了：交给 daemon stop 那条路，不算错误
      continue;
    }
    try {
      if (terminateProcess(pid, platform) === 'killed') killed += 1;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      warnings.push(
        translate(language, 'agents.process.pidKillFailed', { file: name, pid, detail }),
      );
    }
  }
  return { killed, warnings };
}

function parseProcessTable(table: string): AgentProcess[] {
  const result: AgentProcess[] = [];
  for (const line of table.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const firstSpace = trimmed.search(/\s/);
    if (firstSpace === -1) continue;
    const pid = Number(trimmed.slice(0, firstSpace));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const remainder = trimmed.slice(firstSpace).trim();
    const secondSpace = remainder.search(/\s/);
    if (secondSpace === -1) continue;
    const elapsed = remainder.slice(0, secondSpace);
    const command = remainder.slice(secondSpace).trim();
    if (command === '') continue;
    result.push({ pid, elapsedSeconds: parseElapsedSeconds(elapsed), command });
  }
  return result;
}

/** 数字字符串（含毫秒/秒两种量级）或纯数字转 epoch 毫秒；不合理返回 null。 */
function epochMsFromNumber(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  // 秒级时间戳（10 位）与毫秒级（13 位）都出现过：小于 1e12 的按秒处理
  return value < 1e12 ? value * 1000 : value;
}

/**
 * 解析 PowerShell `ConvertTo-Json` 序列化出来的 `CreationDate`。
 *
 * 实际形态随 PowerShell 版本/序列化器而变，三种都要认：
 * - ISO 8601 字符串：`2026-01-01T08:00:00.1234567+08:00`（PS 5.1 常见，小数位可能超过 3 位）
 * - 微软旧式 `/Date(1767225600000)/`
 * - 纯数字（秒或毫秒）
 *
 * 全都解析不了时返回 null：调用方把 elapsedSeconds 记为 0，而不是编一个时间。
 */
export function parseWindowsCreationDate(value: unknown): number | null {
  if (typeof value === 'number') return epochMsFromNumber(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const msDate = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(trimmed);
  if (msDate !== null) return epochMsFromNumber(Number(msDate[1]));

  if (/^-?\d+$/.test(trimmed)) return epochMsFromNumber(Number(trimmed));

  // Date.parse 对超过 3 位的小数秒不保证接受（V8 只稳定支持毫秒），先截断
  const normalized = trimmed.replace(/\.(\d{3})\d+/, '.$1');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 解析 Windows 进程表（`WINDOWS_PROCESS_TABLE_SCRIPT` 的 stdout）。
 *
 * `ConvertTo-Json` 在只有一条记录时输出**对象**而不是数组，两种都要接受。
 * 系统进程（Session 0）的 CommandLine 为 null，跳过——没有命令行就无法判断是不是 Codex。
 */
export function parseWindowsProcessTable(table: string, now = Date.now()): AgentProcess[] {
  const trimmed = table.trim();
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: AgentProcess[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const pidValue = record.ProcessId ?? record.processId ?? record.pid;
    const pid = typeof pidValue === 'string' ? Number(pidValue) : pidValue;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;

    const commandValue = record.CommandLine ?? record.commandLine ?? record.command;
    if (typeof commandValue !== 'string' || commandValue.trim() === '') continue;

    const createdAt = parseWindowsCreationDate(
      record.CreationDate ?? record.creationDate ?? record.createdAt,
    );
    const elapsedSeconds =
      createdAt === null ? 0 : Math.max(0, Math.floor((now - createdAt) / 1000));
    result.push({ pid, elapsedSeconds, command: commandValue.trim() });
  }
  return result;
}

export interface FindCodexClientsOptions {
  /** 测试/跨平台诊断用；默认 `process.platform` */
  platform?: NodeJS.Platform;
  /** 直接注入进程表内容，跳过真实探测（测试用） */
  table?: string | null;
  /** 与 `CreationDate` 比较的当前时间；默认 `Date.now()` */
  now?: number;
}

/** 找出所有该结束的 Codex 客户端进程。 */
export function findCodexClients(options: FindCodexClientsOptions = {}): AgentProcess[] {
  const platform = options.platform ?? process.platform;
  const table = options.table === undefined ? readProcessTable(platform) : options.table;
  if (table === null) return [];

  const parsed =
    platform === 'win32' ? parseWindowsProcessTable(table, options.now) : parseProcessTable(table);
  return parsed.filter(
    (item) => item.pid !== process.pid && isCodexClientCommand(item.command),
  );
}

/** Codex 的配置目录：优先 CODEX_HOME，否则 `<home>/.codex`。 */
export function codexHomeDir(agentHomeDir: string | undefined): string {
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return path.join(agentHomeDir ?? os.homedir(), '.codex');
}

/**
 * 解析 Codex 可执行文件：显式参数（config.codexBin）> `CODEX_BIN` 环境变量 > PATH 里的 `codex`。
 *
 * Windows 安装器常把 `where codex` 的结果写进 CODEX_BIN：npm 的 shim 目录不一定在
 * 服务账号（LocalSystem）的 PATH 里，不显式指定就会报"找不到 codex"。
 */
function resolveCodexBin(explicit: string | undefined): string | undefined {
  const value = explicit ?? process.env.CODEX_BIN;
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface CodexInvocation {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** cmd.exe 参数引用：含空白/cmd 元字符时整体加引号，内部引号按 cmd 规则双写。 */
function quoteCmdArgument(value: string): string {
  if (value === '') return '""';
  if (!/[\s"&|<>^()]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * 决定怎么调用 codex CLI。
 *
 * POSIX 直接 execFile；Windows 必须经 `cmd.exe /d /s /c`，因为 npm 安装的是
 * `codex.cmd`（批处理 shim），execFile 不能直接执行 .cmd —— 会抛 ENOENT/EINVAL。
 * `/d` 跳过 AutoRun，`/s` 让最外层引号被剥掉、保留内部的路径引号（路径常含空格），
 * `windowsVerbatimArguments` 保证 Node 不再二次转义我们精心拼好的命令行。
 *
 * 这是纯函数：Linux 上也能断言 Windows 的组装结果。
 */
export function resolveCodexInvocation(
  codexBin: string | undefined,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): CodexInvocation {
  const bin = codexBin !== undefined && codexBin.trim() !== '' ? codexBin.trim() : 'codex';
  if (platform !== 'win32') return { file: bin, args };

  const commandLine = [bin, ...args].map(quoteCmdArgument).join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export interface WindowsTaskkillInvocation {
  file: 'taskkill';
  args: string[];
}

/**
 * Windows 结束进程的命令：`taskkill /PID <pid> /T /F`。
 *
 * `/T` 连子进程树一起结束（cmd shim 会先起一个 node 子进程）；`/F` 强制。
 * 纯函数导出是为了在 Linux 上也能固定住参数顺序。
 */
export function windowsTaskkillInvocation(pid: number): WindowsTaskkillInvocation {
  return { file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
}

function isAlreadyGone(detail: string, status?: number): boolean {
  if (status === 128) return true; // taskkill: 找不到该进程
  return /ESRCH|not found|no running instance|does not exist/i.test(detail);
}

/**
 * 结束一个进程；返回 'killed'，或 'gone' 表示它本来就已经退出。
 *
 * 已退出不算失败：用户点「退出进程」时目标可能刚好自己关了，报一条 warning 只会误导。
 */
function terminateProcess(pid: number, platform: NodeJS.Platform): 'killed' | 'gone' {
  if (platform === 'win32') {
    const invocation = windowsTaskkillInvocation(pid);
    try {
      execFileSync(invocation.file, invocation.args, {
        stdio: 'ignore',
        windowsHide: true,
      });
      return 'killed';
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const status = (cause as { status?: number }).status;
      if (isAlreadyGone(detail, status)) return 'gone';
      throw new Error(detail);
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
    return 'killed';
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (isAlreadyGone(detail)) return 'gone';
    throw cause;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
  windowsVerbatimArguments = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        env,
        encoding: 'utf8',
        windowsHide: true,
        windowsVerbatimArguments,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stdout ?? ''}${stderr ?? ''}`.trim();
          reject(new Error(detail === '' ? error.message : detail));
          return;
        }
        resolve(`${stdout ?? ''}${stderr ?? ''}`);
      },
    );
  });
}

async function runCodexCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  codexBin: string | undefined,
  platform: NodeJS.Platform,
): Promise<string> {
  const invocation = resolveCodexInvocation(codexBin, args, platform);
  return runCommand(
    invocation.file,
    invocation.args,
    env,
    timeoutMs,
    invocation.windowsVerbatimArguments,
  );
}

/**
 * 停止 Codex 守护进程 + 所有 TUI 客户端。
 *
 * 顺序很重要：先停 daemon（官方命令 + pid 兜底），再停 TUI 进程。
 * 反过来的话 TUI 可能在 daemon 关闭过程中自动重连，刚杀完又连上。
 *
 * 每一步失败都只记 warning、不中断后续步骤：用户点的是"把能停的停掉"，
 * 半途抛错会让已经停掉的 daemon 与还在跑的 TUI 处于更混乱的状态。
 */
export type DaemonStopFailureKind = 'commandMissing' | 'notRunning' | 'failed';

/**
 * 把 `codex app-server daemon stop` 的失败原因归类（纯函数，Linux 上可测）。
 *
 * 必须同时认 POSIX 与 Windows 的文案：POSIX 是 `ENOENT`/`No such file`，
 * 而 Windows 经 cmd.exe 调用时是
 * `'codex' is not recognized as an internal or external command` 或
 * `The system cannot find the path specified`。只匹配前者会让 Windows 用户
 * 得到一句泛泛的"停止守护进程失败"，而真实原因只是路径没配对。
 */
export function classifyDaemonStopFailure(detail: string): DaemonStopFailureKind {
  if (/no such file|not found|ENOENT|not recognized|cannot find/i.test(detail)) {
    return 'commandMissing';
  }
  if (/not running|not started|no daemon|does not exist/i.test(detail)) return 'notRunning';
  return 'failed';
}

export interface StopCodexProcessesOptions {
  /**
   * Codex 可执行文件（来自 config.codexBin / `CODEX_BIN`）。
   * 缺省读同名环境变量，再缺省为 PATH 里的 `codex`。
   */
  codexBin?: string;
  /** 默认 `process.platform`；测试注入用 */
  platform?: NodeJS.Platform;
  /** Windows 进程表 CreationDate 比较基准；默认 `Date.now()`，测试注入用 */
  now?: number;
}

export async function stopCodexProcesses(
  agentHomeDir: string | undefined,
  // 语言由边界传入（routes/agents.ts 按请求语言解析）：这里的 actions/warnings
  // 会原样出现在接口响应里、由前端直接展示，属于"翻译发生在边界"的边界一侧。
  // 缺省中文：未传语言的调用方（脚本、测试）拿到的是稳定文案。
  language: UiLanguage = 'zh',
  // 可选第三参：保持向后兼容——服务层不传时仍按 CODEX_BIN/PATH 解析。
  options: StopCodexProcessesOptions = {},
): Promise<StopProcessesResult> {
  const platform = options.platform ?? process.platform;
  const codexBin = resolveCodexBin(options.codexBin);
  const actions: string[] = [];
  const warnings: string[] = [];
  const found = findCodexClients({ platform, now: options.now });

  // 1) 官方入口：停托管 daemon
  const codexHome = codexHomeDir(agentHomeDir);
  // 目录不存在时不要强行设 CODEX_HOME：codex 会对着不存在的路径报错，
  // 而实际上这里只是"本机还没有 Codex 配置"，不该当成失败。
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (fs.existsSync(codexHome)) env.CODEX_HOME = codexHome;
  try {
    // 5 秒足够：正常情况它立刻返回；目录只读时也立刻失败。
    // 原来的 20 秒会让整个"退出进程"操作卡住 20 秒，用户以为按钮没反应。
    await runCodexCommand(
      ['app-server', 'daemon', 'stop'],
      env,
      5_000,
      codexBin,
      platform,
    );
    actions.push(translate(language, 'agents.process.daemonStopped'));
  } catch (cause) {
    // 没有 daemon、或 codex 不在 PATH 都算常见情况，不当作错误。
    const detail = cause instanceof Error ? cause.message : String(cause);
    const kind = classifyDaemonStopFailure(detail);
    if (kind === 'commandMissing') {
      warnings.push(translate(language, 'agents.process.daemonCommandMissing'));
    } else if (kind === 'notRunning') {
      actions.push(translate(language, 'agents.process.daemonNotRunning'));
    } else {
      warnings.push(
        translate(language, 'agents.process.daemonStopFailed', {
          detail: detail.split('\n')[0] ?? detail,
        }),
      );
    }
  }

  // 2) 托管 daemon 的兜底：`daemon stop` 在只读目录等情况下会失败，
  //    失败后 daemon 仍活着，表现为"点了退出进程但 Codex 还能用"。
  //    这里按它自己写的 pid 文件精确结束，不依赖命令行形态。
  const daemonFallback = stopManagedDaemonProcesses(codexHome, language, platform);
  if (daemonFallback.killed > 0) {
    actions.push(
      translate(language, 'agents.process.daemonKilledByPid', {
        count: daemonFallback.killed,
      }),
    );
  }
  warnings.push(...daemonFallback.warnings);

  // 3) TUI / exec 进程
  const killed: AgentProcess[] = [];
  for (const item of found) {
    try {
      if (terminateProcess(item.pid, platform) === 'killed') killed.push(item);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      warnings.push(
        translate(language, 'agents.process.killFailed', { pid: item.pid, detail }),
      );
    }
  }
  if (killed.length > 0) {
    actions.push(
      translate(language, 'agents.process.clientsKilled', { count: killed.length }),
    );
    if (platform === 'win32') {
      // taskkill /T /F 已经是强制结束整棵进程树，没有 SIGTERM→SIGKILL 的升级空间。
      // 只留一点时间让系统回收句柄，然后确认一次结果。
      await new Promise((resolve) => setTimeout(resolve, 300));
    } else {
      // 先给 SIGTERM 一点时间，再对仍然活着的补 SIGKILL。
      // 300ms 太短：Codex 的 TUI 关闭时可能还在收尾（写 rollout、断连接），
      // 实测常常来不及退出，用户看到的是"点了退出但进程还在"。
      //
      // 三轮递增等待（800/1200/1600ms）而不是一次性长等：
      // - 每轮都重新探测，已经退出的立刻 break，正常情况 800ms 就结束；
      // - 只在还有活进程时才继续等并补 SIGKILL，避免把操作固定拖到 3.6 秒。
      for (const delay of [800, 1200, 1600]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const alive = killed.filter((item) => isProcessAlive(item.pid));
        if (alive.length === 0) break;
        for (const item of alive) {
          try {
            process.kill(item.pid, 'SIGKILL');
          } catch {
            // 已退出
          }
        }
      }
    }
    const stillAlive = killed.filter((item) => isProcessAlive(item.pid));
    if (stillAlive.length > 0) {
      warnings.push(
        translate(language, 'agents.process.stillAlive', {
          count: stillAlive.length,
          pids: stillAlive.map((item) => item.pid).join(', '),
        }),
      );
    } else {
      actions.push(translate(language, 'agents.process.allExited'));
    }
  }

  return { actions, killed, found, warnings };
}
