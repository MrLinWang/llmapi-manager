import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, logFilePath, type FileLogOptions } from '../src/logger';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-log-'));
  dirs.push(dir);
  return dir;
}

function options(dir: string, overrides: Partial<FileLogOptions> = {}): FileLogOptions {
  return { dir, maxBytes: 1024 * 1024, maxFiles: 3, ...overrides };
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

/** 日志同时写控制台，测试里静音，避免刷屏。 */
function silenceConsole(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

describe('运行日志落盘', () => {
  it('写入日志文件，格式含时间、级别与消息', () => {
    silenceConsole();
    const dir = tempDir();
    const logger = createLogger('info', { file: options(dir) });

    logger.info('服务已启动', { port: 8787 });
    logger.warn('上游不可用');
    logger.close?.();

    const content = read(logFilePath(options(dir)));
    expect(content).toContain('INFO 服务已启动');
    expect(content).toContain('"port":8787');
    expect(content).toContain('WARN 上游不可用');
    // 每行都带 ISO 时间戳
    expect(content.split('\n')[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]/);
  });

  it('低于阈值的级别不落盘', () => {
    silenceConsole();
    const dir = tempDir();
    const logger = createLogger('warn', { file: options(dir) });

    logger.debug('不该出现');
    logger.info('也不该出现');
    logger.error('要出现');
    logger.close?.();

    const content = read(logFilePath(options(dir)));
    expect(content).not.toContain('不该出现');
    expect(content).not.toContain('也不该出现');
    expect(content).toContain('ERROR 要出现');
  });

  it('落盘内容同样打码：API Key 与 Bearer 令牌不外泄', () => {
    silenceConsole();
    const dir = tempDir();
    const logger = createLogger('info', { file: options(dir) });

    logger.error('请求失败', {
      apiKey: 'sk-live-abcdefghijklmnop',
      message: 'Authorization: Bearer sk-secretvalue123456',
    });
    logger.close?.();

    const content = read(logFilePath(options(dir)));
    expect(content).toContain('[redacted]');
    expect(content).not.toContain('sk-live-abcdefghijklmnop');
    expect(content).not.toContain('sk-secretvalue123456');
  });

  it('Error 对象的堆栈也写进日志，便于排查', () => {
    silenceConsole();
    const dir = tempDir();
    const logger = createLogger('error', { file: options(dir) });

    logger.error('未处理异常', new Error('boom'));
    logger.close?.();

    const content = read(logFilePath(options(dir)));
    expect(content).toContain('Error: boom');
    expect(content).toContain('at ');
  });

  it('目录不存在时自动创建，文件权限 0600', () => {
    silenceConsole();
    const dir = path.join(tempDir(), 'nested', 'logs');
    const logger = createLogger('info', { file: options(dir) });

    logger.info('hello');
    logger.close?.();

    const filePath = logFilePath(options(dir));
    expect(fs.existsSync(filePath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('追加写而非覆盖：重启后保留旧内容', () => {
    silenceConsole();
    const dir = tempDir();

    const first = createLogger('info', { file: options(dir) });
    first.info('第一次运行');
    first.close?.();

    const second = createLogger('info', { file: options(dir) });
    second.info('第二次运行');
    second.close?.();

    const content = read(logFilePath(options(dir)));
    expect(content).toContain('第一次运行');
    expect(content).toContain('第二次运行');
  });

  it('超过大小阈值时滚动，并只保留 maxFiles 个历史文件', () => {
    silenceConsole();
    const dir = tempDir();
    // 阈值压到很小，保证每条都能触发滚动
    const opts = options(dir, { maxBytes: 120, maxFiles: 2 });
    const logger = createLogger('info', { file: opts });

    for (let index = 1; index <= 6; index += 1) {
      logger.info(`第 ${index} 条日志，需要足够长以触发滚动`.padEnd(80, '.'));
    }
    logger.close?.();

    const files = fs.readdirSync(dir).sort();
    // 当前文件 + 最多 maxFiles 个历史
    expect(files).toContain('app.log');
    expect(files).toContain('app.1.log');
    expect(files).toContain('app.2.log');
    expect(files).not.toContain('app.3.log');
    expect(files.length).toBeLessThanOrEqual(opts.maxFiles + 1);

    // 当前文件仍可读，且是最新一条
    expect(read(path.join(dir, 'app.log'))).toContain('第 6 条日志');
  });

  it('滚动后历史文件按序号保存，最新的在 app.1.log', () => {
    silenceConsole();
    const dir = tempDir();
    const opts = options(dir, { maxBytes: 100, maxFiles: 3 });
    const logger = createLogger('info', { file: opts });

    logger.info('AAA'.padEnd(80, '.'));
    logger.info('BBB'.padEnd(80, '.'));
    logger.info('CCC'.padEnd(80, '.'));
    logger.close?.();

    expect(read(path.join(dir, 'app.1.log'))).toContain('BBB');
    expect(read(path.join(dir, 'app.log'))).toContain('CCC');
  });

  it('不传 file 选项时只写控制台，不产生文件', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir();

    const logger = createLogger('info');
    logger.info('仅控制台');
    logger.close?.();

    expect(spy).toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('写文件失败不影响调用方（降级为控制台）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = tempDir();
    const logger = createLogger('error', { file: options(dir) });
    // 关闭后再写：句柄已释放，内部应静默失败
    logger.close?.();
    expect(() => logger.error('句柄已关闭仍可调用')).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});
