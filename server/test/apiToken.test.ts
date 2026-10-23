import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_PREFIX,
  createApiTokenRecord,
  hashApiToken,
  parseBearerToken,
  shouldUpdateLastUsed,
  toApiTokenView,
  verifyApiToken,
} from '../src/auth/apiToken';
import type { ApiTokenRecord } from '../src/domain/apiToken';

const base = (): ApiTokenRecord =>
  createApiTokenRecord({
    tenantId: 't_default',
    name: '测试令牌',
    scopes: ['providers:read'],
    createdBy: 'u_1',
    expiresAt: null,
  }).record;

describe('API 令牌生成与校验', () => {
  it('生成的令牌带 api_ 前缀，与网关令牌 lam_ 区分开', () => {
    const { token } = createApiTokenRecord({
      tenantId: 't_default',
      name: 'x',
      scopes: ['providers:read'],
      createdBy: 'u_1',
      expiresAt: null,
    });
    // 前缀不同是刻意的：日志里要能一眼分辨"这是管理面凭据还是转发凭据"
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(token.startsWith('lam_')).toBe(false);
    expect(token.length).toBeGreaterThan(20);
  });

  it('只存哈希，记录里不含明文', () => {
    const { token, record } = createApiTokenRecord({
      tenantId: 't_default',
      name: 'x',
      scopes: ['providers:read'],
      createdBy: 'u_1',
      expiresAt: null,
    });
    expect(record.tokenHash).toBe(hashApiToken(token));
    expect(JSON.stringify(record)).not.toContain(token);
  });

  it('正确令牌通过，错误令牌不通过', () => {
    const { token, record } = createApiTokenRecord({
      tenantId: 't_default',
      name: 'x',
      scopes: ['providers:read'],
      createdBy: 'u_1',
      expiresAt: null,
    });
    expect(verifyApiToken(token, record)).toBe(true);
    expect(verifyApiToken(`${token}x`, record)).toBe(false);
    expect(verifyApiToken('api_完全不存在的令牌', record)).toBe(false);
    expect(verifyApiToken(token, undefined)).toBe(false);
  });

  it('已吊销的令牌立即失效', () => {
    const { token, record } = createApiTokenRecord({
      tenantId: 't_default',
      name: 'x',
      scopes: ['providers:read'],
      createdBy: 'u_1',
      expiresAt: null,
    });
    expect(verifyApiToken(token, { ...record, revokedAt: new Date().toISOString() })).toBe(false);
  });

  it('已过期的令牌失效，未到期的仍可用', () => {
    const { token, record } = createApiTokenRecord({
      tenantId: 't_default',
      name: 'x',
      scopes: ['providers:read'],
      createdBy: 'u_1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(verifyApiToken(token, record)).toBe(true);
    expect(
      verifyApiToken(token, { ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }),
    ).toBe(false);
  });

  it('scopes 为空的令牌不可用', () => {
    // 空 scopes 意味着"什么都不能干"，让它通过认证只会在每个接口上撞 403，
    // 不如直接当作无效凭据
    const { token, record } = createApiTokenRecord({
      tenantId: 't_default',
      name: 'x',
      scopes: [],
      createdBy: 'u_1',
      expiresAt: null,
    });
    expect(verifyApiToken(token, record)).toBe(false);
  });
});

describe('Bearer 头解析', () => {
  it('接受标准格式，大小写不敏感', () => {
    expect(parseBearerToken('Bearer api_abc')).toBe('api_abc');
    expect(parseBearerToken('bearer api_abc')).toBe('api_abc');
    expect(parseBearerToken('  Bearer   api_abc  ')).toBe('api_abc');
  });

  it('拒绝非 api_ 前缀，避免把网关令牌当管理令牌用', () => {
    expect(parseBearerToken('Bearer lam_abc')).toBeNull();
  });

  it('拒绝缺失或格式错误的头', () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken('')).toBeNull();
    expect(parseBearerToken('Basic abc')).toBeNull();
    expect(parseBearerToken('api_abc')).toBeNull();
  });
});

describe('对外视图', () => {
  it('剔除 tokenHash，保留可辨识字段', () => {
    const record = base();
    const view = toApiTokenView(record);
    expect(view).not.toHaveProperty('tokenHash');
    expect(view.prefix).toBe(record.prefix);
    expect(view.tail).toBe(record.tail);
    expect(view.scopes).toEqual(record.scopes);
  });
});

describe('lastUsedAt 节流', () => {
  it('从未使用过时立即更新', () => {
    expect(shouldUpdateLastUsed({ ...base(), lastUsedAt: null })).toBe(true);
  });

  it('60 秒内不重复写盘', () => {
    const now = Date.now();
    const recent = { ...base(), lastUsedAt: new Date(now - 30_000).toISOString() };
    expect(shouldUpdateLastUsed(recent, now)).toBe(false);
  });

  it('超过 60 秒后更新', () => {
    const now = Date.now();
    const stale = { ...base(), lastUsedAt: new Date(now - 61_000).toISOString() };
    expect(shouldUpdateLastUsed(stale, now)).toBe(true);
  });
});
