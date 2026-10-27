/**
 * 上游协议类型：一家供应商只服务与它同协议的那条网关路径。
 *
 * - openai     : /v1/chat/completions（Chat Completions 形态）
 * - anthropic  : /v1/messages
 * - responses  : /v1/responses（OpenAI Responses API，Codex 原生使用）
 *
 * 三条路径都严格匹配，默认不做协议转换、不匹配一律 501（唯一例外是显式开启的
 * `protocolConversion`：`/v1/responses → openai` 由 gateway/convert 转换）。
 * 之所以不能放宽成"直通"：
 * 那会把 Responses 请求发给只支持 Chat 的上游，客户端只会收到上游的参数错误，
 * 完全看不出是选错了供应商——这条被真实问题踩过。
 */
export type ApiType = 'openai' | 'anthropic' | 'responses';

/**
 * 服务端协议枚举的唯一来源：路由层入参校验与 ProviderService 校验都从这里取，
 * 新增协议只改这一处；两侧各硬编码一份的旧写法在加 responses 时就被漏改过。
 */
export const API_TYPES: readonly ApiType[] = ['openai', 'anthropic', 'responses'];

/**
 * 报错文案用的可读名称，统一成「<厂商> 兼容（<API 形态>）」：括号里才是决定路由的
 * API 形态，只说"OpenAI 兼容"会让用户以为这家一定能走 /v1/chat/completions。
 * 与前端 web/src/lib/labels.ts 的 API_TYPE_META 口径一致，避免同一协议两处叫法不同。
 */
export function apiTypeLabel(apiType: ApiType): string {
  if (apiType === 'openai') return 'OpenAI 兼容（Chat Completions）';
  if (apiType === 'anthropic') return 'Anthropic 兼容（Messages）';
  return 'OpenAI 兼容（Responses）';
}

/**
 * Codex 的 `InputModality` 只认这三个值（已核 ref/codex 的 openai_models.rs）。
 *
 * **这是一条安全边界，不是文案选择。** 多写一个值（如 models.dev 里常见的 `pdf`、
 * `video`）会让 Codex 在解析 `model_catalog_json` 时报
 * `unknown variant ... expected one of text, image, audio`，然后**静默回退到内置的
 * 官方模型列表** —— 用户的 /model 里会冒出 GPT-6.x，且终端里看不到任何提示
 * （已做 A/B 实测：只差一个 pdf，目录就从"我们的 11 条"变成"官方内置列表"）。
 */
export const CODEX_INPUT_MODALITIES: readonly string[] = ['text', 'image', 'audio'];

/**
 * 过滤出 Codex 认识的输入模态。
 *
 * `text` 恒定保留：任何对话模型至少要能收文本，缺了它 Codex 的输入组装会异常。
 * 未知值一律丢弃而不是透传 —— 见上面那条边界说明。
 */
export function filterInputModalities(raw: unknown): string[] {
  const out: string[] = ['text'];
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim().toLowerCase();
    if (CODEX_INPUT_MODALITIES.includes(value) && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/**
 * Codex 认识的推理档位，**按强度从弱到强排列**。
 *
 * 顺序很重要，不能随便换：Codex 在遇到"当前档位不在列表里"时会静默取
 * `supported_reasoning_levels[len-1 / 2]`（见 core/src/session/turn_context.rs）。
 * 若我们乱序写入，那个"中间档"就不再是 medium，用户配的 high 可能被悄悄降成 low。
 * 按强度排序能让 fallback 落在语义上的中间位置。
 *
 * 与 `InputModality` 不同，这个列表**不是硬边界**：Codex 对未知 effort 值会解析成
 * `ReasoningEffort::Custom(String)` 而不是报错（见 openai_models.rs 的 FromStr）。
 * 但仍然只放行已知值——写 `Custom` 进去等于把一个拼错的档位展示给用户。
 */
export const CODEX_REASONING_EFFORTS: readonly string[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
  'persistent',
];

/**
 * 过滤并排序推理档位：只保留 Codex 认识的值，按强度升序、去重。
 *
 * 空数组返回空数组（调用方据此区分"明确无档位"与"未知"）。
 */
export function filterReasoningEfforts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim().toLowerCase();
    if (CODEX_REASONING_EFFORTS.includes(value)) seen.add(value);
  }
  // 按白名单的定义顺序输出，而不是保留输入顺序
  return CODEX_REASONING_EFFORTS.filter((effort) => seen.has(effort));
}

