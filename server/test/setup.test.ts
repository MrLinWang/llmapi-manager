import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createContext } from '../src/context';
import { createLogger } from '../src/logger';
import { bootstrapIdentity } from '../src/bootstrap';
import { loadConfig, type AppConfig } from '../src/config';
import { resetWarnings } from '../src/resilience';
import { portOf, startMockUpstream } from './mockUpstream';

/**
 * 首次初始化流程：不带 ADMIN_PASSWORD 启动时，服务不创建账号，
 * 只生成一次性 setup token；用户凭它在网页上自设用户名与口令。
 */

let app: FastifyInstance;
let dataDir: string;
let agentHome: string;
let servers: Server[] = [];
let setupToken = '';
let config: AppConfig;

function testConfig(dir: string, home: string, overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    dataDir: dir,
    agentHomeDir: home,
    publicBaseUrl: 'http://127.0.0.1:8787',
    adminUsername: 'admin',
    adminPassword: undefined,
    encryptionKey: 'setup-encryption-key',
    sessionSecret: 'setup-session-secret-0123456789abcdef',
    sessionSecretGenerated: false,
    logLevel: 'error',
    ...overrides,
  };
}

async function boot(overrides: Partial<AppConfig> = {}): Promise<void> {
  resetWarnings();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-setup-data-'));
  agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-setup-home-'));
  const mock = await startMockUpstream();
  servers = [mock];
  config = testConfig(dataDir, agentHome, {
    publicBaseUrl: `http://127.0.0.1:${portOf(mock)}`,
    ...overrides,
  });
  const logger = createLogger('error');
  const ctx = createContext(config, logger);
  const result = await bootstrapIdentity(config, ctx.paths, ctx.identity, logger, ctx.setup);
  setupToken = result.setupToken ?? '';
  app = await buildApp({ ctx });
  await app.ready();
}

async function call(
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({ method, url, payload: payload as never, headers });
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await app?.close();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(agentHome, { recursive: true, force: true });
});

