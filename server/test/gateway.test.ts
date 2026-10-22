import { describe, expect, it } from 'vitest';
import { resolveModel } from '../src/domain/aliases';
import { requiredApiType, upstreamUrl } from '../src/gateway/forward';
import { hashGatewayToken, tokenMatches } from '../src/gateway/token';
import type { ProviderRecord } from '../src/domain/provider';

const provider: ProviderRecord = {
  id: 'p_1',
  tenantId: 't_default',
  name: 'Alpha',
  providerKey: 'alpha',
  apiType: 'openai',
  baseUrl: 'https://api.alpha.test',
  apiKey: '',
  models: ['gpt-x'],
  enabled: true,
  priority: 0,
  createdBy: 'u_owner',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('上游地址拼接', () => {
  it('baseUrl 不含 /v1 时自动补全', () => {
    expect(upstreamUrl(provider, '/chat/completions')).toBe(
      'https://api.alpha.test/v1/chat/completions',
    );
  });

  it('baseUrl 已含 /v1 时不重复', () => {
    expect(
      upstreamUrl({ ...provider, baseUrl: 'https://api.alpha.test/v1/' }, '/chat/completions'),
    ).toBe('https://api.alpha.test/v1/chat/completions');
  });
});

describe('协议匹配', () => {
  it('chat/completions 要求 openai', () => {
    expect(requiredApiType('/chat/completions')).toBe('openai');
    expect(requiredApiType('/messages')).toBe('anthropic');
    expect(requiredApiType('/responses')).toBeNull();
  });
});

describe('网关头鉴权', () => {
  it('哈希比对不接受错误令牌', () => {
    const meta = {
      tokenHash: hashGatewayToken('lmm_correct'),
      tokenCipher: '',
      prefix: 'lmm_corr',
      tail: 'rect',
      createdAt: '2026-01-01T00:00:00.000Z',
      tenantId: 't_default',
      createdBy: 'u_owner',
    };
    expect(tokenMatches('lmm_correct', meta)).toBe(true);
    expect(tokenMatches('lmm_wrong', meta)).toBe(false);
    expect(tokenMatches('lmm_correct', null)).toBe(false);
  });
});

describe('默认路径选路', () => {
  it('别名请求不会进入默认回退列表', () => {
    const result = resolveModel('lmm-alpha/gpt-x', [provider]);
    expect(result.kind).toBe('alias');
  });

  it('默认解析保留原始模型名', () => {
    const result = resolveModel('gpt-x', [provider]);
    expect(result).toEqual({ kind: 'default', upstreamModel: 'gpt-x' });
  });
});
