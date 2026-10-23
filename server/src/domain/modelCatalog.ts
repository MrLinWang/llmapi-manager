import type { ModelAlias } from './aliases';

/**
 * Codex CLI 的模型目录格式（ConfigToml 的 `model_catalog_json` 与
 * ModelProviderInfo 的 `model_catalog_url` 用的是同一套数据结构）。
 *
 * 两者都要求 `{ models: [ModelInfo, ...] }`，与 OpenAI 风格的
 * `{ object: "list", data: [{ id }] }` **不是**一回事：后者会被判为解码失败
 * （`failed to decode models response`）。我们下发的是 `model_catalog_json`
 * 指向的本地静态目录，所以这里必须生成 Codex 认的原生结构。
 *
 * 字段口径按 `codex debug models` 导出的官方目录对齐——那是 Codex 自己渲染
 * catalog 的入口，比照着报错逐字段猜更可靠。其中两个容易踩的点：
 *
 * 1. `supported_reasoning_levels` 是**对象数组**（`{ effort, description }`），
 *    不是字符串数组——写 `["low","medium"]` 会报 invalid type。
 * 2. 每个模型必须提供 `base_instructions` 或 `model_messages.instructions_template`
 *    之一，否则报 `is missing both ...`。这里写一段简短的中文说明，
 *    而不是复制 Codex 官方的 21KB 系统提示词：那些提示词描述的是官方模型的
 *    行为约定，套到第三方上游上并不成立，也会让目录文件膨胀到几十 KB。
 */
export interface CodexReasoningLevel {
  effort: string;
  description: string;
}

export interface CodexCatalogEntry {
  slug: string;
  /** 我们生成的目录里恒等于 slug：/model 列表直接渲染它，必须与写进 config.toml 的 model 是同一个字符串 */
  display_name: string;
  /** 来源说明（`供应商 提供的 上游模型`），允许与 display_name 不同；/model 列表作为条目上的次要文字展示 */
  description: string;
  priority: number;
  visibility: string;
  supported_in_api: boolean;
  context_window: number;
  /**
   * 注意：Codex 的 ModelInfo 并没有这个字段（已核 ref/codex 的 openai_models.rs），
   * 写进去会被 serde 当未知字段忽略。保留它只是让目录文件对人自解释，
   * 不要指望它影响 Codex 的行为。
   */
  max_output_tokens: number;
  default_reasoning_level: string;
  supported_reasoning_levels: CodexReasoningLevel[];
  shell_type: string;
  truncation_policy: { mode: string; limit: number };
  support_verbosity: boolean;
  experimental_supported_tools: string[];
  /** 二者至少提供一个，否则 Codex 拒绝加载目录 */
  base_instructions: string;
}

export interface CodexCatalog {
  models: CodexCatalogEntry[];
}

/**
 * 无法确知上游模型的真实上限时使用的保守值。
 * 128k 是当前主流模型的常见下限，取它不会让客户端高估上下文
 * （context_window 是 Codex 真正读取的字段，见下面 max_output_tokens 的说明）。
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 只为了让目录文件自解释；Codex 的 ModelInfo 没有这个字段，见 CodexCatalogEntry 上的注释。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/**
 * 给聚合模型用的固定指令。
 * 不用 Codex 官方那套（描述的是官方模型的行为约定），只说明"你是一个编码助手"。
 */
const AGGREGATE_INSTRUCTIONS =
  'You are a coding assistant served through LLM API Manager, an aggregated gateway. ' +
  'Follow the user instructions and use the available tools when they help.';

const REASONING_LEVELS: CodexReasoningLevel[] = [
  { effort: 'low', description: '快速响应，推理较轻' },
  { effort: 'medium', description: '速度与推理深度均衡' },
  { effort: 'high', description: '更深的推理，适合复杂问题' },
];

export interface BuildCatalogOptions {
  /** 当前选中的默认模型，排在最前面 */
  preferredClientModel?: string;
}

/**
 * 由聚合别名生成 Codex 模型目录。
 *
 * slug 必须与网关能解析的模型名完全一致（`lam-<key>/<model>`），
 * 否则 Codex 选中后发来的请求会被网关判为未知别名。
 */
export function buildModelCatalog(
  aliases: readonly ModelAlias[],
  options: BuildCatalogOptions,
): string {
  const entries: CodexCatalogEntry[] = [];
  const seen = new Set<string>();

  const push = (alias: ModelAlias): void => {
    if (seen.has(alias.alias)) return;
    seen.add(alias.alias);
    entries.push({
      slug: alias.alias,
      // display_name 直接用别名本身（= slug），不再另拼一个「供应商 + 模型」的人类可读名：
      // Codex 的 /model 列表渲染的就是这个字段，两者一致后，列表里看到的
      // 与写进 config.toml 的 model 是同一个字符串，不会出现对不上号的情况。
      display_name: alias.alias,
      // description 仍是给人看的来源说明，与 display_name 不要求一致；
      // /model 列表把它作为条目上的次要文字展示，用来补充"来自哪家、哪个上游模型"。
      description: `${alias.providerName} 提供的 ${alias.upstreamModel}`,
      priority: entries.length + 1,
      visibility: 'list',
      supported_in_api: true,
      context_window: DEFAULT_CONTEXT_WINDOW,
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: REASONING_LEVELS,
      shell_type: 'default',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      support_verbosity: false,
      experimental_supported_tools: [],
      base_instructions: AGGREGATE_INSTRUCTIONS,
    });
  };

  // 默认模型排最前，其余按别名顺序
  if (options.preferredClientModel) {
    const preferred = aliases.find((item) => item.alias === options.preferredClientModel);
    if (preferred) push(preferred);
  }
  for (const alias of aliases) push(alias);

  const catalog: CodexCatalog = { models: entries };
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
