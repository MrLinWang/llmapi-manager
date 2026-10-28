import type { ModelAlias } from './aliases';
import { filterInputModalities, type ModelCapability } from './provider';
import type { UiLanguage } from './settings';
import { translate } from '../i18n';

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
  /**
   * 允许通过 `model_context_window` 配置覆盖到的上限（`ModelInfo.max_context_window`）。
   *
   * 不写时 Codex 不设上限；与 `context_window` 保持一致，用户把窗口配大也不会
   * 超过上游声明的真实值。窗口未知时两者都用保守默认值。
   */
  max_context_window: number;
  /**
   * 自动压缩阈值（`ModelInfo::auto_compact_token_limit`）。
   *
   * 写的是上下文窗口的 90% —— 与 Codex 不写该字段时的推导（`context * 9 / 10`）完全一致，
   * 属于"把隐含默认值显式化"，不改变行为。
   */
  auto_compact_token_limit: number;
  /**
   * 推理摘要的默认档位（`ModelInfo.default_reasoning_summary`）。
   *
   * 写 `auto`（= Codex 的缺省值）而不是 `none`：我们的目录同时覆盖官方 GPT 模型
   * （同一个聚合上游），写 `none` 会让这些模型默认不再请求 reasoning summary，
   * 终端里就看不到思考过程。cc-switch 对纯第三方模板写 `none`，那是它的目录只服务
   * 第三方模型的取舍；两边前提不同，不要照抄。
   */
  default_reasoning_summary: string;
  /** 可用上下文里有多少比例可用于输入（Codex 默认 95）。 */
  effective_context_window_percent: number;
  /**
   * 官方账号才有的"速度档 / 服务档 / 升级提示"（`ModelInfo.additional_speed_tiers` 等）。
   * 第三方聚合上游没有这些权益，显式清空，避免从官方目录模板继承下来。
   */
  additional_speed_tiers: string[];
  service_tiers: unknown[];
  availability_nux: null;
  upgrade: null;
  /** 是否支持把图片以 `original` 精度回传给上游（默认 false；未知时不要宣称支持）。 */
  supports_image_detail_original: boolean;
  /**
   * 是否支持 Responses 的托管搜索工具 / 工具检索（`ModelInfo.supports_search_tool`）。
   *
   * 第三方上游多数接不了 `web_search` 托管工具（会 400 `unsupported tool type`），
   * 所以恒为 false；联网搜索是否可用由设置项决定（写 `web_search = "disabled"` 或删除），
   * 不要在目录里替用户打开它。
   */
  supports_search_tool: boolean;
  /**
   * 旧版 Codex 解析器要求、但当前 ModelInfo 已没有的键（0.164 的 serde 会当未知字段忽略）。
   *
   * 保留是为了兼容旧客户端：cc-switch 记录过 codex 0.148 缺少 `supports_reasoning_summaries`
   * 会直接拒绝整份目录（见 ref/cc-switch 的 `CODEX_CATALOG_PARSER_REQUIRED_FIELDS`）。
   * 新版本忽略它们，写成保守值（false/true）不影响行为。
   */
  supports_parallel_tool_calls: boolean;
  supports_reasoning_summaries: boolean;
  default_reasoning_level: string;
  supported_reasoning_levels: CodexReasoningLevel[];
  /**
   * 该模型接受的输入模态。
   *
   * **只能出现 text / image / audio**（Codex 的 InputModality 枚举）。
   * 多一个值（如 models.dev 里常见的 pdf / video）会让 Codex 报
   * `unknown variant ...` 并**静默回退到内置官方模型列表**——终端里看不到提示，
   * 用户只会发现 /model 里冒出 GPT-6.x。已做 A/B 实测，务必只写白名单值。
   */
  input_modalities: string[];
  shell_type: string;
  truncation_policy: { mode: string; limit: number };
  support_verbosity: boolean;
  experimental_supported_tools: string[];
  /** 二者至少提供一个，否则 Codex 拒绝加载目录 */
  base_instructions: string;
  /**
   * 刻意不写的字段（与 cc-switch 给第三方供应商用的模板一致）：
   *
   * - `apply_patch_tool_type`：写任意非 null 值都会让 Codex 启用 freeform
   *   apply_patch 工具（见 ref/codex `core/src/tools/spec_plan.rs` 里的
   *   `model_info.apply_patch_tool_type.is_some()`）。freeform 补丁格式是官方模型
   *   配合官方提示词一起训出来的；我们的 `base_instructions` 是一段中立的短说明，
   *   打开它只会把模型不会用的工具塞过去。cc-switch 对没有官方目录的第三方供应商
   *   同样不写（注释原话："no freeform apply_patch"）。
   * - `model_messages` / `tool_mode` / `multi_agent_version` / `multi_agent_reasoning_effort`
   *   / `web_search_tool_type` / `include_*_usage_instructions`：官方 harness 的
   *   提示词与工具编排，套到第三方上游不成立。需要时按模型能力单独评估，不要整段照搬官方目录。
   */
}

