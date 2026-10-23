/**
 * Codex 进程识别与结束的测试。
 *
 * 这组测试的价值全在"不误杀"上：这是一段会向用户真实进程发信号的代码，
 * 判错的代价是**杀掉别人的编辑器或日志进程**，而这类事故不可撤销、也极难在现场归因。
 * 所以每条断言都对应一种曾被误判（或很容易被误判）的命令行形态。
 *
 * 注意：只有最后一条会真的 spawn/signal 进程（用 sleep 占位），其余都是纯函数分类。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isCodexClientCommand,
  afterCodexExecutable,
  parseElapsedSeconds,
  stopCodexProcesses,
} from '../server/src/agents/processes';

describe('Codex 进程识别', () => {
  it('识别交互式 TUI', () => {
    expect(isCodexClientCommand('codex')).toBe(true);
    // 可执行文件后有空格时必须 trim，否则前导空串会让后面的子命令判定失效
    expect(isCodexClientCommand('codex ')).toBe(true);
    // 未知选项形态按客户端处理：漏杀比误杀更难排查
    expect(isCodexClientCommand('codex --foo bar')).toBe(true);
    expect(isCodexClientCommand('/usr/local/bin/codex')).toBe(true);
  });
  it('识别 exec 子命令', () => {
    expect(isCodexClientCommand('codex exec "hi"')).toBe(true);
    expect(isCodexClientCommand('codex -c model=x exec hi')).toBe(true);
  });
  it('不碰 app-server / 一次性命令', () => {
    // app-server 由官方 `daemon stop` 处理，这里再杀一次会打断它的优雅停机；
    // --version / login 跑完自己就退，杀掉它们只会制造无谓的失败。
    expect(isCodexClientCommand('codex app-server')).toBe(false);
    expect(isCodexClientCommand('codex app-server daemon stop')).toBe(false);
    expect(isCodexClientCommand('codex --version')).toBe(false);
    expect(isCodexClientCommand('codex login')).toBe(false);
  });
  it('不误杀把 codex 当参数的无关进程', () => {
    // 实测过这几条曾被判成客户端并 SIGTERM：进程表里 codex 作为参数远比作为
    // 可执行文件常见，只校验字符边界不够，必须要求它是 argv[0]。
    expect(isCodexClientCommand('vim /home/notes/codex')).toBe(false);
    expect(isCodexClientCommand('git -C /srv/codex status')).toBe(false);
    expect(isCodexClientCommand('npm --prefix /opt/codex run build')).toBe(false);
    expect(isCodexClientCommand('tail -f /var/log/codex')).toBe(false);
    expect(isCodexClientCommand('node /x/codex')).toBe(false);
  });

  it('识别 exec -a 包装的真实 codex 进程', () => {
    expect(isCodexClientCommand('bash -c exec -a codex sleep 90')).toBe(true);
  });

  it('不误伤相似名字', () => {
    expect(isCodexClientCommand('mycodex')).toBe(false);
    expect(isCodexClientCommand('/opt/codex-foo/bar')).toBe(false);
    expect(afterCodexExecutable('mycodex')).toBeNull();
  });
  it('etime 解析', () => {
    expect(parseElapsedSeconds('05')).toBe(5);
    expect(parseElapsedSeconds('12:34')).toBe(754);
    expect(parseElapsedSeconds('1-02:03:04')).toBe(93784);
  });

  it('daemon stop 失败时按 pid 文件兜底结束守护进程', async () => {
    // 真实场景：~/.codex 只读时 `codex app-server daemon stop` 会立刻失败
    // （打不开 daemon.lock），daemon 却还活着。用户点"退出进程"后 Codex 依然可用，
    // 只能自己去 pkill —— 所以必须读 daemon 自己写的 pid 文件兜底。
    // 这条用例用两个 sleep 进程冒充 daemon 与 updater，验证的是"兜底真的发了信号"，
    // 而不是只产出了一句 action 文案。
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-'));
    const dir = path.join(home, '.codex', 'app-server-daemon');
    fs.mkdirSync(dir, { recursive: true });

    const spawnDetached = (): number => {
      const out = execFileSync('bash', ['-c', 'setsid sleep 60 >/dev/null 2>&1 & echo $!'], {
        encoding: 'utf8',
      });
      return Number(out.trim());
    };
    const daemonPid = spawnDetached();
    const updaterPid = spawnDetached();
    fs.writeFileSync(path.join(dir, 'daemon.pid'), JSON.stringify({ pid: daemonPid }));
    fs.writeFileSync(
      path.join(dir, 'daemon-updater.pid'),
      JSON.stringify({ pid: updaterPid }),
    );

    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(daemonPid)).toBe(true);

    const result = await stopCodexProcesses(home);
    // 不论 daemon stop 成败，pid 兜底都必须把它们结束掉
    expect(result.actions.join('')).toContain('按 pid 文件结束');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(daemonPid)).toBe(false);
    expect(alive(updaterPid)).toBe(false);

    fs.rmSync(home, { recursive: true, force: true });
  });
});