/**
 * 单个模型的能力。
 *
 * 为什么需要它：Codex 的模型目录里 `context_window` 是**真正被读取**的字段，
 * 它据此算可用上下文与自动压缩阈值。写死一个保守值（128k）虽然不会报错，
 * 但会让 1M 上下文的上游只用到十分之一 —— 客户端在 ~121k token 就自动压缩，
 * 用户会觉得"模型明明支持更长却总是失忆"。
 *
 * 数据来源有四级（优先级从高到低，见 `services/providers.ts` 的 mergeCapabilities）：
 * 1. 上游 `/models` 的 `metadata`（最贴近这个中转的实际额度）
 * 2. modelinfo.dev（权威直给档位，但覆盖不全）
 * 3. models.dev（覆盖全，但档位要按 provider 投票）
 * 4. 目录生成时的代码默认值
 *
 * 任何一级都取不到时**不写**该字段，而不是猜一个大数：猜大了 Codex 会把上下文
 * 塞爆，上游直接报超限，比"用不满"更难排查。
 */
export interface ModelCapability {
  /** 上下文窗口（token 数） */
  contextWindow?: number;
  /** 单次输出上限（token 数） */
  maxOutputTokens?: number;
  /** 是否支持推理档位；false 时目录里不写 supported_reasoning_levels */
  supportsReasoning?: boolean;
  /**
   * 该模型可用的推理档位，已过白名单并按强度升序。
   *
   * **空数组与 undefined 语义不同，不能合并**：
   * - `undefined`：不知道（没查过，或两个数据源都没给）→ 目录回落三档默认值
   * - `[]`：查过但没有可用档位 → 目录写空数组（Codex 会隐藏推理菜单）
   *
   * 反过来说，"数据源返回空数组"不等于"模型没有档位"，而是"支持推理但没列出档位"
   * （modelinfo.dev 有 221 条是这种）。这种情况在合并时要**继续问下一个来源**，
   * 而不是直接当成 `[]` 落盘。
   */
  reasoningEfforts?: string[];
  /** Codex 认得的输入模态（已过白名单，只会是 text/image/audio） */
  inputModalities?: string[];
}

/** 落盘形态：apiKey 存的是 SecretCodec 编码后的字符串。 */
export interface ProviderRecord {
  id: string;
  tenantId: string;
  name: string;
  /** 出现在聚合别名里的稳定短名，租户内唯一 */
  providerKey: string;
  /** 决定这条上游只接哪条网关路径；改协议等于换上游，不能当展示字段看待 */
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /**
   * 按模型名记录的上游能力，键必须在 `models` 里。
   *
   * 可选且缺省为空：老数据没有这个字段，读出来当作"未知"，目录回落保守默认值。
   * 只在向上游拉取模型列表时自动填充，也允许调用方显式传入覆盖。
   */
  modelCapabilities?: Record<string, ModelCapability>;
  enabled: boolean;
  /** 数值小的优先；相同优先级按创建顺序 */
  priority: number;
  notes?: string;
  websiteUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTest?: ProviderTestResult;
}

export interface ProviderTestResult {
  at: string;
  ok: boolean;
  latencyMs: number;
  status?: number;
  models?: string[];
  error?: string;
}

/** 接口返回形态：apiKey 脱敏。 */
export interface ProviderView extends Omit<ProviderRecord, 'apiKey' | 'tenantId'> {
  apiKeyMasked: string;
  apiKeyTail: string;
  hasApiKey: boolean;
}

export interface ProvidersData {
  providers: ProviderRecord[];
}

export function maskApiKey(apiKey: string): { masked: string; tail: string } {
  if (!apiKey) return { masked: '', tail: '' };
  const tail = apiKey.slice(-4);
  if (apiKey.length <= 8) return { masked: '*'.repeat(apiKey.length), tail };
  return { masked: `${apiKey.slice(0, 3)}${'*'.repeat(8)}${tail}`, tail };
}

export function toProviderView(record: ProviderRecord, plainApiKey: string): ProviderView {
  const { apiKey: _apiKey, tenantId: _tenantId, ...rest } = record;
  const { masked, tail } = maskApiKey(plainApiKey);
  return {
    ...rest,
    apiKeyMasked: masked,
    apiKeyTail: tail,
    hasApiKey: plainApiKey.length > 0,
  };
}

/** 从名称派生 providerKey：只保留小写字母数字，允许内部连字符。 */
export function slugifyProviderKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'provider';
}

/**
 * 生成租户内唯一的 providerKey。重名时追加 -2、-3……，
 * 保证别名 `lam-<key>/<model>` 长期稳定可解析。
 */
export function allocateProviderKey(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const base = slugifyProviderKey(name);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}
