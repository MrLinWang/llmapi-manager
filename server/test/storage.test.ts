import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonFile } from '../src/store/jsonFile';
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
