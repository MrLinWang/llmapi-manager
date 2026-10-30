import type { AgentId } from './agent';
import { defaultSyncConfig, type SyncConfig } from './sync';
import { defaultNetworkingConfig, type NetworkingConfig } from './networking';

/**
 * Codex 在 API Key 认证下使用的审批模型名（`model-provider/src/provider.rs` 的
 * `API_KEY_APPROVAL_REVIEW_PREFERRED_MODEL`）。它会作为 `model` 出现在
 * 「Approve for me」触发的请求体里。
 *
 * 这是硬编码值，用户改不了：`ModelInfo.auto_review_model_override` 会被
 * `ModelInfo → ModelPreset` 的转换丢弃，`review_model` 只给 `/review` 用。
 * 走网关时把它当占位名映射到别的模型，是唯一可行的做法。
 */
export const APPROVAL_REVIEW_MODEL_NAME = 'gpt-5.6-luna';

export interface GatewayTokenMeta {
  /** 校验用：只保存 sha256 哈希 */
  tokenHash: string;
  /**
   * 下发 Agent 配置时需要用明文注入到客户端文件，因此额外保存
   * SecretCodec 编码后的密文（未配置加密密钥时等价于明文）。
   * 任何接口都不会返回它。
   */
  tokenCipher: string;
  prefix: string;
  tail: string;
  createdAt: string;
  /** 便于将来做按令牌的审计与吊销 */
  tenantId: string;
  createdBy: string;
}

/**
 * Agent 配置的连接方式。
 *
 * - `gateway`：base_url 指向本服务网关，请求经网关转发（可换供应商、有请求日志、可回退）。
 * - `direct` ：base_url 直接指向上游供应商，Key 用上游自己的 Key。
 *              配置写好后即使本服务没在运行，Codex 也能正常使用——这是它的用途。
 */
export type AgentConnectionMode = 'gateway' | 'direct';

export const AGENT_CONNECTION_MODES: readonly AgentConnectionMode[] = ['gateway', 'direct'];

/**
 * 单个 Agent 的下发偏好。
 *
 * Codex 与 Claude Code 各存一份、互不影响：两者协议不同（responses / anthropic）、
 * 用途也可能不同（比如 Codex 想直连某个官方上游、Claude Code 仍走聚合）。
 */
export interface AgentTargetPreference {
  /** 走网关还是直连上游 */
  mode: AgentConnectionMode;
  /**
   * 直连时指定用哪家供应商。
   *
   * 网关模式下这个字段不参与选路（网关有自己的默认供应商与别名解析）；
   * 直连模式必须能明确指定——否则多供应商时用户无从选择，只能被动接受
   * pickProvider 的优先级排序结果。
   */
  directProviderId: string | null;
  /** 直连时指定用哪个模型；null 表示用该供应商的第一个模型 */
  directModel: string | null;
  /**
   * 最后一次改动时间。
   *
   * 同步需要按 Agent 做三方合并与冲突判定，而 `settings.updatedAt` 是整份设置的
   * 时间，改语言这类无关设置也会让它变化——拿它当 AgentTarget 的"谁更新"依据
   * 会产生假冲突。老数据没有这个字段，读出来当作"未知"：合并时给不了更强的
   * 时间证据，就把远端当作更新（同步的目标是收敛）。
   */
  updatedAt?: string;
}

/**
 * 控制台界面语言。
 *
 * 只存 `zh` / `en` 两个值，`null` 表示"跟随浏览器"——没有显式选择过语言时，
 * 前端按 `navigator.languages` 决定，因此不把浏览器探测结果写进服务端：
 * 换一台英文系统的机器打开控制台，就该看到英文。
 *
 * **语言是界面偏好，不是安全配置**：读它只需要登录（`/api/auth/me`），
 * 改它需要 `settings:write`（与其它租户级设置一致）。
 */
