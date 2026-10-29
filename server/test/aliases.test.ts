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
      'lam-alpha/gpt-x',
      'lam-alpha/gpt-x-mini',
    ]);
  });

  it('别名格式固定', () => {
    expect(buildAlias('alpha', 'gpt-x')).toBe('lam-alpha/gpt-x');
  });

  it('能力跟着别名走，同名模型不串值', () => {
    // 同一个裸模型名被两家声明、上下文窗口不同：能力必须按"哪一家"取，
    // 而不是按模型名反查——否则 lam-alpha/gpt-x 会拿到 beta 的窗口。
    const aliases = listAliases([
      provider({ modelCapabilities: { 'gpt-x': { contextWindow: 400_000 } } }),
      provider({
        id: 'p_2',
        providerKey: 'beta',
        name: 'Beta',
        modelCapabilities: { 'gpt-x': { contextWindow: 1_000_000 } },
      }),
    ]);
    const byAlias = new Map(aliases.map((item) => [item.alias, item.capability]));
    expect(byAlias.get('lam-alpha/gpt-x')).toEqual({ contextWindow: 400_000 });
    expect(byAlias.get('lam-beta/gpt-x')).toEqual({ contextWindow: 1_000_000 });
  });

  it('没有能力数据时别名不带该字段', () => {
    const aliases = listAliases([provider()]);
    expect(aliases[0].capability).toBeUndefined();
  });

  it('生图模型不发布别名（否则会出现在 Codex 的 /model 里）', () => {
    // 两份列表分开的意义就在这里：imageModels 只服务 /v1/images/*，
    // 不进聚合别名 → 不进 Codex 目录 → 用户不会在 /model 里选中它去聊天。
    const aliases = listAliases([
      provider({ models: ['gpt-x'], imageModels: ['gpt-image-2'] }),
    ]);
    expect(aliases.map((item) => item.alias)).toEqual(['lam-alpha/gpt-x']);
    expect(aliases.some((item) => item.alias.includes('gpt-image-2'))).toBe(false);
  });

  it('只有生图模型的供应商不发布任何别名', () => {
    const aliases = listAliases([
      provider({ models: [], imageModels: ['gpt-image-2'] }),
    ]);
    expect(aliases).toEqual([]);
  });
});

describe('别名解析', () => {
  const providers = [
    provider(),
    provider({ id: 'p_2', providerKey: 'beta', name: 'Beta', enabled: false }),
  ];

  it('解析到具体供应商并改写上游模型名', () => {
    const result = resolveModel('lam-alpha/gpt-x-mini', providers);
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
    const result = resolveModel('lam-unknown/gpt-x', providers);
    expect(result.kind).toBe('invalid');
  });

  it('已禁用供应商不回落', () => {
    const result = resolveModel('lam-beta/gpt-x', providers);
    expect(result.kind).toBe('invalid');
    // reason 仍是可读中文（诊断与网关响应都在读它），同时带上可机读的键
    if (result.kind === 'invalid') {
      expect(result.reasonKey).toBe('gateway.alias.providerDisabled');
      expect(result.reason).toContain('禁用');
    }
  });

  it('未声明的模型不回落', () => {
    const result = resolveModel('lam-alpha/gpt-zzz', providers);
    expect(result.kind).toBe('invalid');
  });

  it('格式残缺的别名报错', () => {
    expect(resolveModel('lam-alpha', providers).kind).toBe('invalid');
    expect(resolveModel('lam-/gpt-x', providers).kind).toBe('invalid');
    expect(resolveModel('lam-alpha/', providers).kind).toBe('invalid');
  });

  it('生图路径按 imageModels 解析，对话路径按 models 解析', () => {
    // 同一个别名在两条路径下的结论不同——这正是"两份清单"的语义。
    const split = [
      provider({ models: ['gpt-x'], imageModels: ['gpt-image-2'] }),
    ];
    expect(resolveModel('lam-alpha/gpt-image-2', split, { imagePath: true }).kind).toBe('alias');
    expect(resolveModel('lam-alpha/gpt-x', split, { imagePath: true }).kind).toBe('invalid');
    expect(resolveModel('lam-alpha/gpt-x', split).kind).toBe('alias');
    expect(resolveModel('lam-alpha/gpt-image-2', split).kind).toBe('invalid');
  });

  it('模型在对话列表却被当生图模型用时，报错要说清该移到哪', () => {
    // 笼统的"未声明模型"会让用户去 models 里找——那儿明明有，于是怀疑功能坏了。
    const split = [provider({ models: ['gpt-x'], imageModels: [] })];
    const result = resolveModel('lam-alpha/gpt-x', split, { imagePath: true });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.reasonKey).toBe('gateway.alias.modelIsNotImageModel');
      expect(result.reason).toContain('生图模型列表');
    }
  });
});
