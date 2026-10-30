/**
 * Agent 配置下发（JSON/TOML 保值补丁 + 模型目录生成 + 应用/还原）的测试。
 *
 * 共同前提：我们写的是**用户自己的配置文件**，写坏了用户可能直接开不了工。
 * 所以这里绝大多数用例都在守同一条底线——只动我们拥有的键、其余原样保留，
 * 解析失败宁可报错也不能覆盖成空文件。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAgentWrites,
  applyJsonWrites,
  buildPreviewEntries,
  isEmptyDocument,
  revertAgentWrites,
  type DesiredWrites,
} from '../src/agents/patch';
import { buildModelCatalog } from '../src/domain/modelCatalog';
import { applyTomlEdits, readTomlScalar, removeTomlKeyIfValue } from '../src/agents/toml';
import { AGENT_DEFINITIONS } from '../src/agents/registry';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmapi-agent-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('JSON 补丁', () => {
  it('只改目标键，保留其他内容', () => {
    const original = JSON.stringify(
      {
        permissions: { allow: ['Bash'] },
        env: { KEEP_ME: 'yes', ANTHROPIC_MODEL: 'old' },
      },
      null,
      2,
    );
    const next = applyJsonWrites(original, [
      { path: 'env.ANTHROPIC_BASE_URL', value: 'http://127.0.0.1:8787' },
      { path: 'env.ANTHROPIC_MODEL', value: 'lam-alpha/gpt-x' },
    ]);
    const parsed = JSON.parse(next);
    expect(parsed.permissions).toEqual({ allow: ['Bash'] });
    expect(parsed.env.KEEP_ME).toBe('yes');
    expect(parsed.env.ANTHROPIC_MODEL).toBe('lam-alpha/gpt-x');
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787');
  });

  it('同名非对象值时报错而不是覆盖', () => {
    expect(() =>
      applyJsonWrites(JSON.stringify({ env: 'not-an-object' }), [
        { path: 'env.ANTHROPIC_MODEL', value: 'x' },
      ]),
    ).toThrow(/not an object/);
  });

  it('原文件损坏时抛错，不写空文件', () => {
    // 这条守的是最危险的一种"看似容错"的写法：解析失败就当成空文件继续写。
    // 那样用户的整个 Claude Code 配置会被一个 {} 覆盖掉，且无法恢复。
    expect(() => applyJsonWrites('{ broken', [{ path: 'a', value: 'b' }])).toThrow();
  });
});

describe('UTF-8 BOM 兼容', () => {
  // Windows 记事本旧版 / PowerShell `Out-File` 默认会给文件加 BOM。
  // 不剥 BOM 的后果分两级：JSON.parse 直接抛错（配置压根读不出来）；
  // TOML 首行键匹配不到（看起来"解析成功"，其实把我们自己的键写重复了）。
  // 最糟的是"解析失败就当成空文件"——那会把用户整份配置覆盖掉。

  it('JSON：带 BOM 也能读取当前值、改写后输出不带 BOM', () => {
    const withBom = `\uFEFF${JSON.stringify({ env: { ANTHROPIC_MODEL: 'old', KEEP: '1' } }, null, 2)}`;
    const next = applyJsonWrites(withBom, [
      { path: 'env.ANTHROPIC_MODEL', value: 'lam-a/gpt-x' },
    ]);
    expect(next.charCodeAt(0)).not.toBe(0xfeff);
    const parsed = JSON.parse(next) as {
      env: { ANTHROPIC_MODEL: string; KEEP: string };
    };
    expect(parsed.env.ANTHROPIC_MODEL).toBe('lam-a/gpt-x');
    expect(parsed.env.KEEP).toBe('1');
  });

  it('JSON：预览能读到带 BOM 文件的当前值（否则差异永远显示为空）', () => {
    const withBom = `\uFEFF${JSON.stringify({ env: { ANTHROPIC_MODEL: 'old' } })}`;
    const entries = buildPreviewEntries(AGENT_DEFINITIONS['claude-code'], 'config', withBom, [
      { path: 'env.ANTHROPIC_MODEL', value: 'new' },
    ]);
    expect(entries[0].current).toBe('old');
    expect(entries[0].differs).toBe(true);
  });

  it('TOML：带 BOM 时应用/还原都保留用户其余内容，且不残留 BOM', () => {
    const dir = tempDir();
    const configPath = path.join(dir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      `\uFEFF${[
        '# 用户自己的注释',
        'model = "old"',
        '',
        '[mcp_servers.demo]',
        'command = "demo"',
        '',
      ].join('\n')}`,
    );

    const results = applyAgentWrites({
      agentId: 'codex',
      definition: AGENT_DEFINITIONS.codex,
      paths: { config: configPath, auth: undefined },
      writes: { config: [{ path: 'model', value: 'lam-a/gpt-x' }] },
    });

    const applied = fs.readFileSync(configPath, 'utf8');
    expect(applied.charCodeAt(0)).not.toBe(0xfeff);
    expect(readTomlScalar(applied, 'model')).toBe('lam-a/gpt-x');
    expect(applied).toContain('# 用户自己的注释');
    expect(applied).toContain('[mcp_servers.demo]');

    // 还原同样要能在带/不带 BOM 的内容上定位我们写入的键
    const revert = revertAgentWrites(AGENT_DEFINITIONS.codex, [
      {
        role: 'config',
        path: configPath,
        values: results[0].values,
        created: results[0].created,
      },
    ]);
    expect(revert.conflicts).toHaveLength(0);
    const after = fs.readFileSync(configPath, 'utf8');
    expect(readTomlScalar(after, 'model')).toBeNull();
    expect(after).toContain('[mcp_servers.demo]');
  });

  it('TOML：预览能读到带 BOM 文件的当前值', () => {
    const entries = buildPreviewEntries(AGENT_DEFINITIONS.codex, 'config', '\uFEFFmodel = "old"\n', [
      { path: 'model', value: 'new' },
    ]);
    expect(entries[0].current).toBe('old');
    expect(entries[0].differs).toBe(true);
  });

  it('isEmptyDocument 容忍 BOM（否则还原时会留下空壳文件）', () => {
    expect(isEmptyDocument('\uFEFF{}', 'json')).toBe(true);
    expect(isEmptyDocument('\uFEFF', 'toml')).toBe(true);
    expect(isEmptyDocument('\uFEFF# only comments\n', 'toml')).toBe(true);
    expect(isEmptyDocument('\uFEFF{"keep":1}', 'json')).toBe(false);
  });
});

describe('Agent 预览脱敏', () => {
  it('凭据类键只返回掩码，不返回完整令牌', () => {
    // 预览是只读接口，最容易"顺手"把真实值返回给前端展示。
    // 一旦漏了，完整网关令牌/上游 Key 就会经由 /preview 出接口（且会被浏览器缓存/日志记录）。
    const token = 'lam_abcdefghijklmnopqrstuvwxyz1234';
    const entries = buildPreviewEntries(AGENT_DEFINITIONS.codex, 'auth', null, [
      { path: 'OPENAI_API_KEY', value: token },
    ]);

    expect(entries[0].next).not.toBe(token);
    expect(entries[0].next).not.toContain('abcdefghij');
    expect(entries[0].next.endsWith('1234')).toBe(true);
  });

  it('普通配置值保持原样', () => {
    const entries = buildPreviewEntries(AGENT_DEFINITIONS.codex, 'config', null, [
      { path: 'model', value: 'lam-packycode/gpt-5.1' },
      {
        path: 'base_url',
        value: 'http://127.0.0.1:8787/v1',
        table: 'model_providers.llmapi',
      },
    ]);

    expect(entries[0].next).toBe('lam-packycode/gpt-5.1');
    expect(entries[1].next).toBe('http://127.0.0.1:8787/v1');
  });
});

describe('TOML 补丁', () => {
  it('只改我们拥有的键，保留其他行与注释', () => {
    const original = [
      '# 用户自己的注释',
      'model_provider = "other"',
      'model = "old"',
      '',
      '[model_providers.other]',
      'name = "Other"',
      '',
      '[mcp_servers.demo]',
      'command = "demo"',
      '',
    ].join('\n');

    const next = applyTomlEdits(original, [
      { key: 'model_provider', value: 'llmapi' },
      { key: 'model', value: 'lam-alpha/gpt-x' },
      { key: 'base_url', value: 'http://127.0.0.1:8787/v1', table: 'model_providers.llmapi' },
      { key: 'wire_api', value: 'responses', table: 'model_providers.llmapi' },
    ]);

    expect(next).toContain('# 用户自己的注释');
    expect(next).toContain('[model_providers.other]');
    expect(next).toContain('[mcp_servers.demo]');
    expect(readTomlScalar(next, 'model_provider')).toBe('llmapi');
    expect(readTomlScalar(next, 'model')).toBe('lam-alpha/gpt-x');
    expect(readTomlScalar(next, 'base_url', 'model_providers.llmapi')).toBe(
      'http://127.0.0.1:8787/v1',
    );
    expect(readTomlScalar(next, 'wire_api', 'model_providers.llmapi')).toBe('responses');
  });

  it('raw 写入布尔时输出不加引号，且读回能匹配（可还原）', () => {
    // requires_openai_auth 必须是 TOML 布尔 true。曾写成字符串 "true"，
    // Codex 会判类型不符。
    const next = applyTomlEdits('', [
      { key: 'requires_openai_auth', value: 'true', raw: true, table: 'model_providers.llmapi' },
    ]);
    expect(next).toContain('requires_openai_auth = true');
    expect(next).not.toContain('requires_openai_auth = "true"');
    // 读回的是裸文本 "true"，与快照里的值一致，还原时才能正确比对
    expect(readTomlScalar(next, 'requires_openai_auth', 'model_providers.llmapi')).toBe('true');
  });

  it('流式参数按 raw 写整数，而不是带引号的字符串', () => {
    // 这两个是 ModelProviderInfo 的 u64 字段。写成 "10" 在 TOML 里是字符串，
    // Codex 会判类型不符——与 requires_openai_auth 写布尔是同一类坑。
    const next = applyTomlEdits('', [
      { key: 'stream_max_retries', value: '10', raw: true, table: 'model_providers.llmapi' },
      { key: 'stream_idle_timeout_ms', value: '600000', raw: true, table: 'model_providers.llmapi' },
    ]);
    expect(next).toContain('stream_max_retries = 10');
    expect(next).not.toContain('stream_max_retries = "10"');
    expect(next).toContain('stream_idle_timeout_ms = 600000');
    // 读回是不带引号的裸文本，快照与还原比对才能对上
    expect(readTomlScalar(next, 'stream_max_retries', 'model_providers.llmapi')).toBe('10');
  });

  it('清空流式参数时删除已有键（不写会残留）', () => {
    // 关键场景：这两个键可能已被上一次 apply 或用户手工写进文件。
    // 只"不写"会让它留在原地 —— 界面显示未设置、文件里仍生效。
    const withKeys = applyTomlEdits('', [
      { key: 'stream_max_retries', value: '10', raw: true, table: 'model_providers.llmapi' },
      { key: 'stream_idle_timeout_ms', value: '600000', raw: true, table: 'model_providers.llmapi' },
    ]);
    expect(withKeys).toContain('stream_max_retries = 10');

    const removed = removeTomlKeyIfValue(
      withKeys,
      'stream_max_retries',
      '10',
      'model_providers.llmapi',
    );
    expect(removed.removed).toBe(true);
    expect(removed.content).not.toContain('stream_max_retries');
    // 另一个键不受影响
    expect(removed.content).toContain('stream_idle_timeout_ms = 600000');
  });

  it('用户手改过的流式参数不被删除', () => {
    // 用户把 10 改成了 3：当前值不再等于我们写入的值，必须保留并报冲突，
    // 否则一次 apply 就会抹掉用户的调整。
    const edited = applyTomlEdits('', [
      { key: 'stream_max_retries', value: '3', raw: true, table: 'model_providers.llmapi' },
    ]);
    const result = removeTomlKeyIfValue(
      edited,
      'stream_max_retries',
      '10',
      'model_providers.llmapi',
    );
    expect(result.removed).toBe(false);
    expect(result.content).toContain('stream_max_retries = 3');
    expect(result.currentValue).toBe('3');
  });

  it('非 raw 的字符串值仍然带引号', () => {
    const next = applyTomlEdits('', [
      { key: 'wire_api', value: 'responses', table: 'model_providers.llmapi' },
    ]);
    expect(next).toContain('wire_api = "responses"');  });

  it('Codex 模型目录包含 Codex 解析器要求的必填字段', () => {
    // 字段口径按 `codex debug models` 导出的官方目录对齐（不写死版本号：
    // 仓库内无法核实具体版本，且 Codex 升级可能调整 schema）。缺任一项都会导致
    // "failed to parse model_catalog_json"：
    // - supported_reasoning_levels 必须是 {effort, description} 对象数组
    // - 必须提供 base_instructions 或 model_messages.instructions_template
    const raw = buildModelCatalog(
      [
        { alias: 'lam-a/gpt-x', providerId: 'p1', providerKey: 'a', providerName: 'A', apiType: 'openai', upstreamModel: 'gpt-x' },
        { alias: 'lam-b/claude-x', providerId: 'p2', providerKey: 'b', providerName: 'B', apiType: 'anthropic', upstreamModel: 'claude-x' },
      ],
      { preferredClientModel: 'lam-b/claude-x' },
    );
    const parsed = JSON.parse(raw) as { models: Array<Record<string, unknown>> };

    expect(Array.isArray(parsed.models)).toBe(true);
    expect(parsed.models).toHaveLength(2);
    // 默认模型排第一
    expect(parsed.models[0].slug).toBe('lam-b/claude-x');
    // slug 必须与网关别名完全一致
    expect(parsed.models.map((m) => m.slug).sort()).toEqual(['lam-a/gpt-x', 'lam-b/claude-x']);

    for (const model of parsed.models) {
      // 显示名必须等于别名本身：用户在 /model 看到的、config.toml 里写的、
      // 以及复制粘贴出去的应当是同一个字符串，不能一个中文名一个 slug。
      expect(model.display_name).toBe(model.slug);
      expect(String(model.slug)).toMatch(/^lam-[a-z0-9-]+\//);
      expect(model.visibility).toBe('list');
      expect(model.supported_in_api).toBe(true);
      expect(typeof model.shell_type).toBe('string');
      expect(model.context_window).toBeGreaterThan(0);
      // max_output_tokens 不在 Codex 的 ModelInfo 里，断言它等于在为无效字段背书
      expect(typeof model.shell_type).toBe('string');
      // 关键：对象数组，不是字符串数组
      const levels = model.supported_reasoning_levels as Array<Record<string, unknown>>;
      expect(Array.isArray(levels)).toBe(true);
      expect(levels.length).toBeGreaterThan(0);
      for (const level of levels) {
        expect(typeof level.effort).toBe('string');
        expect(typeof level.description).toBe('string');
      }
      // 关键：指令字段必须非空，否则 Codex 拒绝加载
      expect(typeof model.base_instructions).toBe('string');
      expect((model.base_instructions as string).length).toBeGreaterThan(0);
      expect(model.truncation_policy).toBeTruthy();
    }
  });

  it('目录补全 ModelInfo 的可选字段，且不冒充官方 harness', () => {
    // 对照 cc-switch 给第三方供应商生成的目录（ref/cc-switch 的
    // codex_catalog_from_specs_for_row）：我们原先只写 16 个键，缺的这些在新版
    // Codex 里多数是"缺省即等价"的保守值，写出来是为了让目录自解释、
    // 并让旧版解析器也能加载。
    const raw = buildModelCatalog(
      [
        {
          alias: 'lam-a/gpt-x',
          providerId: 'p1',
          providerKey: 'a',
          providerName: 'A',
          apiType: 'responses',
          upstreamModel: 'gpt-x',
          capability: { contextWindow: 262_000 },
        },
      ],
      {},
    );
    const model = (JSON.parse(raw) as { models: Array<Record<string, unknown>> }).models[0];

    // 窗口派生字段：上限与自动压缩阈值都从 context_window 推出来
    expect(model.context_window).toBe(262_000);
    expect(model.max_context_window).toBe(262_000);
    expect(model.auto_compact_token_limit).toBe(235_800); // 262000 * 90%
    expect(model.effective_context_window_percent).toBe(95);
    expect(model.default_reasoning_summary).toBe('auto');

    // 第三方上游的保守能力声明：没有官方账号权益、也不宣称托管工具能力
    expect(model.supports_search_tool).toBe(false);
    expect(model.supports_image_detail_original).toBe(false);
    expect(model.additional_speed_tiers).toEqual([]);
    expect(model.service_tiers).toEqual([]);
    expect(model.availability_nux).toBeNull();
    expect(model.upgrade).toBeNull();

    // 旧版 Codex 解析器要求的兼容键（新版本 ModelInfo 已没有它们，会被忽略）
    expect(model.supports_parallel_tool_calls).toBe(false);
    expect(model.supports_reasoning_summaries).toBe(true);

    // 刻意不写：freeform apply_patch 需要官方提示词配套，model_messages / tool_mode /
    // multi_agent_version 属于官方 harness，套到第三方上游不成立。
    expect(model).not.toHaveProperty('apply_patch_tool_type');
    expect(model).not.toHaveProperty('model_messages');
    expect(model).not.toHaveProperty('tool_mode');
    expect(model).not.toHaveProperty('multi_agent_version');
  });

  it('窗口未知时派生字段一起回落，不会只更新其中一个', () => {
    const raw = buildModelCatalog(
      [{ alias: 'lam-a/gpt-x', providerId: 'p1', providerKey: 'a', providerName: 'A', apiType: 'responses', upstreamModel: 'gpt-x' }],
      {},
    );
    const model = (JSON.parse(raw) as {
      models: Array<{
        context_window: number;
        max_context_window: number;
        auto_compact_token_limit: number;
      }>;
    }).models[0];
    expect(model.context_window).toBe(128_000);
    expect(model.max_context_window).toBe(128_000);
    expect(model.auto_compact_token_limit).toBe(115_200);
  });

  it('默认模型不在别名里时不会凭空造条目', () => {
    const raw = buildModelCatalog(
      [{ alias: 'lam-a/gpt-x', providerId: 'p1', providerKey: 'a', providerName: 'A', apiType: 'openai', upstreamModel: 'gpt-x' }],
      { preferredClientModel: 'lam-zzz/nope' },
    );
    const parsed = JSON.parse(raw) as { models: Array<{ slug: string }> };
    expect(parsed.models.map((m) => m.slug)).toEqual(['lam-a/gpt-x']);
  });

  it('目录用上游声明的真实上下文窗口', () => {
    // 写死 128k 会让 1M 上下文的上游在 Codex 里只用到约十分之一（95% 处自动压缩）。
    // 这里固定住"有真实值就用真实值"这条行为。
    const raw = buildModelCatalog(
      [
        {
          alias: 'lam-a/gpt-x',
          providerId: 'p1',
          providerKey: 'a',
          providerName: 'A',
          apiType: 'responses',
          upstreamModel: 'gpt-x',
          capability: { contextWindow: 1_048_000, maxOutputTokens: 128_000 },
        },
      ],
      { preferredClientModel: 'lam-a/gpt-x' },
    );
    const parsed = JSON.parse(raw) as {
      models: Array<{ slug: string; context_window: number; max_output_tokens: number }>;
    };
    expect(parsed.models[0].context_window).toBe(1_048_000);
    expect(parsed.models[0].max_output_tokens).toBe(128_000);
  });

  it('没有能力数据时回落保守默认值', () => {
    // 未知时不能猜一个大数：猜大了 Codex 会把上下文塞爆，上游直接报超长，
    // 比"用不满"更难排查。
    const raw = buildModelCatalog(
      [{ alias: 'lam-a/gpt-x', providerId: 'p1', providerKey: 'a', providerName: 'A', apiType: 'responses', upstreamModel: 'gpt-x' }],
      {},
    );
    const parsed = JSON.parse(raw) as {
      models: Array<{ context_window: number; max_output_tokens: number }>;
    };
    expect(parsed.models[0].context_window).toBe(128_000);
    expect(parsed.models[0].max_output_tokens).toBe(8_192);
  });

  it('只声明上下文时仍保留真实值，输出上限单独回落', () => {
    // 逐字段回落：有的上游只给上下文不给输出上限，不该因为缺一个就两个都退回默认。
    const raw = buildModelCatalog(
      [
        {
          alias: 'lam-a/gpt-x',
          providerId: 'p1',
          providerKey: 'a',
          providerName: 'A',
          apiType: 'responses',
          upstreamModel: 'gpt-x',
          capability: { contextWindow: 262_000 },
        },
      ],
      {},
    );
    const parsed = JSON.parse(raw) as {
      models: Array<{ context_window: number; max_output_tokens: number }>;
    };
    expect(parsed.models[0].context_window).toBe(262_000);
    expect(parsed.models[0].max_output_tokens).toBe(8_192);
  });

  it('目录里的 input_modalities 永不含 pdf / video', () => {
    // 这是最容易静默失效的一处：Codex 的 InputModality 只有 text/image/audio，
    // 多写一个 pdf 会让整份目录解析失败并**静默回退到内置官方列表**
    // （实测：只差一个 pdf，/model 里就变成 GPT-6.x，终端无任何提示）。
    const raw = buildModelCatalog(
      [
        {
          alias: 'lam-a/gpt-x',
          providerId: 'p1',
          providerKey: 'a',
          providerName: 'A',
          apiType: 'responses',
          upstreamModel: 'gpt-x',
          // 故意喂进 models.dev 那种带 pdf/video 的值
          capability: { inputModalities: ['text', 'image', 'pdf', 'video'] },
        },
      ],
      {},
    );
    const parsed = JSON.parse(raw) as { models: Array<{ input_modalities: string[] }> };
    expect(parsed.models[0].input_modalities).toEqual(['text', 'image']);
    expect(parsed.models[0].input_modalities).not.toContain('pdf');
    expect(parsed.models[0].input_modalities).not.toContain('video');
  });

  it('没有模态信息时用 Codex 的默认值 text+image', () => {
    const raw = buildModelCatalog(
      [{ alias: 'lam-a/gpt-x', providerId: 'p1', providerKey: 'a', providerName: 'A', apiType: 'responses', upstreamModel: 'gpt-x' }],
      {},
    );
    const parsed = JSON.parse(raw) as { models: Array<{ input_modalities: string[] }> };
    expect(parsed.models[0].input_modalities).toEqual(['text', 'image']);
  });

  it('明确不支持推理时 reasoning 档位为空，未知时仍给三档', () => {
    // 写空数组在 Codex 里是合法的"无推理档位"；未知则保留三档，
    // 否则用户会在 /model 里看不到推理强度选项。
    const build = (supportsReasoning?: boolean): string =>
      buildModelCatalog(
        [
          {
            alias: 'lam-a/gpt-x',
            providerId: 'p1',
            providerKey: 'a',
            providerName: 'A',
            apiType: 'responses',
            upstreamModel: 'gpt-x',
            capability:
              supportsReasoning === undefined ? {} : { supportsReasoning },
          },
        ],
        {},
      );
    const noReasoning = JSON.parse(build(false)) as {
      models: Array<{ supported_reasoning_levels: unknown[] }>;
    };
    expect(noReasoning.models[0].supported_reasoning_levels).toEqual([]);

    const unknown = JSON.parse(build(undefined)) as {
      models: Array<{ supported_reasoning_levels: unknown[] }>;
    };
    expect(unknown.models[0].supported_reasoning_levels.length).toBe(3);
  });

  it('按声明的真实档位生成，不再所有模型共用一套', () => {
    // 上一版 11 个模型全是 low/medium/high；实际上各模型能力差异很大
    // （claude 支持 xhigh/max，kimi-k3 只有 low/high/max）。
    const raw = buildModelCatalog(
      [
        {
          alias: 'lam-a/claude-x',
          providerId: 'p1',
          providerKey: 'a',
          providerName: 'A',
          apiType: 'responses',
          upstreamModel: 'claude-x',
          capability: {
            supportsReasoning: true,
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        },
        {
          alias: 'lam-a/kimi-x',
          providerId: 'p1',
          providerKey: 'a',
          providerName: 'A',
          apiType: 'responses',
          upstreamModel: 'kimi-x',
          capability: { supportsReasoning: true, reasoningEfforts: ['low', 'high', 'max'] },
        },
      ],
      {},
    );
    const parsed = JSON.parse(raw) as {
      models: Array<{
        slug: string;
        supported_reasoning_levels: Array<{ effort: string; description: string }>;
      }>;
    };
    expect(parsed.models[0].supported_reasoning_levels.map((l) => l.effort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(parsed.models[1].supported_reasoning_levels.map((l) => l.effort)).toEqual([
      'low',
      'high',
      'max',
    ]);
    // 每个档位都要有非空描述，否则 /model 里会显示空白
    for (const model of parsed.models) {
      for (const level of model.supported_reasoning_levels) {
        expect(level.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('default_reasoning_level 跟随用户配置，且不会写不在列表里的值', () => {
    const build = (configuredEffort?: string): string =>
      buildModelCatalog(
        [
          {
            alias: 'lam-a/x',
            providerId: 'p1',
            providerKey: 'a',
            providerName: 'A',
            apiType: 'responses',
            upstreamModel: 'x',
            capability: { reasoningEfforts: ['low', 'medium', 'high'] },
          },
        ],
        { configuredEffort },
      );
    const pick = (raw: string): string =>
      (JSON.parse(raw) as { models: Array<{ default_reasoning_level: string }> }).models[0]
        .default_reasoning_level;

    // 配置了且列表里有 → 用它，避免"配置 high、/model 显示 medium"的错位
    expect(pick(build('high'))).toBe('high');
    // 配置了但列表里没有 → 回落中间档（与 Codex 的 len-1/2 行为一致）
    expect(pick(build('ultra'))).toBe('medium');
    // 没配置 → 中间档
    expect(pick(build(undefined))).toBe('medium');
  });

  it('空档位数组表示明确无档位，隐藏推理菜单', () => {
    const raw = buildModelCatalog(
      [
        {
          alias: 'lam-a/x',
          providerId: 'p1',
          providerKey: 'a',
          providerName: 'A',
          apiType: 'responses',
          upstreamModel: 'x',
          // 与 undefined 不同：[] 是"查过、没有可用档位"
          capability: { supportsReasoning: true, reasoningEfforts: [] },
        },
      ],
      {},
    );
    const parsed = JSON.parse(raw) as {
      models: Array<{ supported_reasoning_levels: unknown[] }>;
    };
    expect(parsed.models[0].supported_reasoning_levels).toEqual([]);
  });

  it('新建文件时也能生成完整结构', () => {
    const next = applyTomlEdits('', [
      { key: 'model_provider', value: 'llmapi' },
      { key: 'name', value: 'LLM API Manager', table: 'model_providers.llmapi' },
    ]);
    expect(readTomlScalar(next, 'model_provider')).toBe('llmapi');
    expect(readTomlScalar(next, 'name', 'model_providers.llmapi')).toBe('LLM API Manager');
  });
});

describe('Agent 应用与还原', () => {
  it('应用前备份、还原后保留用户改动', () => {
    // 一条用例覆盖三件互相依赖的事，它们拆开测会失去意义：
    // 1) 写前备份且落在同目录（数据目录丢了也能找回）
    // 2) 无关键不被动（KEEP 必须还在）
    // 3) 还原只撤销"仍等于我们写入值"的键，被手改过的保留为 conflicts
    // 若第 3 点实现成"无条件删除"，用户手改的模型名会被悄悄抹掉；
    // 若备份落到数据目录，本服务迁移/清空后就再也找不回原文件。
    const dir = tempDir();
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = JSON.stringify({ env: { KEEP: '1', ANTHROPIC_MODEL: 'old' } }, null, 2);
    fs.writeFileSync(settingsPath, original);

    const writes: Partial<Record<'config', DesiredWrites[]>> = {
      config: [
        { path: 'env.ANTHROPIC_BASE_URL', value: 'http://gw' },
        { path: 'env.ANTHROPIC_MODEL', value: 'lam-alpha/gpt-x' },
      ],
    };
    const results = applyAgentWrites({
      agentId: 'claude-code',
      definition: AGENT_DEFINITIONS['claude-code'],
      paths: { config: settingsPath, auth: undefined },
      writes,
    });

    expect(results).toHaveLength(1);
    expect(results[0].backupPath).toBeTruthy();
    expect(fs.readFileSync(results[0].backupPath as string, 'utf8')).toBe(original);
    // 备份必须与被改文件同目录，且文件名带 .bak- 前缀，方便用户原地找回
    expect(path.dirname(results[0].backupPath as string)).toBe(path.dirname(settingsPath));
    expect(path.basename(results[0].backupPath as string)).toMatch(
      /^settings\.json\.bak-\d{4}-\d{2}-\d{2}T/,
    );

    const applied = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(applied.env.KEEP).toBe('1');
    expect(applied.env.ANTHROPIC_MODEL).toBe('lam-alpha/gpt-x');

    // 用户手改了其中一个键
    applied.env.ANTHROPIC_MODEL = 'user-changed';
    fs.writeFileSync(settingsPath, JSON.stringify(applied, null, 2));

    const revert = revertAgentWrites(AGENT_DEFINITIONS['claude-code'], [
      { role: 'config', path: settingsPath, values: results[0].values },
    ]);

    expect(revert.restored).toContain('env.ANTHROPIC_BASE_URL');
    expect(revert.conflicts.map((item) => item.key)).toContain('env.ANTHROPIC_MODEL');

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(after.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(after.env.ANTHROPIC_MODEL).toBe('user-changed');
    expect(after.env.KEEP).toBe('1');
  });

  it('目标文件不存在时创建最小文件', () => {
    const dir = tempDir();
    const configPath = path.join(dir, '.codex', 'config.toml');
    const results = applyAgentWrites({
      agentId: 'codex',
      definition: AGENT_DEFINITIONS.codex,
      paths: { config: configPath, auth: undefined },
      writes: {
        config: [
          { path: 'model_provider', value: 'llmapi' },
          { path: 'model', value: 'lam-alpha/gpt-x' },
        ],
      },
    });

    expect(results[0].created).toBe(true);
    expect(results[0].backupPath).toBeNull();
    const content = fs.readFileSync(configPath, 'utf8');
    expect(readTomlScalar(content, 'model_provider')).toBe('llmapi');
  });

  it('还原时删除由我们创建且已变空的文件', () => {
    const dir = tempDir();
    const configPath = path.join(dir, '.codex', 'config.toml');
    const authPath = path.join(dir, '.codex', 'auth.json');

    const results = applyAgentWrites({
      agentId: 'codex',
      definition: AGENT_DEFINITIONS.codex,
      paths: { config: configPath, auth: authPath },
      writes: {
        config: [{ path: 'model_provider', value: 'llmapi' }],
        auth: [{ path: 'OPENAI_API_KEY', value: 'lam_token' }],
      },
    });
    expect(results.every((item) => item.created)).toBe(true);

    const revert = revertAgentWrites(
      AGENT_DEFINITIONS.codex,
      results.map((item) => ({
        role: item.role,
        path: item.filePath,
        values: item.values,
        created: item.created,
      })),
    );

    expect(revert.conflicts).toHaveLength(0);
    expect(revert.restored.length).toBeGreaterThan(0);
    // 不留空壳文件
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it('还原时保留原本就存在的文件（即使内容变空）', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, 'model_provider = "llmapi"\n');

    const results = applyAgentWrites({
      agentId: 'codex',
      definition: AGENT_DEFINITIONS.codex,
      paths: { config: configPath, auth: undefined },
      writes: { config: [{ path: 'model_provider', value: 'llmapi' }] },
    });
    expect(results[0].created).toBe(false);

    revertAgentWrites(AGENT_DEFINITIONS.codex, [
      { role: 'config', path: configPath, values: results[0].values, created: false },
    ]);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('还原 TOML 时只移除仍等于写入值的键', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        'model_provider = "llmapi"',
        'model = "lam-alpha/gpt-x"',
        '',
        '[model_providers.llmapi]',
        'base_url = "http://gw/v1"',
        '',
        '[mcp_servers.demo]',
        'command = "demo"',
        '',
      ].join('\n'),
    );

    const revert = revertAgentWrites(AGENT_DEFINITIONS.codex, [
      {
        role: 'config',
        path: configPath,
        values: {
          model_provider: 'llmapi',
          model: 'lam-alpha/gpt-x',
          '[model_providers.llmapi] base_url': 'http://gw/v1',
        },
      },
    ]);

    const after = fs.readFileSync(configPath, 'utf8');
    expect(revert.conflicts).toHaveLength(0);
    expect(readTomlScalar(after, 'model_provider')).toBeNull();
    expect(readTomlScalar(after, 'model')).toBeNull();
    expect(readTomlScalar(after, 'base_url', 'model_providers.llmapi')).toBeNull();
    // 无关配置必须留存
    expect(after).toContain('[mcp_servers.demo]');
  });
});