export interface CodexCatalog {
  models: CodexCatalogEntry[];
}

/**
 * 无法确知上游模型的真实上限时使用的保守值。
 * 128k 是当前主流模型的常见下限，取它不会让客户端高估上下文
 * （context_window 是 Codex 真正读取的字段，见下面 max_output_tokens 的说明）。
 *
 * 已知真实上限时**一定要用它覆盖默认值**：写死 128k 会让 1M 上下文的上游
 * 只用到约十分之一（Codex 在 95% 处自动压缩），用户只会看到"总是提前失忆"。
 * 真实值来自供应商记录里的 `modelCapabilities`（拉取模型列表时解析并落盘）。
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 只为了让目录文件自解释；Codex 的 ModelInfo 没有这个字段，见 CodexCatalogEntry 上的注释。 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
/**
 * Codex 的 `ModelInfo.effective_context_window_percent` 缺省值（`default_effective_context_window_percent`）。
 * 显式写出来让目录自解释；改这个值会真实改变可用输入预算，不是"补字段"。
 */
const DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT = 95;

/**
 * 自动压缩阈值：与 Codex 在目录未提供该字段时的推导一致（`context_window * 9 / 10`）。
 *
 * 之所以显式写：目录是给人看也给人核对的，把"90% 处压缩"这条隐含规则写出来，
 * 用户调整上下文窗口时能直接看到阈值跟着变（`ModelInfo::auto_compact_token_limit`
 * 还会再夹一次 90%，所以这里写上不会越界）。
 */
function autoCompactTokenLimit(contextWindow: number): number {
  return Math.floor((contextWindow * 9) / 10);
}

/**
 * 没有模态信息时的默认值，与 Codex 的 `default_input_modalities()` 保持一致。
 *
 * 对齐它很重要：Codex 用 `input_modalities.contains(Image)` 决定 view_image /
 * 附图是否可用。前端这份目录一旦只写 text，这些能力就被静默关掉了。
 */
const DEFAULT_INPUT_MODALITIES: string[] = ['text', 'image'];

/**
 * 给聚合模型用的固定指令。
 * 不用 Codex 官方那套（描述的是官方模型的行为约定），只说明"你是一个编码助手"。
 */
const AGGREGATE_INSTRUCTIONS =
  'You are a coding assistant served through LLM API Manager, an aggregated gateway. ' +
  'Follow the user instructions and use the available tools when they help.';

/**
 * 每个档位的说明文案键。Codex 的模型选择弹窗会把这些作为条目的次要文字展示。
 *
 * 存键而不是成品字符串：目录内容要按请求语言生成（调用方传 `language`），
 * 而这里是模块级常量表，渲染发生在 `buildCatalogEntries` 里。
 *
 * 覆盖 `CODEX_REASONING_EFFORTS` 的全部取值；表中没有的（理论上不会有，
 * 因为白名单已经过滤过）用 effort 原文兜底，保证不会渲染出 undefined 或键名。
 */
const EFFORT_DESCRIPTION_KEYS: Record<string, string> = {
  none: 'agents.reasoning.none',
  minimal: 'agents.reasoning.minimal',
  low: 'agents.reasoning.low',
  medium: 'agents.reasoning.medium',
  high: 'agents.reasoning.high',
  xhigh: 'agents.reasoning.xhigh',
  max: 'agents.reasoning.max',
  ultra: 'agents.reasoning.ultra',
  persistent: 'agents.reasoning.persistent',
};

