import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UiLanguage } from '../domain/settings';
import { translate } from '../i18n';

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

const IS_WINDOWS = process.platform === 'win32';

/** 读取整张进程表；失败返回 null（调用方据此说明"无法探测"）。 */
function readProcessTable(): string | null {
  if (IS_WINDOWS) return null;
  try {
    // -ww：输出不是终端时，Linux 的 procps 默认会截断命令行。
    const output = execFileSyncSafe('ps', ['-ww', '-Ao', 'pid=,etime=,command=']);
    return output;
  } catch {
    return null;
  }
}

function execFileSyncSafe(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
 * 若这条命令**确实在运行 codex 可执行文件**，返回可执行文件之后的部分，否则 null。
 *
 * 两条约束缺一不可：
 *
 * 1. `codex` 前面只能是行首或 `/`，后面只能是空白或结束 —— 排除 `mycodex`、`codex-foo`。
 * 2. **`codex` 必须是命令行的第一个词**（或紧跟 `exec -a codex` 这种 wrapper）。
 *
 * 第 2 条是踩过的坑：只校验字符边界时，`vim /home/notes/codex`、`tail -f /var/log/codex`、
 * `git -C /srv/codex status` 全都会被判成"codex 客户端"并被 SIGTERM —— 用户的编辑器和
 * 日志进程会被无端杀掉。进程表里 `codex` 作为参数出现的频率远高于作为可执行文件出现。
 */
export function afterCodexExecutable(command: string): string | null {
  const trimmed = command.trim();
  const name = 'codex';

  // 情形 A：argv[0] 就是 codex（含 `/usr/local/bin/codex` 这种绝对路径）
  const firstSpace = trimmed.indexOf(' ');
  const argv0 = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const argv0Base = argv0.slice(argv0.lastIndexOf('/') + 1);
  if (argv0Base === name) return firstSpace === -1 ? '' : trimmed.slice(firstSpace);

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
      process.kill(pid, 'SIGTERM');
      killed += 1;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      // ESRCH = 已经退出了，说明结果已经达到
      if (!/ESRCH/.test(detail)) {
        warnings.push(
          translate(language, 'agents.process.pidKillFailed', { file: name, pid, detail }),
        );
      }
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

/** 找出所有该结束的 Codex 客户端进程。 */
export function findCodexClients(): AgentProcess[] {
  const table = readProcessTable();
  if (table === null) return [];
  return parseProcessTable(table).filter(
    (item) => item.pid !== process.pid && isCodexClientCommand(item.command),
  );
}

/** Codex 的配置目录：优先 CODEX_HOME，否则 `<home>/.codex`。 */
export function codexHomeDir(agentHomeDir: string | undefined): string {
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return path.join(agentHomeDir ?? os.homedir(), '.codex');
}

function runCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const detail = `${stdout ?? ''}${stderr ?? ''}`.trim();
        reject(new Error(detail === '' ? error.message : detail));
        return;
      }
      resolve(`${stdout ?? ''}${stderr ?? ''}`);
    });
  });
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
export async function stopCodexProcesses(
  agentHomeDir: string | undefined,
  // 语言由边界传入（routes/agents.ts 按请求语言解析）：这里的 actions/warnings
  // 会原样出现在接口响应里、由前端直接展示，属于"翻译发生在边界"的边界一侧。
  // 缺省中文：未传语言的调用方（脚本、测试）拿到的是稳定文案。
  language: UiLanguage = 'zh',
): Promise<StopProcessesResult> {
  const actions: string[] = [];
  const warnings: string[] = [];
  const found = findCodexClients();

  // 1) 官方入口：停托管 daemon
  const codexHome = codexHomeDir(agentHomeDir);
  // 目录不存在时不要强行设 CODEX_HOME：codex 会对着不存在的路径报错，
  // 而实际上这里只是"本机还没有 Codex 配置"，不该当成失败。
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (fs.existsSync(codexHome)) env.CODEX_HOME = codexHome;
  try {
    // 5 秒足够：正常情况它立刻返回；目录只读时也立刻失败。
    // 原来的 20 秒会让整个"退出进程"操作卡住 20 秒，用户以为按钮没反应。
    await runCommand('codex', ['app-server', 'daemon', 'stop'], env, 5_000);
    actions.push(translate(language, 'agents.process.daemonStopped'));
  } catch (cause) {
    // 没有 daemon、或 codex 不在 PATH 都算常见情况，不当作错误
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (/no such file|not found|ENOENT/i.test(detail)) {
      warnings.push(translate(language, 'agents.process.daemonCommandMissing'));
    } else if (/not running|not started|no daemon|does not exist/i.test(detail)) {
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
  const daemonFallback = stopManagedDaemonProcesses(codexHome, language);
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
      process.kill(item.pid, 'SIGTERM');
      killed.push(item);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      // ESRCH = 进程已自行退出，视为成功
      if (!/ESRCH/.test(detail)) {
        warnings.push(
          translate(language, 'agents.process.killFailed', { pid: item.pid, detail }),
        );
      }
    }
  }
  if (killed.length > 0) {
    actions.push(
      translate(language, 'agents.process.clientsKilled', { count: killed.length }),
    );
    // 先给 SIGTERM 一点时间，再对仍然活着的补 SIGKILL。
    // 300ms 太短：Codex 的 TUI 关闭时可能还在收尾（写 rollout、断连接），
    // 实测常常来不及退出，用户看到的是"点了退出但进程还在"。
    //
    // 三轮递增等待（800/1200/1600ms）而不是一次性长等：
    // - 每轮都重新探测，已经退出的立刻 break，正常情况 800ms 就结束；
    // - 只在还有活进程时才继续等并补 SIGKILL，避免把操作固定拖到 3.6 秒。
    for (const delay of [800, 1200, 1600]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const alive = killed.filter((item) => {
        try {
          process.kill(item.pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (alive.length === 0) break;
      for (const item of alive) {
        try {
          process.kill(item.pid, 'SIGKILL');
        } catch {
          // 已退出
        }
      }
    }
    const stillAlive = killed.filter((item) => {
      try {
        process.kill(item.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
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