describe('首次初始化：状态', () => {
  it('未初始化时不创建随机口令账号', () => {
    expect(setupToken).toMatch(/^setup_/);
    const identity = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'identity.json'), 'utf8'),
    ).data;
    expect(identity.users).toHaveLength(0);
  });

  it('/api/setup/status 免鉴权，返回 needsSetup 与规则', async () => {
    const response = await call('GET', '/api/setup/status');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.needsSetup).toBe(true);
    expect(body.defaultUsername).toBe('admin');
    expect(body.rules.minPasswordLength).toBe(8);
    // 绝不能把 token 或哈希带出来
    expect(response.body).not.toContain(setupToken);
    expect(response.body).not.toContain('tokenHash');
  });

  it('未初始化时登录必然失败（没有账号）', async () => {
    const response = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: 'whatever-password',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('首次初始化：完成设置', () => {
  it('正确 token 可创建管理员，随后状态变为已初始化', async () => {
    const response = await call('POST', '/api/setup', {
      token: setupToken,
      username: 'alice',
      password: 'my-own-password',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().user.username).toBe('alice');
    expect(response.json().user.role).toBe('owner');
    expect(response.body).not.toContain('my-own-password');

    const status = await call('GET', '/api/setup/status');
    expect(status.json().needsSetup).toBe(false);
  });

  it('设置后可用新账号登录', async () => {
    await call('POST', '/api/setup', {
      token: setupToken,
      username: 'alice',
      password: 'my-own-password',
    });
    const login = await call('POST', '/api/auth/login', {
      username: 'alice',
      password: 'my-own-password',
    });
    expect(login.statusCode).toBe(200);
    expect(String(login.headers['set-cookie'])).toContain('llmapi_session');
  });

  it('只存 scrypt 哈希，不存明文口令', async () => {
    await call('POST', '/api/setup', {
      token: setupToken,
      username: 'alice',
      password: 'my-own-password',
    });
    const raw = fs.readFileSync(path.join(dataDir, 'identity.json'), 'utf8');
    expect(raw).not.toContain('my-own-password');
    expect(JSON.parse(raw).data.users[0].passwordHash).toMatch(/^scrypt\$/);
  });

  it('token 错误时拒绝，且不创建账号', async () => {
    const response = await call('POST', '/api/setup', {
      token: 'setup_wrong-token-value',
      username: 'alice',
      password: 'my-own-password',
    });
    expect(response.statusCode).toBe(403);

    const identity = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'identity.json'), 'utf8'),
    ).data;
    expect(identity.users).toHaveLength(0);
  });

  it('token 不能重复使用（完成后作废）', async () => {
    const first = await call('POST', '/api/setup', {
      token: setupToken,
      username: 'alice',
      password: 'my-own-password',
    });
    expect(first.statusCode).toBe(201);

    const replay = await call('POST', '/api/setup', {
      token: setupToken,
      username: 'attacker',
      password: 'another-password',
    });
    expect(replay.statusCode).toBe(409);
  });

  it('口令过短被拒绝', async () => {
    const response = await call('POST', '/api/setup', {
      token: setupToken,
      username: 'alice',
      password: 'short',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('8');
  });

  it('非法用户名被拒绝', async () => {
    const response = await call('POST', '/api/setup', {
      token: setupToken,
      username: 'bad name!',
      password: 'my-own-password',
    });
    expect(response.statusCode).toBe(400);
  });

  it('缺字段时返回 400 而不是 500', async () => {
    const response = await call('POST', '/api/setup', { username: 'alice' });
    expect(response.statusCode).toBe(400);
  });

  it('token 失败会计数，便于发现试探', async () => {
    await call('POST', '/api/setup', { token: 'nope', username: 'a', password: 'b' });
    await call('POST', '/api/setup', { token: 'nope', username: 'a', password: 'b' });
    const status = await call('GET', '/api/setup/status');
    expect(status.json().failedAttempts).toBe(2);
  });
});

describe('首次初始化：ADMIN_PASSWORD 应急通道', () => {
  it('配置了 ADMIN_PASSWORD 时直接建号，不需要 setup token', async () => {
    await app.close();
    await boot({ adminPassword: 'env-provided-password' });

    expect(setupToken).toBe('');
    const status = await call('GET', '/api/setup/status');
    expect(status.json().needsSetup).toBe(false);

    const login = await call('POST', '/api/auth/login', {
      username: 'admin',
      password: 'env-provided-password',
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('首次初始化：重启幂等', () => {
  it('未完成设置时重启沿用旧 token，不重复生成', async () => {
    const firstToken = setupToken;
    await app.close();

    const logger = createLogger('error');
    const ctx = createContext(config, logger);
    const again = await bootstrapIdentity(config, ctx.paths, ctx.identity, logger, ctx.setup);
    expect(again.needsSetup).toBe(true);
    // 不再返回新 token：仍然只有第一次打印的那个有效
    expect(again.setupToken).toBeUndefined();

    app = await buildApp({ ctx });
    await app.ready();

    const ok = await call('POST', '/api/setup', {
      token: firstToken,
      username: 'alice',
      password: 'my-own-password',
    });
    expect(ok.statusCode).toBe(201);
  });

  it('已完成设置后重启不会重新生成 token', async () => {
    await call('POST', '/api/setup', {
      token: setupToken,
      username: 'alice',
      password: 'my-own-password',
    });
    await app.close();

    const logger = createLogger('error');
    const ctx = createContext(config, logger);
    const again = await bootstrapIdentity(config, ctx.paths, ctx.identity, logger, ctx.setup);
    expect(again.needsSetup).toBe(false);
    expect(again.setupToken).toBeUndefined();
    // 已有账号不能被覆盖
    expect(ctx.identity.read().users).toHaveLength(1);
  });
});
