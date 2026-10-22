import { describe, expect, it } from 'vitest';
import { resolveModel } from '../src/domain/aliases';
import { GATEWAY_PATHS, requiredApiType, upstreamUrl } from '../src/gateway/forward';
import { API_TYPES, apiTypeLabel } from '../src/domain/provider';
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

describe('协议类型文案', () => {
  it('三个 label 用同一句式：<厂商> 兼容（<API 形态>）', () => {
    for (const apiType of API_TYPES) {
      expect(apiTypeLabel(apiType)).toMatch(/兼容（.+）$/);
    }
    // 不含第三种"OpenAI Responses"这种句式不一致的旧写法
    expect(apiTypeLabel('responses')).toBe('OpenAI 兼容（Responses）');
  });
});

describe('协议匹配', () => {
  it('三条路径各自要求匹配的协议，均不做转换', () => {
    expect(requiredApiType('/chat/completions')).toBe('openai');
    expect(requiredApiType('/messages')).toBe('anthropic');
    // responses 从"不限制"改为严格匹配：openai 上游不再被当成 responses 直通
    expect(requiredApiType('/responses')).toBe('responses');
  });

  it('路径清单与协议要求同源，不会只改一处', () => {
    for (const path of GATEWAY_PATHS) {
      expect(requiredApiType(path)).not.toBeUndefined();
    }
    expect(GATEWAY_PATHS).toContain('/responses');
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