export const UI_LANGUAGES = ['zh', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 把存储里的任意值收敛成合法语言。
 *
 * 读路径必须走它：`settings.json` 是手改得动的纯文本文件，写进 `"jp"` 这类
 * 未知值时，若原样返回前端，界面会退化成"显示键名"或空白。降级为 `null`
 * （跟随浏览器）比报错更合适——语言坏了不该让整个控制台打不开。
 */
export function normalizeUiLanguage(value: unknown): UiLanguage | null {
  return isUiLanguage(value) ? value : null;
}

export interface TenantSettings {
  defaultProviderId: string | null;
  defaultModel: string | null;
  /**
   * 界面语言；`null` 表示跟随浏览器（见 `UI_LANGUAGES`）。
   *
   * 它只影响前端文案，不参与网关转发与 Agent 下发，因此改完不需要重新 apply。
   */
  language: UiLanguage | null;
  /**
   * 「Approve for me」自动审批请求的模型名 → 实际要用的模型。
   *
   * Codex 在 API Key 认证下把审批模型硬编码成 `APPROVAL_REVIEW_MODEL_NAME`（`gpt-5.6-luna`），
   * 没有任何配置项能改（`ModelInfo.auto_review_model_override` 会被 `ModelInfo → ModelPreset`
   * 的转换丢弃，`review_model` 只给 `/review` 用）。但走网关时这个名字会原样出现在请求体里，
   * 于是网关可以把它当成一个"占位名"，换成用户真正想用的模型。
   *
   * null 表示不映射，按普通裸模型名处理。
   */
  approvalReviewModel: string | null;
  /**
   * 是否允许跨协议转发（目前只做 Responses → Chat）。
   *
   * 默认 false：协议不匹配继续 501，这是原有行为，变更需要用户明确同意。
   * 打开后，发往 `/v1/responses` 的请求可以落到 `openai`（Chat）供应商上，
   * 由网关双向转换请求与响应（含工具调用与流式）。
   *
   * 转换有信息损失（托管工具如 web_search 没有等价物），所以不做静默兜底：
   * 关着的时候必须让用户知道"是配置问题"，而不是收到一个被改写的结果。
   */
  protocolConversion: boolean;
  gatewayToken: GatewayTokenMeta | null;
  /**
   * 下发 Codex 配置时是否写 `web_search = "disabled"`。
   *
   * 默认关闭（true）：多数聚合上游把 Responses 请求转成 Chat 线路时不支持
   * `web_search` 这个托管工具，会直接 400 `unsupported_tool`，症状像"模型不支持"，
   * 而根因是工具而非模型。
   * 但如果供应商直连官方、支持托管工具，用户会希望保留联网搜索——所以做成开关。
   */
  disableCodexWebSearch: boolean;
  /**
   * 写进 `[model_providers.llmapi]` 的 `stream_max_retries`：流式响应被掐断后
   * Codex 最多重连几次。null 表示**不写该键**，用 Codex 内置默认的 5 次。
   *
   * 默认 10（而不是 null）：实测聚合链路会在约 60 秒无数据时被上游/反代掐断，
   * 而多数请求重试一两次就能拿到完整响应。默认 5 次时，遇到连续几次掐断就会
   * "重试耗尽 → 整轮失败"；放到 10 次能显著减少这种整轮失败。
   *
   * 注意它**不能消除重连本身**，只是提高"重连后还能继续"的概率 —— 根因在链路。
   *
   * 上限 100：Codex 内部用 `.min(MAX_STREAM_MAX_RETRIES)` 静默截断，
   * 所以超出范围必须在保存时就拒绝，否则用户以为填 200 生效了。
   */
  codexStreamMaxRetries: number | null;
  /**
   * 写进 `[model_providers.llmapi]` 的 `stream_idle_timeout_ms`：等待流式响应
   * 有活动的最长时间，超过即判定连接已死。null 表示不写，用 Codex 默认 300000（5 分钟）。
   *
   * 默认 600000（10 分钟）：放宽的是 **Codex 自己的 SSE 空闲判据**，
   * 用来覆盖"上游在长推理期间长时间不吐数据"的场景。
   * 它管不了"反代在 60 秒无数据时主动掐断"那类问题 —— 那种情况下连接已经断了，
   * 客户端等多久都没用，只能靠上面的重试次数兜住。
   */
  codexStreamIdleTimeoutMs: number | null;
  /**
   * 按 Agent 分开的下发偏好。键是 AgentId（codex / claude-code）。
   *
   * 分开存是必要的：Codex 与 Claude Code 协议不同、用途也可能不同，
   * 一个全局开关会强迫两者同步切换。
   */
  agentTargets: Partial<Record<AgentId, AgentTargetPreference>>;
  /**
   * 多设备配置同步。
   *
   * 默认 `role: 'standalone'` —— 不开启时行为与没有这个功能时完全一致。
   * 这一点很重要：升级不该让一个单机部署突然开始对外提供快照接口。
   */
  sync: SyncConfig;
  /**
   * 设备互联（EasyTier 组网）。默认关闭，见 `domain/networking.ts` 的说明。
   *
   * 注意 `networkSecret` 在这里是**加密后**的字符串（与 apiKey 同样处理）：
   * 它是网络准入门槛，明文落盘等于把加入权限交给任何能读数据目录的人。
   */
  networking: NetworkingConfig;
  updatedAt: string;
}

/**
 * 两个下发数值的允许范围。定义在这里而不是各层各写一份，
 * 是为了让路由校验、前端提示、文档三者永远不会说成不同的数。
 *
 * - `stream_max_retries` 允许 0（明确表示"不重试"，Codex 自身也有 `Some(0)` 的用例）
 * - `stream_idle_timeout_ms` 下限 1 秒（再低必然误判），上限 1 小时（再长只会掩盖故障）
 */
export const CODEX_STREAM_MAX_RETRIES_RANGE = { min: 0, max: 100 } as const;
export const CODEX_STREAM_IDLE_TIMEOUT_RANGE = { min: 1_000, max: 3_600_000 } as const;

/** 推荐的默认值，来自实测：断流间隔 42–64 秒、多数请求重试一两次即恢复。 */
export const DEFAULT_CODEX_STREAM_MAX_RETRIES = 10;
export const DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS = 600_000;

export function defaultTenantSettings(): TenantSettings {
  return {
    defaultProviderId: null,
    defaultModel: null,
    // 未显式选择语言时跟随浏览器，由前端按 navigator.languages 决定。
    language: null,
    approvalReviewModel: null,
    protocolConversion: false,
    gatewayToken: null,
    // 默认关闭：绝大多数聚合上游会因此报错，关掉才是能直接跑通的配置。
    disableCodexWebSearch: true,
    // 仅写进 config.toml（需重新 apply 才生效），不影响网关转发行为。
    codexStreamMaxRetries: DEFAULT_CODEX_STREAM_MAX_RETRIES,
    codexStreamIdleTimeoutMs: DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS,
    agentTargets: {},
    sync: defaultSyncConfig(),
    networking: defaultNetworkingConfig(),
    updatedAt: new Date().toISOString(),
  };
}
