/**
 * modelinfo.dev 客户端：字段映射与安全过滤。
 *
 * 这个源负责给"推理档位"提供权威值（直接给数组，不用按 provider 投票），
 * 风险点有三个，下面重点锁住：
 * - `efforts: []` 是"支持但未知"，不能当成"没有档位"
 * - 它的模态词表含 `document`，Codex 不认，必须过滤（否则整份目录失效）
 * - 结构不符/不可达时要返回 null 而不是抛异常
 */
import { describe, expect, it } from 'vitest';
import { buildIndex, lookup, toCapability } from '../src/services/modelInfo';
import { filterReasoningEfforts, CODEX_REASONING_EFFORTS } from '../src/domain/provider';

describe('modelinfo 字段映射', () => {
  it('limits 与 reasoning 正确映射', () => {
    expect(
      toCapability({
        limits: { context: 1_048_576, output: 32_000 },
        reasoning: { supported: true, efforts: ['low', 'high'] },
      }),
    ).toEqual({
      contextWindow: 1_048_576,
      maxOutputTokens: 32_000,
      supportsReasoning: true,
      reasoningEfforts: ['low', 'high'],
    });
  });

  it('efforts 为空数组时不写该字段（表示支持但档位未知）', () => {
    // 这是与 models.dev 配合的关键：空数组要继续去问下一个源，
    // 若写成 []，合并时就会被当成"明确没有档位"而停止查找。
    const capability = toCapability({ reasoning: { supported: true, efforts: [] } });
    expect(capability).toEqual({ supportsReasoning: true });
    expect(capability?.reasoningEfforts).toBeUndefined();
  });

  it('document / video 模态被过滤，只留 Codex 认识的', () => {
    // modelinfo 的词表是 text/image/audio/video/document，
    // 而 Codex 只认 text/image/audio。多写一个会让整份目录解析失败。
    expect(
      toCapability({ modalities: { input: ['text', 'image', 'video', 'document'] } }),
    ).toEqual({ inputModalities: ['text', 'image'] });
  });

  it('未知档位被白名单丢弃', () => {
    expect(
      toCapability({ reasoning: { supported: true, efforts: ['low', 'turbo', 'high'] } }),
    ).toEqual({ supportsReasoning: true, reasoningEfforts: ['low', 'high'] });
  });

  it('非正整数的 limit 被丢弃', () => {
    expect(toCapability({ limits: { context: 0, output: -1 } })).toBeUndefined();
  });

  it('没有任何可用字段时返回 undefined', () => {
    expect(toCapability({})).toBeUndefined();
  });
});

describe('档位白名单与排序', () => {
  it('按强度升序输出，不保留输入顺序', () => {
    // 顺序影响 Codex 的 fallback（取 len-1/2 作为中间档），
    // 乱序会让"中间档"不再是 medium。
    expect(filterReasoningEfforts(['high', 'low', 'medium'])).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(filterReasoningEfforts(['max', 'none', 'medium'])).toEqual([
      'none',
      'medium',
      'max',
    ]);
  });

  it('去重且只保留 Codex 认识的值', () => {
    expect(filterReasoningEfforts(['low', 'low', 'bogus'])).toEqual(['low']);
  });

  it('非数组返回空数组', () => {
    expect(filterReasoningEfforts(undefined)).toEqual([]);
    expect(filterReasoningEfforts('high')).toEqual([]);
  });

  it('白名单本身按强度升序（fallback 语义依赖它）', () => {
    const order = CODEX_REASONING_EFFORTS;
    expect(order.indexOf('low')).toBeLessThan(order.indexOf('medium'));
    expect(order.indexOf('medium')).toBeLessThan(order.indexOf('high'));
    expect(order.indexOf('high')).toBeLessThan(order.indexOf('xhigh'));
    expect(order.indexOf('xhigh')).toBeLessThan(order.indexOf('max'));
  });
});

describe('modelinfo 索引', () => {
  it('按 {data:[...]} 结构建索引并能查到', () => {
    const index = buildIndex({
      object: 'list',
      data: [{ id: 'openai/gpt-6-luna', reasoning: { supported: true, efforts: ['low'] } }],
    });
    expect(lookup(index, 'gpt-6-luna')).toEqual({
      supportsReasoning: true,
      reasoningEfforts: ['low'],
    });
  });

  it('同名多条时放弃，不随便挑一条', () => {
    const index = buildIndex({
      data: [
        { id: 'a/dup', limits: { context: 100 } },
        { id: 'b/dup', limits: { context: 200 } },
      ],
    });
    expect(lookup(index, 'dup')).toBeUndefined();
  });

  it('结构不符返回 null', () => {
    expect(buildIndex(null)).toBeNull();
    expect(buildIndex({})).toBeNull();
    expect(buildIndex({ data: 'nope' })).toBeNull();
  });
});
