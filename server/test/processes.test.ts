import { describe, expect, it } from 'vitest';
import { isCodexClientCommand, afterCodexExecutable, parseElapsedSeconds } from '../server/src/agents/processes';

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
});
