/**
 * models.dev 公开规格的匹配与映射。
 *
 * 这一层的风险不在"匹配不上"（匹配不上只是回落到默认值，无害），
 * 而在"匹配错"和"把非法值写进 Codex 目录"：
 * - 匹配错 → 给用户一个不属于他的上下文窗口
 * - 写进 pdf/video → Codex 整份目录解析失败并**静默回退到内置官方列表**（已实测）
 * 所以下面重点锁住这两条。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRegistryIndex,
  lookup,
  normalizeModelKey,
  toModelCapability,
} from '../src/services/modelRegistry';
import { filterInputModalities, CODEX_INPUT_MODALITIES } from '../src/domain/provider';
import { mergeCapabilities } from '../src/services/providers';

describe('四源合并：上游 > modelinfo > models.dev > 默认', () => {
  it('档位优先取 modelinfo（它直接给数组，不用投票）', () => {
    // modelinfo 与 models.dev 实测逐项吻合，但 modelinfo 更可信：
    // models.dev 的值是 200 多家 provider 的多数票，需要投票才能得出。
    expect(
      mergeCapabilities(
        undefined,
        { reasoningEfforts: ['low', 'high'] },
        { reasoningEfforts: ['low', 'medium', 'high', 'max'] },
      )?.reasoningEfforts,
    ).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('modelinfo 的 efforts 为空时落到 models.dev', () => {
    // 空数组 = "支持推理但档位未知"，必须继续问下一个源。
    // 若把它当成"无档位"，glm-5.3-flash / kimi-k2.7-code 就会丢掉档位。
    expect(
      mergeCapabilities(
        undefined,
        { reasoningEfforts: ['low', 'high', 'max'] },
        { supportsReasoning: true, reasoningEfforts: [] },
      )?.reasoningEfforts,
    ).toEqual(['low', 'high', 'max']);
  });

  it('两源都无档位时该字段不出现（目录回落三档）', () => {
    const merged = mergeCapabilities(undefined, { contextWindow: 200_000 }, {});
    expect(merged?.reasoningEfforts).toBeUndefined();
  });

  it('上游声明优先于两个公开源', () => {
    expect(
      mergeCapabilities(
        { contextWindow: 1_048_000 },
        { contextWindow: 1_000_000 },
        { contextWindow: 999_999 },
      )?.contextWindow,
    ).toBe(1_048_000);
  });

  it('输出上限在三个源之间取最小', () => {
    expect(
      mergeCapabilities(
        { maxOutputTokens: 128_000 },
        { maxOutputTokens: 384_000 },
        { maxOutputTokens: 64_000 },
      )?.maxOutputTokens,
    ).toBe(64_000);
  });

  it('合并出的档位会被排序与过滤', () => {
    expect(
      mergeCapabilities(undefined, undefined, {
        reasoningEfforts: ['high', 'bogus', 'low'],
      })?.reasoningEfforts,
    ).toEqual(['low', 'high']);
  });

  it('supportsReasoning=false 时档位不参与，但仍会记录状态', () => {
    const merged = mergeCapabilities(
      undefined,
      undefined,
      { supportsReasoning: false, reasoningEfforts: [] },
    );
    expect(merged?.supportsReasoning).toBe(false);
    expect(merged?.reasoningEfforts).toBeUndefined();
  });
});

describe('三级合并：上游 > models.dev > 默认', () => {
  it('上游没有时用 models.dev 的值补齐', () => {
    // 有的上游完全不返回 metadata，只能靠公开规格
    expect(mergeCapabilities(undefined, { contextWindow: 1_000_000 })).toEqual({
      contextWindow: 1_000_000,
    });
  });

  it('上游的上下文窗口优先，不被 models.dev 覆盖', () => {
    // 上游 1048000 vs models.dev 1000000：以上游这个中转的真实额度为准
    const merged = mergeCapabilities(
      { contextWindow: 1_048_000 },
      { contextWindow: 1_000_000 },
    );
    expect(merged?.contextWindow).toBe(1_048_000);
  });

  it('输出上限取两者较小值', () => {
    // 上游 output_budget(128k) 比 models.dev 规格(384k) 更保守也更真实；
    // 高估会导致上游直接报超长，比"用不满"更难排查。
    const merged = mergeCapabilities(
      { maxOutputTokens: 128_000 },
      { maxOutputTokens: 384_000 },
    );
    expect(merged?.maxOutputTokens).toBe(128_000);
  });

  it('上游只给上下文时，其余字段仍由 models.dev 补齐', () => {
    // 逐字段合并，不是整条覆盖
    const merged = mergeCapabilities(
      { contextWindow: 262_000 },
      { contextWindow: 999, maxOutputTokens: 131_072, supportsReasoning: true },
    );
    expect(merged).toEqual({
      contextWindow: 262_000,
      maxOutputTokens: 131_072,
      supportsReasoning: true,
    });
  });

  it('两边都没有时返回 undefined，交给目录回落默认值', () => {
    expect(mergeCapabilities(undefined, undefined)).toBeUndefined();
    expect(mergeCapabilities({}, {})).toBeUndefined();
  });

  it('合并后的模态仍过白名单', () => {
    const merged = mergeCapabilities(
      undefined,
      { inputModalities: ['text', 'image', 'pdf'] },
    );
    expect(merged?.inputModalities).toEqual(['text', 'image']);
  });
});

describe('models.dev 名字归一化', () => {
  it('抹平点号与连字符的差异', () => {
    // 实测差异：上游 claude-opus-5.5 / models.dev anthropic/claude-opus-5-5
    expect(normalizeModelKey('anthropic/claude-opus-5-5')).toBe(
      normalizeModelKey('claude-opus-5.5'),
    );
    expect(normalizeModelKey('deepseek/deepseek-v4.1-flash')).toBe(
      normalizeModelKey('deepseek-v4.1-flash'),
    );
  });

  it('忽略作者前缀与大小写', () => {
    expect(normalizeModelKey('moonshotai/Kimi-K3')).toBe('kimik3');
  });

  it('空串与纯符号不产生有效 key', () => {
    expect(normalizeModelKey('')).toBe('');
    expect(normalizeModelKey('///')).toBe('');
  });
});

describe('字段映射', () => {
  it('limit.context / limit.output 映射到我们的能力字段', () => {
    expect(
      toModelCapability({
        limit: { context: 1_048_576, output: 131_072 },
        reasoning: true,
      }),
    ).toEqual({
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      supportsReasoning: true,
    });
  });

  it('没有可用字段时返回 undefined 而不是空对象', () => {
    expect(toModelCapability({})).toBeUndefined();
    expect(toModelCapability({ limit: {} })).toBeUndefined();
  });

  it('非正整数的上限被丢弃', () => {
    // 0 / 负数会被 Codex 当成"窗口为 0"，比缺省（回落默认值）更糟
    expect(toModelCapability({ limit: { context: 0, output: -5 } })).toBeUndefined();
    expect(toModelCapability({ limit: { context: 'abc' } })).toBeUndefined();
  });

  it('字符串数字也接受（上游 JSON 里常见）', () => {
    expect(toModelCapability({ limit: { context: '200000' } })).toEqual({
      contextWindow: 200_000,
    });
  });
});

describe('Codex 模态白名单', () => {
  it('models.dev 的 pdf / video 被过滤掉', () => {
    // 这条是本次改造最重要的安全边界：多一个 pdf 会让整份目录失效
    expect(toModelCapability({ modalities: { input: ['text', 'image', 'pdf'] } }))
      .toEqual({ inputModalities: ['text', 'image'] });
    expect(
      toModelCapability({ modalities: { input: ['text', 'image', 'video', 'pdf'] } }),
    ).toEqual({ inputModalities: ['text', 'image'] });
  });

  it('text 恒定保留', () => {
    expect(filterInputModalities([])).toEqual(['text']);
    expect(filterInputModalities(undefined)).toEqual(['text']);
    expect(filterInputModalities(['image'])).toEqual(['text', 'image']);
  });

  it('audio 是合法值，予以保留', () => {
    expect(filterInputModalities(['text', 'audio'])).toEqual(['text', 'audio']);
  });

  it('去重且只输出白名单内的值', () => {
    const result = filterInputModalities(['text', 'image', 'image', 'weird']);
    expect(result).toEqual(['text', 'image']);
    for (const item of result) expect(CODEX_INPUT_MODALITIES).toContain(item);
  });
});

describe('索引与查找', () => {
  it('命中唯一一条时返回', () => {
    const index = buildRegistryIndex({
      'deepseek/deepseek-v4.1-flash': { limit: { context: 1_000_000 } },
    });
    expect(lookup(index, 'deepseek-v4.1-flash')).toEqual({ contextWindow: 1_000_000 });
  });

  it('未收录返回 undefined', () => {
    const index = buildRegistryIndex({ 'openai/gpt-x': { limit: { context: 100 } } });
    expect(lookup(index, 'glm-5.3-flashx')).toBeUndefined();
  });

  it('归一化后多候选时放弃，不随便挑一条', () => {
    // 挑错会给出别家模型的窗口，比"不知道"更糟
    const index = buildRegistryIndex({
      'a/dup-model': { limit: { context: 100 } },
      'b/dup.model': { limit: { context: 200 } },
    });
    expect(lookup(index, 'dup-model')).toBeUndefined();
  });

  it('结构不符时返回 null，不抛异常', () => {
    expect(buildRegistryIndex(null)).toBeNull();
    expect(buildRegistryIndex([])).toBeNull();
    expect(buildRegistryIndex('nope')).toBeNull();
  });
});