/**
 * 渲染一个档位的说明；字典里没登记的档位用 effort 原文兜底（不渲染出键名）。
 *
 * 为什么宁可显示英文档位名也不显示键名：`translate` 缺键时返回的是键名本身，
 * 而这段文字会被**写进用户的模型目录文件**。目录里出现 `agents.reasoning.xhigh`
 * 是一条明显的程序 bug 落进了用户配置；而显示 `xhigh` 只是"少翻了一档"，
 * 用户仍能看懂、功能也不受影响。两种错的代价不对称，所以这里选择兜底。
 */
function effortDescription(language: UiLanguage, effort: string): string {
  const key = EFFORT_DESCRIPTION_KEYS[effort];
  return key === undefined ? effort : translate(language, key);
}

/** 未知档位永远不写：三档保守默认，避免把猜出来的值写进用户的客户端。 */
function defaultReasoningLevels(language: UiLanguage): CodexReasoningLevel[] {
  return [
    { effort: 'low', description: effortDescription(language, 'low') },
    { effort: 'medium', description: effortDescription(language, 'medium') },
    { effort: 'high', description: effortDescription(language, 'high') },
  ];
}

/** 把档位字符串数组转成 Codex 要的对象数组，并补上描述。 */
function toReasoningLevels(
  efforts: readonly string[],
  language: UiLanguage,
): CodexReasoningLevel[] {
  return efforts.map((effort) => ({
    effort,
    description: effortDescription(language, effort),
  }));
}

/**
 * 选默认档位。
 *
 * 优先用户自己在 Codex 里配的那一档（`model_reasoning_effort`）——
 * 否则会出现"配置文件写 high、/model 里显示 medium"的错位。
 * 但要先确认它在本次声明的档位里：Codex 遇到不支持的当前档位会静默取
 * `len-1/2` 索引（见 turn_context.rs 的 with_model），我们主动对齐语义相同的中间档，
 * 而不是把一个必然被替换的值写进去。
 */
function pickDefaultEffort(
  effortCount: number,
  configuredEffort: string | undefined,
  efforts: readonly string[],
): string {
  if (configuredEffort && efforts.includes(configuredEffort)) return configuredEffort;
  // 与 Codex 的 fallback 索引一致：三档时取 medium，两档时取 low
  const middle = efforts[Math.floor(Math.max(effortCount - 1, 0) / 2)];
  return middle ?? 'medium';
}

export interface BuildCatalogOptions {
  /** 当前选中的默认模型，排在最前面 */
  preferredClientModel?: string;
  /**
   * 用户在 Codex 里配置的推理档位（`config.toml` 的 `model_reasoning_effort`）。
   *
   * 只影响 `default_reasoning_level` 这个"初始选中项"，不会窄化可选档位：
   * 该值不在本次声明里时退回中间档，而不是把它偷偷塞进列表。
   */
  configuredEffort?: string;
  /**
   * 上游声明的模型能力，键是**上游裸模型名**（不是别名）。
   *
   * 两种模式都用这个键：网关模式下别名指向上游裸名，直连模式下 slug 本身就是裸名。
   * 缺某个模型时该条目回落到保守默认值，不要因为一条缺失就整体放弃。
   */
  capabilities?: Record<string, ModelCapability>;
  /**
   * 目录里人读文字的渲染语言（档位说明、来源说明、审批占位名说明）。
   *
   * 缺省 `zh`：目录是写进用户客户端文件的静态内容，调用方拿不到请求语言时
   * 不应因此报错。服务端所有主动生成目录的路径（agents/service.ts）都会传它。
   */
  language?: UiLanguage;
  /**
   * 「Approve for me」的占位模型名，需要出现在目录里。
   *
   * 为什么必须放进来：Codex 在 API Key 认证下把审批模型硬编码成 `gpt-5.6-luna`，
   * 并到**模型目录**里找它（`select_review_model` 拿 `&[ModelPreset]` 做 `find`）。
   * 目录里没有这个名字时不会报错，而是**静默回退到父模型**——审批请求于是带着
   * 用户当前的对话模型发出去，网关那套"识别占位名再改写"的逻辑永远不命中。
   * 症状就是"配了审批模型但不生效"，且日志里连一条审批请求都看不到。
   *
   * 注意不能改用目录条目的 `auto_review_model_override`：`From<ModelInfo> for
   * ModelPreset` 没搬那个字段，而 `select_review_model` 收的正是 ModelPreset。
   */
  approvalPlaceholder?: string;
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
  const language = options.language ?? 'zh';
  return buildCatalogEntries(
    aliases.map((alias) => ({
      model: alias.alias,
      description: translate(language, 'agents.catalog.providedBy', {
        provider: alias.providerName,
        model: alias.upstreamModel,
      }),
      // 网关模式下能力挂在别名上（同一裸名可能被多家声明，各家上限不同）。
      // 别名自带的值优先；没有再按裸名到 capabilities 里找，兼容旧调用方。
      capability: alias.capability ?? options.capabilities?.[alias.upstreamModel],
    })),
    options,
    language,
  );
}

