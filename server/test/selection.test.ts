import { describe, expect, it } from 'vitest';
import { defaultTenantSettings, type TenantSettings } from '../src/domain/settings';
import { selectCandidates } from '../src/gateway/selection';
import type { ProviderRecord } from '../src/domain/provider';

/**
 * 生图选路的纯函数测试。
 *
 * 这里刻意不启服务、不碰网络：选路是纯函数（`gateway/selection.ts`），
 * 端到端行为在 `smoke.test.ts` 覆盖。分开写是因为**这些结论要能被单独钉住**：
 * 一旦有人把 image 分支改回"只收 openai 供应商"，这里立刻红。
 */

function provider(overrides: Partial<ProviderRecord> & Pick<ProviderRecord, 'id' | 'apiType'>): ProviderRecord {
  return {
    tenantId: 't_default',
    name: overrides.id,
    providerKey: overrides.id,
    baseUrl: 'https://example.test',
    apiKey: '',
    models: [],
    enabled: true,
    priority: 0,
    createdBy: 'u_owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function settings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return { ...defaultTenantSettings(), ...overrides };
}

describe('生图选路：可接受协议', () => {
  it('responses 供应商也能被选中（apiType 不等于"能否生图"）', () => {
    // 实测：本机 opendesign 是 responses 类型却真的能生图。
    // 只收 openai 会让这家永远选不中。
    const responses = provider({
      id: 'opendesign',
      apiType: 'responses',
      models: [],
      imageModels: ['gpt-image-2'],
    });
    const result = selectCandidates('gpt-image-2', [responses], settings(), '/images/generations', false);
    expect(result.mode).toBe('default');
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.provider.id).toBe('opendesign');
  });

  it('只有 anthropic 供应商时返回 invalid 并给出专属原因', () => {
    const anthropic = provider({ id: 'cc', apiType: 'anthropic', models: [], imageModels: ['gpt-image-2'] });
    const result = selectCandidates('gpt-image-2', [anthropic], settings(), '/images/generations', false);
    expect(result.mode).toBe('invalid');
    if (result.mode !== 'invalid') throw new Error('unexpected');
    // 断言键而不是译文：文案会随语言变
    expect(result.reasonKey).toBe('gateway.selection.noEnabledImageProvider');
    // 被排除的供应商必须列出来，否则用户看到"没有可用供应商"却看到界面上有几家
    expect(result.excluded?.map((item) => item.providerId)).toEqual(['cc']);
  });

  it('禁用的供应商不参与选路', () => {
    const disabled = provider({
      id: 'off',
      apiType: 'openai',
      models: [],
      imageModels: ['gpt-image-2'],
      enabled: false,
    });
    const result = selectCandidates('gpt-image-2', [disabled], settings(), '/images/generations', false);
    expect(result.mode).toBe('invalid');
  });
});

describe('生图选路：三档优先级', () => {
  it('声明了该模型的供应商优先于默认供应商', () => {
    // 默认供应商 priority 更小、又是 defaultProviderId，但它没声明这个模型；
    // 真正声明了的那家应该被选中——这是用户能表达的最明确信号。
    const def = provider({ id: 'default', apiType: 'openai', models: ['chat-model'], priority: 0 });
    const declaring = provider({
      id: 'declaring',
      apiType: 'responses',
      models: [],
      imageModels: ['gpt-image-2'],
      priority: 5,
    });
    const result = selectCandidates(
      'gpt-image-2',
      [def, declaring],
      settings({ defaultProviderId: 'default' }),
      '/images/generations',
      false,
    );
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.provider.id).toBe('declaring');
    expect(result.primary.reason).toBe('image-model');
  });

  it('没有声明时回退默认供应商', () => {
    const first = provider({ id: 'first', apiType: 'openai', models: ['a'], priority: 0 });
    const def = provider({ id: 'def', apiType: 'responses', models: ['b'], priority: 1 });
    const result = selectCandidates(
      'gpt-image-2',
      [first, def],
      settings({ defaultProviderId: 'def' }),
      '/images/generations',
      false,
    );
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.provider.id).toBe('def');
    expect(result.primary.reason).toBe('default-provider');
  });

  it('既没声明也没默认供应商时按 priority 取第一', () => {
    const high = provider({ id: 'high', apiType: 'openai', models: ['a'], priority: 0 });
    const low = provider({ id: 'low', apiType: 'responses', models: ['b'], priority: 9 });
    const result = selectCandidates('gpt-image-2', [low, high], settings(), '/images/generations', false);
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.provider.id).toBe('high');
    expect(result.primary.reason).toBe('priority');
  });

  it('多家都声明时，默认供应商在声明者中优先', () => {
    const a = provider({ id: 'a', apiType: 'openai', models: [], imageModels: ['gpt-image-2'], priority: 0 });
    const b = provider({ id: 'b', apiType: 'responses', models: [], imageModels: ['gpt-image-2'], priority: 3 });
    const result = selectCandidates(
      'gpt-image-2',
      [a, b],
      settings({ defaultProviderId: 'b' }),
      '/images/generations',
      false,
    );
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.provider.id).toBe('b');
  });
});

