/**
 * 逐档实测探测：请求形状 + accepted/rejected 判定 + 能力合并。
 *
 * 这里锁住三件事：
 * - 对 responses / openai 两种协议发的是**对应**的接口与字段（打成同一个就全错了）
 * - baseUrl 自带 `/v1` 时不重复拼接（否则全 404，界面显示"所有档位不可用"）
 * - 全档位被拒时**不写**能力（一次网络抖动/鉴权错不能被固化成"不支持推理"）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeEffort, probeProviderEfforts } from '../src/services/effortProbe';
import type { EffortProbeProgress } from '../src/services/effortProbe';
import type { ProviderRecord } from '../src/domain/provider';

function fakeResponse(status: number, body = '{}'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Request',
    text: async () => body,
  } as unknown as Response;
}

function record(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'p_1',
    tenantId: 't_default',
    name: 'Upstream',
    providerKey: 'upstream',
    apiType: 'responses',
    baseUrl: 'http://up.test',
    apiKey: 'encrypted-key',
    models: ['m1'],
    modelCapabilities: {
      m1: { contextWindow: 1_000, inputModalities: ['text', 'image'] },
    },
    enabled: true,
    priority: 0,
    createdBy: 'u_owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('逐档实测探测', () => {
  it('responses：按 reasoning.effort 逐档发请求，只保留 2xx 档位并合并进已有能力', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { reasoning?: { effort?: string } };
      return body.reasoning?.effort === 'low' || body.reasoning?.effort === 'high'
        ? fakeResponse(200)
        : fakeResponse(400, '{"error":{"message":"unsupported reasoning"}}');
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await probeProviderEfforts(record(), 'sk-test', {
      language: 'en',
      candidates: ['none', 'low', 'medium', 'high'],
    });

    expect(outcome.candidates).toEqual(['none', 'low', 'medium', 'high']);
    expect(outcome.models).toEqual([
      { model: 'm1', accepted: ['low', 'high'], rejected: ['none', 'medium'] },
    ]);
    // 合并而不是覆盖：上下文/模态等已有字段必须保留
    expect(outcome.capabilities.m1).toEqual({
      contextWindow: 1_000,
      inputModalities: ['text', 'image'],
      supportsReasoning: true,
      reasoningEfforts: ['low', 'high'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://up.test/v1/responses');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const firstBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(firstBody.reasoning).toEqual({ effort: 'none' });
    expect(firstBody.max_output_tokens).toBe(16);
  });

  it('baseUrl 已带 /v1 时不重复拼接', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    await probeProviderEfforts(record({ baseUrl: 'http://up.test/v1/' }), 'sk-test', {
      candidates: ['low'],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://up.test/v1/responses');
  });

  it('openai：走 /chat/completions 并用 reasoning_effort 字段', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await probeProviderEfforts(record({ apiType: 'openai' }), 'sk-test', {
      candidates: ['low', 'xhigh'],
    });

    expect(outcome.models[0].accepted).toEqual(['low', 'xhigh']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://up.test/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('low');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('全档位被拒：不写能力，并把上游原因带回结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeResponse(400, '{"error":{"message":"model does not support reasoning"}}')),
    );

    const outcome = await probeProviderEfforts(record(), 'sk-test', {
      language: 'zh',
      candidates: ['low', 'high'],
    });

    expect(outcome.capabilities).toEqual({});
    expect(outcome.models[0].accepted).toEqual([]);
    expect(outcome.models[0].rejected).toEqual(['low', 'high']);
    expect(outcome.models[0].error).toContain('HTTP 400');
  });

  it('每完成一次请求推送一次进度，done 单调递增且 total 固定', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200)));

    const events: EffortProbeProgress[] = [];
    const outcome = await probeProviderEfforts(record(), 'sk-test', {
      candidates: ['low', 'high'],
      onProgress: (progress) => events.push(progress),
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.done)).toEqual([1, 2]);
    expect(events.every((event) => event.total === 2)).toBe(true);
    expect(events.every((event) => event.model === 'm1')).toBe(true);
    expect(events.map((event) => event.effort).sort()).toEqual(['high', 'low']);
    expect(events.every((event) => event.accepted)).toBe(true);
    expect(outcome.candidates).toEqual(['low', 'high']);
  });

  it('网络异常按不可用处理，不抛异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    const attempt = await probeEffort(
      { apiType: 'responses', baseUrl: 'http://up.test', apiKey: 'sk-test' },
      'm1',
      'low',
      'en',
    );
    expect(attempt.accepted).toBe(false);
    expect(attempt.error).toContain('fetch failed');
  });

  it('候选档位里混入未知值时不发请求，也不把它们写回能力', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await probeProviderEfforts(record(), 'sk-test', {
      candidates: ['bogus', 'low'],
    });

    // 'bogus' 被白名单过滤掉，只剩 low
    expect(outcome.candidates).toEqual(['low']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.capabilities.m1?.reasoningEfforts).toEqual(['low']);
  });
});
