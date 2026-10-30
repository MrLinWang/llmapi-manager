import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonFile, renameWithRetry } from '../src/store/jsonFile';
import { createLogger } from '../src/logger';
import { getWarnings, resetWarnings } from '../src/resilience';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetWarnings();
});

function tempFile(name = 'data.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-json-'));
  dirs.push(dir);
  return path.join(dir, name);
}

describe('JSON 存储健壮性', () => {
  it('原子写：写入后文件是完整的新版本', () => {
    const file = createJsonFile<{ items: string[] }>({
      filePath: tempFile(),
      schemaVersion: 1,
      defaultValue: () => ({ items: [] }),
    });
    file.write({ items: ['a', 'b'] });
    expect(JSON.parse(fs.readFileSync(file.filePath, 'utf8'))).toEqual({
      schemaVersion: 1,
      data: { items: ['a', 'b'] },
    });
  });

  it('损坏文件被隔离，并以空数据启动并产生告警', () => {
    const filePath = tempFile();
    fs.writeFileSync(filePath, '{ not valid json');

    const file = createJsonFile<{ items: string[] }>({
      filePath,
      schemaVersion: 1,
      defaultValue: () => ({ items: [] }),
      logger: createLogger('error'),
    });

    expect(file.read()).toEqual({ items: [] });
    const siblings = fs.readdirSync(path.dirname(filePath));
    expect(siblings.some((name) => name.includes('.corrupt-'))).toBe(true);
    expect(getWarnings().some((item) => item.code === 'corrupt_file')).toBe(true);
  });

  it('未来版本的文件被隔离而不是静默覆盖', () => {
    const filePath = tempFile();
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 99, data: { items: ['future'] } }),
    );

    const file = createJsonFile<{ items: string[] }>({
      filePath,
      schemaVersion: 1,
      defaultValue: () => ({ items: [] }),
      logger: createLogger('error'),
    });

    expect(file.read()).toEqual({ items: [] });
    const siblings = fs.readdirSync(path.dirname(filePath));
    expect(siblings.some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('rename 遇到 EPERM/EBUSY/EACCES 时按 10/20/50ms 重试，最终成功', () => {
    // Windows 上杀毒软件/索引器会短暂持有目标文件句柄，rename 抛 EPERM。
    // 这是瞬时错误而非数据错误：不重试会表现为"偶发保存失败"，用户重试又好了。
    const delays: number[] = [];
    const codes = ['EPERM', 'EBUSY', 'EACCES'];
    let attempts = 0;
    renameWithRetry('a.tmp', 'a.json', {
      rename: () => {
        attempts += 1;
        if (attempts <= codes.length) {
          throw Object.assign(new Error(`transient ${codes[attempts - 1]}`), {
            code: codes[attempts - 1],
          });
        }
      },
      sleep: (ms) => delays.push(ms),
    });
    expect(attempts).toBe(4); // 1 次原始尝试 + 3 次重试
    expect(delays).toEqual([10, 20, 50]);
  });

  it('三次重试后仍失败才抛错（总共 4 次尝试）', () => {
    const delays: number[] = [];
    let attempts = 0;
    expect(() =>
      renameWithRetry('a.tmp', 'a.json', {
        rename: () => {
          attempts += 1;
          throw Object.assign(new Error('still locked'), { code: 'EPERM' });
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow(/still locked/);
    expect(attempts).toBe(4);
    expect(delays).toEqual([10, 20, 50]);
  });

  it('非瞬时错误立即抛出，不浪费重试', () => {
    // ENOENT/EXDEV 重试也不会变好，继续等只会掩盖真实问题（如路径写错）。
    const delays: number[] = [];
    let attempts = 0;
    expect(() =>
      renameWithRetry('a.tmp', 'a.json', {
        rename: () => {
          attempts += 1;
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow(/missing/);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it('同版本文件正常读取', () => {
    const filePath = tempFile();
    fs.writeFileSync(
      filePath,
      JSON.stringify({ schemaVersion: 1, data: { items: ['ok'] } }),
    );
    const file = createJsonFile<{ items: string[] }>({
      filePath,
      schemaVersion: 1,
      defaultValue: () => ({ items: [] }),
    });
    expect(file.read()).toEqual({ items: ['ok'] });
    expect(getWarnings()).toHaveLength(0);
  });
});