describe('生图选路：模型名与回退', () => {
  it('裸模型名不被改写，也不做协议转换', () => {
    const p = provider({ id: 'p', apiType: 'responses', models: [], imageModels: ['gpt-image-2'] });
    const result = selectCandidates('gpt-image-2', [p], settings(), '/images/generations', false);
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.upstreamModel).toBe('gpt-image-2');
    expect(result.primary.modelRewritten).toBe(false);
    // 生图永不转换：Images 协议没有 Chat 等价物
    expect(result.primary.convertResponsesToChat).toBe(false);
  });

  it('生图永远不开启转换，即便 protocolConversion 是打开的', () => {
    const p = provider({ id: 'p', apiType: 'openai', models: [], imageModels: ['gpt-image-2'] });
    const result = selectCandidates(
      'gpt-image-2',
      [p],
      settings({ protocolConversion: true }),
      '/images/generations',
      false,
    );
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.convertResponsesToChat).toBe(false);
  });

  it('备选列表不含主供应商，且保持可预测的顺序', () => {
    const a = provider({ id: 'a', apiType: 'openai', models: [], imageModels: ['gpt-image-2'], priority: 0 });
    const b = provider({ id: 'b', apiType: 'responses', models: [], priority: 1 });
    const c = provider({ id: 'c', apiType: 'openai', models: [], priority: 2 });
    const result = selectCandidates('gpt-image-2', [a, b, c], settings(), '/images/generations', false);
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.provider.id).toBe('a');
    // 实测场景：默认供应商 503 → 回退到下一家。顺序必须稳定，否则回退结果不可预测。
    expect(result.fallbacks.map((item) => item.provider.id)).toEqual(['b', 'c']);
  });

  it('生图请求不触发审批占位名改写', () => {
    // 审批映射是对话路径的逻辑（把 gpt-5.6-luna 换成用户配置的模型）。
    // 生图请求即便带了审批头，也不该被改写模型名。
    const p = provider({ id: 'p', apiType: 'responses', models: [], imageModels: ['gpt-5.6-luna'] });
    const result = selectCandidates(
      'gpt-5.6-luna',
      [p],
      settings({ approvalReviewModel: 'some-chat-model' }),
      '/images/generations',
      true,
    );
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.upstreamModel).toBe('gpt-5.6-luna');
    expect(result.primary.reason).not.toBe('approval-placeholder');
  });
});

describe('生图选路：别名', () => {
  it('别名明确指向时不进回退列表', () => {
    const a = provider({
      id: 'a',
      apiType: 'openai',
      providerKey: 'alpha',
      models: [],
      imageModels: ['gpt-image-2'],
    });
    const b = provider({
      id: 'b',
      apiType: 'responses',
      providerKey: 'beta',
      models: [],
      imageModels: ['gpt-image-2'],
    });
    const result = selectCandidates(
      'lam-alpha/gpt-image-2',
      [a, b],
      settings(),
      '/images/generations',
      false,
    );
    expect(result.mode).toBe('alias');
    if (result.mode === 'invalid') throw new Error('unexpected');
    expect(result.primary.provider.id).toBe('a');
    expect(result.primary.upstreamModel).toBe('gpt-image-2');
    expect(result.primary.modelRewritten).toBe(true);
    expect(result.fallbacks).toEqual([]);
  });

  it('别名指向 anthropic 供应商时仍解析成功，由 assertApiTypeMatch 负责拒绝', () => {
    // 选路层不越权做协议裁决：拒绝发生在发请求前那一步，
    // 这样错误文案能带上 path 与 accepted 列表，而不是一个笼统的"没有可用供应商"。
    const cc = provider({
      id: 'cc',
      apiType: 'anthropic',
      providerKey: 'cc',
      models: [],
      imageModels: ['claude-x'],
    });
    const result = selectCandidates('lam-cc/claude-x', [cc], settings(), '/images/generations', false);
    expect(result.mode).toBe('alias');
  });
});

describe('对话路径不受生图分支影响', () => {
  it('/responses 仍只选 responses 供应商', () => {
    const chat = provider({ id: 'chat', apiType: 'openai', models: ['m'], priority: 0 });
    const resp = provider({ id: 'resp', apiType: 'responses', models: ['m'], priority: 1 });
    const result = selectCandidates('m', [chat, resp], settings(), '/responses', false);
    if (result.mode === 'invalid') throw new Error('unexpected');
    // 协议完全匹配的排前面：能直通就别转换
    expect(result.primary.provider.id).toBe('resp');
    expect(result.primary.reason).toBe('priority');
  });
});
