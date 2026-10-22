import { describe, expect, it } from 'vitest';
import {
  allocateProviderKey,
  maskApiKey,
  slugifyProviderKey,
  toProviderView,
  type ProviderRecord,
} from '../src/domain/provider';
import { buildAlias, listAliases, resolveModel } from '../src/domain/aliases';

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'p_1',
    tenantId: 't_default',
    name: 'Alpha',
    providerKey: 'alpha',
    apiType: 'openai',
    baseUrl: 'https://api.alpha.test',
    apiKey: 'plain-key-1234',
    models: ['gpt-x', 'gpt-x-mini'],
    enabled: true,
    priority: 0,
    createdBy: 'u_owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('providerKey', () => {
  it('从名称派生稳定 key', () => {
    expect(slugifyProviderKey('Packy Code')).toBe('packy-code');
    expect(slugifyProviderKey('  Kit **** ')).toBe('kit');
    expect(slugifyProviderKey('中文名称')).toBe('provider');
  });

  it('重名时追加序号', () => {
    expect(allocateProviderKey('Alpha', new Set(['alpha']))).toBe('alpha-2');
    expect(allocateProviderKey('Alpha', new Set(['alpha', 'alpha-2']))).toBe('alpha-3');
  });
});

describe('apiKey 脱敏', () => {
  it('保留首 3 位与尾 4 位', () => {
    expect(maskApiKey('sk-abcdefghijklmnop')).toEqual({
      masked: 'sk-********mnop',
      tail: 'mnop',
    });
  });

  it('短 key 全部打码且不泄漏长度以外的信息', () => {
    expect(maskApiKey('short')).toEqual({ masked: '*****', tail: 'hort' });
  });

  it('视图对象不含 apiKey 与 tenantId', () => {
    const view = toProviderView(provider(), 'plain-key-1234');
    expect(Object.keys(view)).not.toContain('apiKey');
    expect(Object.keys(view)).not.toContain('tenantId');
    expect(view.apiKeyMasked).toBe('pla********1234');
    expect(view.hasApiKey).toBe(true);
  });
});

describe('别名生成', () => {
  it('只发布启用供应商的模型', () => {
    const aliases = listAliases([
      provider(),
      provider({ id: 'p_2', providerKey: 'beta', name: 'Beta', enabled: false }),
    ]);
    expect(aliases.map((item) => item.alias)).toEqual([
      'lmm-alpha/gpt-x',
      'lmm-alpha/gpt-x-mini',
    ]);
  });

  it('别名格式固定', () => {
    expect(buildAlias('alpha', 'gpt-x')).toBe('lmm-alpha/gpt-x');
  });
});

describe('别名解析', () => {
  const providers = [
    provider(),
    provider({ id: 'p_2', providerKey: 'beta', name: 'Beta', enabled: false }),
  ];

  it('解析到具体供应商并改写上游模型名', () => {
    const result = resolveModel('lmm-alpha/gpt-x-mini', providers);
    expect(result).toMatchObject({
      kind: 'alias',
      alias: { providerKey: 'alpha', upstreamModel: 'gpt-x-mini', apiType: 'openai' },
    });
  });

  it('非别名请求按默认路径处理', () => {
    expect(resolveModel('gpt-x', providers)).toEqual({
      kind: 'default',
      upstreamModel: 'gpt-x',
    });
  });

  it('未知供应商不回落', () => {
    const result = resolveModel('lmm-unknown/gpt-x', providers);
    expect(result.kind).toBe('invalid');
  });

  it('已禁用供应商不回落', () => {
    const result = resolveModel('lmm-beta/gpt-x', providers);
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') expect(result.reason).toContain('禁用');
  });

  it('未声明的模型不回落', () => {
    const result = resolveModel('lmm-alpha/gpt-zzz', providers);
    expect(result.kind).toBe('invalid');
  });

  it('格式残缺的别名报错', () => {
    expect(resolveModel('lmm-alpha', providers).kind).toBe('invalid');
    expect(resolveModel('lmm-/gpt-x', providers).kind).toBe('invalid');
    expect(resolveModel('lmm-alpha/', providers).kind).toBe('invalid');
  });
});
