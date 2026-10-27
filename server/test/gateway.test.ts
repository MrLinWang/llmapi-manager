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
    // 默认语言是中文（部署者默认环境），显式传入语言则跟随界面/请求语言
    for (const apiType of API_TYPES) {
      expect(apiTypeLabel(apiType, 'zh')).toMatch(/兼容（.+）$/);
      expect(apiTypeLabel(apiType, 'en')).toMatch(/-compatible \(.+\)$/);
    }
    // 不含第三种"OpenAI Responses"这种句式不一致的旧写法
    expect(apiTypeLabel('responses', 'zh')).toBe('OpenAI 兼容（Responses）');
    expect(apiTypeLabel('responses', 'en')).toBe('OpenAI-compatible (Responses)');
    // 不传语言时回落到中文：服务端内部（日志、启动横幅）固定用中文
    expect(apiTypeLabel('responses')).toBe('OpenAI 兼容（Responses）');
  });
});

describe('协议匹配', () => {
  // 注意：这条用例名里不要说"不做转换"。requiredApiType 只表达"路径与协议的对应表"，
  // 是否允许跨协议转发由设置项 protocolConversion 决定，且只有 responses→openai
  // 一个方向有转换器（见 gateway/convert/，端到端行为在 smoke 里）。
  it('三条路径各自要求匹配的协议（定义映射，不涉及是否转换）', () => {
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
      tokenHash: hashGatewayToken('lam_correct'),
      tokenCipher: '',
      prefix: 'lam_corr',
      tail: 'rect',
      createdAt: '2026-01-01T00:00:00.000Z',
      tenantId: 't_default',
      createdBy: 'u_owner',
    };
    expect(tokenMatches('lam_correct', meta)).toBe(true);
    expect(tokenMatches('lam_wrong', meta)).toBe(false);
    expect(tokenMatches('lam_correct', null)).toBe(false);
  });
});

describe('默认路径选路', () => {
  it('别名请求不会进入默认回退列表', () => {
    const result = resolveModel('lam-alpha/gpt-x', [provider]);
    expect(result.kind).toBe('alias');
  });

  it('默认解析保留原始模型名', () => {
    const result = resolveModel('gpt-x', [provider]);
    expect(result).toEqual({ kind: 'default', upstreamModel: 'gpt-x' });
  });
});
