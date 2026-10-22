import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '../src/domain/permissions';
import { can, assertCan } from '../src/auth/policy';
import { AppError } from '../src/http/errors';
import { RouteRegistry } from '../src/http/routeRegistry';
import { createStore } from '../src/store/tenantScope';
import { StorePaths } from '../src/store/paths';
import { createIdentityRepo } from '../src/store/identityRepo';
import { createSecretCodec } from '../src/crypto/secretCodec';
import { createLogger } from '../src/logger';
import { defaultTenantSettings } from '../src/domain/settings';
import type { ProviderRecord } from '../src/domain/provider';
import type { Principal } from '../src/domain/identity';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempStore(): ReturnType<typeof createStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-store-'));
  dirs.push(dir);
  const paths = new StorePaths(dir);
  const logger = createLogger('error');
  const identity = createIdentityRepo(paths, logger);
  return createStore(paths, identity, logger);
}

function providerOf(tenantId: string, id: string): ProviderRecord {
  return {
    id,
    tenantId,
    name: id,
    providerKey: id,
    apiType: 'openai',
    baseUrl: 'https://example.test',
    apiKey: '',
    models: ['m'],
    enabled: true,
    priority: 0,
    createdBy: 'u_owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('权限矩阵', () => {
  const owner: Principal = { userId: 'u_owner', tenantId: 't_default', role: 'owner', via: 'session' };
  const member: Principal = { userId: 'u_x', tenantId: 't_default', role: 'member', via: 'gateway-token' };

  it('owner 拥有全部权限', () => {
    expect(ROLE_PERMISSIONS.owner.length).toBeGreaterThan(0);
    for (const permission of ROLE_PERMISSIONS.owner) {
      expect(can(owner, permission)).toBe(true);
    }
  });

  it('member 不能写供应商', () => {
    expect(can(member, 'providers:read')).toBe(false);
    expect(() => assertCan(member, 'providers:write')).toThrow(AppError);
  });

  it('越权抛出 forbidden', () => {
    try {
      assertCan(member, 'agents:apply');
      expect.unreachable('应当抛出');
    } catch (error) {
      expect((error as AppError).statusCode).toBe(403);
      expect((error as AppError).code).toBe('forbidden');
    }
  });
});

describe('租户隔离', () => {
  it('租户之间互相看不到数据', () => {
    const store = tempStore();
    const a = store.forTenant('t_a');
    const b = store.forTenant('t_b');

    a.providers.saveAll([providerOf('t_a', 'p_a')]);
    b.providers.saveAll([providerOf('t_b', 'p_b')]);

    expect(a.providers.list().map((item) => item.id)).toEqual(['p_a']);
    expect(b.providers.list().map((item) => item.id)).toEqual(['p_b']);

    a.settings.write({ ...defaultTenantSettings(), defaultProviderId: 'p_a' });
    expect(b.settings.read().defaultProviderId).toBeNull();

    a.requestLog.append({
      tenantId: 't_a',
      at: new Date().toISOString(),
      path: '/v1/chat/completions',
      requestedModel: 'm',
      upstreamModel: 'm',
      providerId: 'p_a',
      providerName: 'a',
      mode: 'default',
      stream: false,
      status: 200,
      latencyMs: 10,
      fallback: false,
    });
    expect(a.requestLog.recent(10)).toHaveLength(1);
    expect(b.requestLog.recent(10)).toHaveLength(0);
  });

  it('forTenant 拒绝空 tenantId', () => {
    const store = tempStore();
    expect(() => store.forTenant('')).toThrow();
  });
});

describe('凭据编解码', () => {
  it('配置密钥时落盘为密文且可解密', () => {
    const codec = createSecretCodec('test-key');
    const encoded = codec.encode('sk-plain-secret');
    expect(encoded).not.toContain('sk-plain-secret');
    expect(encoded.startsWith('enc:v1:')).toBe(true);
    expect(codec.decode(encoded)).toBe('sk-plain-secret');
  });

  it('未配置密钥时透传', () => {
    const codec = createSecretCodec(undefined);
    expect(codec.encrypted).toBe(false);
    expect(codec.encode('raw')).toBe('raw');
    expect(codec.decode('raw')).toBe('raw');
  });

  it('重复编码不叠加前缀', () => {
    const codec = createSecretCodec('test-key');
    const once = codec.encode('value');
    expect(codec.encode(once)).toBe(once);
  });
});

describe('路由访问登记', () => {
  it('全部声明时通过自检', () => {
    const registry = new RouteRegistry();
    registry.register({ method: 'GET', url: '/api/providers', access: 'providers:read' });
    registry.register({ method: 'GET', url: '/api/health', access: 'public' });
    expect(() => registry.assertAllDeclared()).not.toThrow();
  });

  it('能查到某条路由的访问声明', () => {
    const registry = new RouteRegistry();
    registry.register({ method: 'GET', url: '/api/agents', access: 'agents:read' });
    expect(registry.find('get', '/api/agents')).toBe('agents:read');
    expect(registry.find('GET', '/api/unknown')).toBeUndefined();
  });
});
