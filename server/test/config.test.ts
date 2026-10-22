import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

/**
 * 这些变量会被 loadConfig 读取，测试期间必须清空再按需设置，
 * 否则本机 .env / 进程环境会污染默认值断言。
 */
const MANAGED = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'DATA_DIR',
  'LOG_DIR',
  'LOG_LEVEL',
  'LOG_MAX_BYTES',
  'LOG_MAX_FILES',
  'HOST',
  'PORT',
  'PUBLIC_BASE_URL',
  'SESSION_SECRET',
  'DATA_ENCRYPTION_KEY',
  'AGENT_HOME_DIR',
];

const saved = new Map<string, string | undefined>();
const dirs: string[] = [];

beforeEach(() => {
  for (const key of MANAGED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  // 把 DATA_DIR 指到临时目录，避免动到真实的 data/ 与 instance.json
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-config-'));
  dirs.push(dir);
  process.env.DATA_DIR = dir;
  process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
});

afterEach(() => {
  for (const key of MANAGED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('配置默认值', () => {
  it('ADMIN_USERNAME 默认为 admin', () => {
    expect(loadConfig().adminUsername).toBe('admin');
  });

  it('ADMIN_USERNAME 显式设置时优先生效', () => {
    process.env.ADMIN_USERNAME = 'root';
    expect(loadConfig().adminUsername).toBe('root');
  });

  it('LOG_LEVEL 默认 info，非法值回落 info', () => {
    expect(loadConfig().logLevel).toBe('info');
    process.env.LOG_LEVEL = 'verbose';
    expect(loadConfig().logLevel).toBe('info');
    process.env.LOG_LEVEL = 'debug';
    expect(loadConfig().logLevel).toBe('debug');
  });

  it('日志目录默认落在仓库根 log/，与 DATA_DIR 无关', () => {
    const config = loadConfig();
    expect(config.logDir).toBeTruthy();
    expect(path.basename(config.logDir as string)).toBe('log');
    // 刻意不放在数据目录下：日志是运行产物，不是租户业务数据
    expect(config.logDir).not.toBe(config.dataDir);
    expect(config.logDir?.startsWith(config.dataDir)).toBe(false);
  });

  it('LOG_DIR=off 关闭落盘', () => {
    process.env.LOG_DIR = 'off';
    expect(loadConfig().logDir).toBeUndefined();
  });

  it('LOG_DIR 相对路径按仓库根解析', () => {
    process.env.LOG_DIR = 'var/logs';
    const config = loadConfig();
    expect(config.logDir).toBeTruthy();
    expect(config.logDir?.endsWith(path.join('var', 'logs'))).toBe(true);
  });

  it('滚动参数默认 5MB / 5 个，非法值回落默认', () => {
    const config = loadConfig();
    expect(config.logMaxBytes).toBe(5 * 1024 * 1024);
    expect(config.logMaxFiles).toBe(5);

    process.env.LOG_MAX_BYTES = '1024';
    process.env.LOG_MAX_FILES = '2';
    const custom = loadConfig();
    expect(custom.logMaxBytes).toBe(1024);
    expect(custom.logMaxFiles).toBe(2);

    process.env.LOG_MAX_BYTES = '0';
    process.env.LOG_MAX_FILES = 'abc';
    const fallback = loadConfig();
    expect(fallback.logMaxBytes).toBe(5 * 1024 * 1024);
    expect(fallback.logMaxFiles).toBe(5);
  });
});