/**
 * 直连模式用的目录：模型名是**上游真实的裸名**，没有网关别名。
 *
 * 为什么直连也要生成目录：不给 `model_catalog_json` 时，Codex 会回退到**内置的官方
 * 模型列表**（models-manager 的 `fallback_models` → `load_remote_models_from_file`），
 * `/model` 里就变成一堆 GPT-6.x，与用户配置的供应商毫无关系。真实踩过这个坑。
 */
export function buildDirectModelCatalog(
  models: readonly string[],
  providerName: string,
  options: BuildCatalogOptions,
): string {
  const language = options.language ?? 'zh';
  return buildCatalogEntries(
    models.map((model) => ({
      model,
      description: translate(language, 'agents.catalog.providedBy', {
        provider: providerName,
        model,
      }),
      // 直连时 slug 就是上游裸名，与能力表的键一致。
      capability: options.capabilities?.[model],
    })),
    options,
    language,
  );
}

interface CatalogEntryInput {
  /** 写进 slug 的模型标识：网关模式是别名，直连模式是上游裸模型名 */
  model: string;
  description: string;
  /** 上游声明的能力；缺省表示"未知"，由 DEFAULT_* 回落 */
  capability?: ModelCapability;
}

function buildCatalogEntries(
  inputs: readonly CatalogEntryInput[],
  options: BuildCatalogOptions,
  language: UiLanguage,
): string {
  const entries: CodexCatalogEntry[] = [];
  const seen = new Set<string>();

  const push = (input: CatalogEntryInput): void => {
    if (seen.has(input.model)) return;
    seen.add(input.model);

    // 档位与默认档位先算好：默认档位依赖档位列表，不能在对象字面量里各算各的。
    const efforts = input.capability?.reasoningEfforts;
    const reasoningLevels: CodexReasoningLevel[] =
      input.capability?.supportsReasoning === false
        ? [] // 明确不支持推理：Codex 会隐藏推理菜单
        : efforts !== undefined && efforts.length > 0
          ? toReasoningLevels(efforts, language) // 查到的真实档位
          : efforts !== undefined
            ? [] // 查过但没有可用档位（空数组是"明确无"的语义）
            : defaultReasoningLevels(language); // 未知：保守三档
    const defaultEffort =
      reasoningLevels.length === 0
        ? 'medium'
        : pickDefaultEffort(
            reasoningLevels.length,
            options.configuredEffort,
            reasoningLevels.map((level) => level.effort),
          );

    // 窗口只算一次：max_context_window 与自动压缩阈值都由它派生，避免三处各写一份回落逻辑。
    const contextWindow = input.capability?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

    entries.push({
      slug: input.model,
      // display_name 直接用别名本身（= slug），不再另拼一个「供应商 + 模型」的人类可读名：
      // Codex 的 /model 列表渲染的就是这个字段，两者一致后，列表里看到的
      // 与写进 config.toml 的 model 是同一个字符串，不会出现对不上号的情况。
      display_name: input.model,
      // description 仍是给人看的来源说明，与 display_name 不要求一致；
      // /model 列表把它作为条目上的次要文字展示，用来补充"来自哪家、哪个上游模型"。
      description: input.description,
      priority: entries.length + 1,
      visibility: 'list',
      supported_in_api: true,
      // 有上游声明的真实值就用它，否则回落保守默认值。逐字段判断：
      // 有的上游只给了上下文没给输出上限，不该因为缺一个字段就两个都退回默认。
      context_window: contextWindow,
      // 配置覆盖上限与窗口保持一致：Codex 会用它 clamp `model_context_window`，
      // 不写就看不出"这个模型最多能开到多大"。
      max_context_window: contextWindow,
      // 与 Codex 的缺省推导一致（90%），只是把隐含规则写进目录，不改变压缩时机。
      auto_compact_token_limit: autoCompactTokenLimit(contextWindow),
      max_output_tokens: input.capability?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // 明确声明不支持推理时给空数组（Codex 允许空，表示这个模型没有推理档位）。
      // 未知（undefined）仍给三档：绝大多数上游模型支持 effort 参数，
      // 而写空会让用户在 /model 里看不到推理强度选项。
      //
      // 声明了具体档位时以它为准（来自 modelinfo.dev / models.dev，按模型不同），
      // 不再所有模型共用一套 low/medium/high。
      supported_reasoning_levels: reasoningLevels,
      default_reasoning_level: defaultEffort,
      // Codex 的默认值。不写 none：目录里同时有官方 GPT 模型（同一个聚合上游），
      // 写 none 会让它们默认不再返回 reasoning summary，思考过程直接看不见。
      default_reasoning_summary: 'auto',
      effective_context_window_percent: DEFAULT_EFFECTIVE_CONTEXT_WINDOW_PERCENT,
      // 走白名单，绝不透传 pdf / video（会让整份目录失效，见 CodexCatalogEntry 注释）。
      //
      // 没有模态信息时用 Codex 自己的默认值 text+image，而不是只给 text：
      // Codex 的 `default_input_modalities()` 就是 [text, image]，而 view_image
      // 工具靠 `input_modalities.contains(Image)` 开门（见 core/src/tools/handlers/
      // view_image.rs）。未知时只写 text 会让所有未收录模型的看图能力被静默关掉。
      input_modalities:
        input.capability?.inputModalities === undefined
          ? DEFAULT_INPUT_MODALITIES
          : filterInputModalities(input.capability.inputModalities),
      shell_type: 'default',
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      support_verbosity: false,
      // 官方账号权益（速度档/服务档/升级提示）与第三方聚合上游无关，显式清空，
      // 避免将来有人整段照搬官方目录时把它们一起带进来。
      additional_speed_tiers: [],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      // 两项都是 Codex 的默认值：不宣称 original 图片精度、不宣称托管搜索工具能力。
      supports_image_detail_original: false,
      supports_search_tool: false,
      // 旧版解析器要求的兼容键，新版本当作未知字段忽略（原因见 CodexCatalogEntry 注释）。
      supports_parallel_tool_calls: false,
      supports_reasoning_summaries: true,
      experimental_supported_tools: [],
      base_instructions: AGGREGATE_INSTRUCTIONS,
    });
  };

  // 默认模型排最前，其余按原顺序
  if (options.preferredClientModel) {
    const preferred = inputs.find((item) => item.model === options.preferredClientModel);
    if (preferred) push(preferred);
  }
  for (const input of inputs) push(input);

  // 审批占位名必须真的出现在目录里（原因见 BuildCatalogOptions.approvalPlaceholder）。
  // 放在最后并单独 push，不参与"默认模型排最前"的排序——它不是给用户日常选的模型，
  // 只是让 Codex 的 select_review_model 能找到它，从而让它把真实的模型名发出来。
  if (options.approvalPlaceholder) {
    push({
      model: options.approvalPlaceholder,
      description: translate(language, 'agents.catalog.approvalPlaceholder'),
    });
  }

  const catalog: CodexCatalog = { models: entries };
  return `${JSON.stringify(catalog, null, 2)}\n`;
}
