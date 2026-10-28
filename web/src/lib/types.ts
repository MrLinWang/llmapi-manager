import type { UiLanguage } from '../i18n/language';

export type ApiType = 'openai' | 'anthropic' | 'responses';

/**
 * 模型能力，用于生成 Codex 目录。
 *
 * 来源有四级（上游 metadata > modelinfo.dev > models.dev > 默认值），前端只负责透传，
 * 不做任何推断——合并规则在服务端 `mergeCapabilities` 里只有一份实现。
 */
export interface ModelCapability {
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 是否支持推理档位；false 时目录里不写 reasoning 档位 */
  supportsReasoning?: boolean;
  /**
   * 该模型可用的推理档位（服务端已过滤并按强度排序）。
   *
   * `undefined` 与 `[]` 语义不同：前者"未知"（目录回落三档默认），
   * 后者"查过、没有可用档位"（目录隐藏推理菜单）。
   */
  reasoningEfforts?: string[];
  /** 输入模态，服务端保证只会是 text / image / audio */
  inputModalities?: string[];
}

export interface Provider {
  id: string;
  name: string;
  providerKey: string;
  apiType: ApiType;
  baseUrl: string;
  models: string[];
  /** 按模型名记录的上游能力；缺省表示未知，目录回落保守默认值 */
  modelCapabilities?: Record<string, ModelCapability>;
  enabled: boolean;
  priority: number;
  notes?: string;
  websiteUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  apiKeyMasked: string;
  apiKeyTail: string;
  hasApiKey: boolean;
  lastTest?: {
    at: string;
    ok: boolean;
    latencyMs: number;
    status?: number;
    models?: string[];
    error?: string;
  };
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  models?: string[];
  /** 上游声明的模型能力，仅在响应里确实带了这些字段时出现 */
  capabilities?: Record<string, ModelCapability>;
  error?: string;
}

/**
 * 逐档实测里单个模型的结果。
 *
 * `accepted` 是上游真正接受的档位（服务端已写回 `modelCapabilities`）；
 * `rejected` 是试过但被拒绝的档位。整条探测失败时 `error` 给出原因。
 */
export interface EffortProbeModelResult {
  model: string;
  accepted: string[];
  rejected: string[];
  error?: string;
}

/** 逐档实测的进度事件（服务端按完成数推送） */
export interface EffortProbeProgress {
  done: number;
  total: number;
  model: string;
  effort: string;
  accepted: boolean;
}

/** POST /api/providers/:id/probe-efforts 的最终结果：写入后的供应商 + 逐模型结果 */
export interface EffortProbeResult {
  provider: Provider;
  /** 服务端尝试过的档位列表，顺序即探测顺序 */
  candidates: string[];
  models: EffortProbeModelResult[];
}

export interface ModelAlias {
  alias: string;
  providerId: string;
  providerKey: string;
  providerName: string;
  apiType: ApiType;
  upstreamModel: string;
  /** 上游声明的能力；缺省表示未知，Codex 目录会回落保守默认值 */
  capability?: ModelCapability;
}

export interface TokenView {
  exists: boolean;
  prefix?: string;
  tail?: string;
  masked?: string;
  createdAt?: string;
}

export interface ModelsResponse {
  prefix: string;
  aliases: ModelAlias[];
  default: {
    providerId: string | null;
    providerName: string | null;
    model: string | null;
  };
  gateway: {
    baseUrl: string;
    token: TokenView;
  };
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  applied: boolean;
  appliedAt?: string;
  appliedBy?: string;
}

export interface PreviewEntry {
  key: string;
  next: string;
  current: string | null;
  differs: boolean;
}

export interface AgentFilePreview {
  /** 与服务端 AgentFileRole 保持一致：catalog 是整份生成的模型目录文件 */
  role: 'config' | 'auth' | 'catalog';
  path: string;
  exists: boolean;
  entries: PreviewEntry[];
}

export interface AgentPreview {
  agentId: string;
  name: string;
  applied: boolean;
  appliedAt?: string;
  /** 网关地址。注意直连模式下它仍在响应里，但不代表配置里写的就是它 */
  gatewayBaseUrl: string;
  /** 本次按走网关还是直连上游来写配置 */
  connectionMode: AgentConnectionMode;
  /**
   * 直连时实际写入 base_url 的上游地址。
   * 与 gatewayBaseUrl 是二选一的关系：直连要在界面上显示这一项，
   * 拿 gatewayBaseUrl 当"将写入的地址"展示会指错地方。
   */
  directBaseUrl?: string;
  files: AgentFilePreview[];
}

export type AgentConnectionMode = 'gateway' | 'direct';

/**
 * 某个 Agent 的下发偏好。按 Agent 分开存：Codex 与 Claude Code 协议不同、
 * 用途也可能不同，一个全局开关会强迫两者同步切换。
 *
 * 直连字段只在 mode === 'direct' 时有意义；切回 gateway 时服务端会把它们置空，
 * 避免下次切回直连时用上一个已过期的供应商。
 */
export interface AgentTargetPreference {
  mode: AgentConnectionMode;
  /**
   * 直连必须明确指定供应商。多供应商时按优先级自动挑是错的：用户既看不到
   * 选了谁也无法干预，而这会把那家的地址和真实 Key 直接写进配置文件。
   * 未指定时服务端拒绝下发并返回 400。
   */
  directProviderId: string | null;
  /**
   * 直连时若要覆盖供应商的默认模型。
   * 为 null（或不在该供应商已声明的 models 里）时由服务端回落到它的首个模型 ——
   * 注意直连**不**参考全局的 defaultModel，那是网关模式的默认。
   */
  directModel: string | null;
}

export interface StopProcessesResult {
  actions: string[];
  /** 被结束的进程数 */
  killed: number;
  warnings: string[];
  /** 该 Agent 是否支持进程操作（Claude Code 无常驻进程） */
  supported: boolean;
}

export interface RequestLog {
  tenantId: string;
  at: string;
  path: string;
  requestedModel: string;
  upstreamModel: string;
  providerId: string | null;
  providerName: string | null;
  mode: 'alias' | 'default' | 'invalid';
  stream: boolean;
  status: number;
  latencyMs: number;
  fallback: boolean;
  error?: string;
}

export interface RequestStats {
  total: number;
  success: number;
  successRate: number;
  avgLatencyMs: number;
}

export interface Me {
  user: { id: string; tenantId: string; role: string; username: string };
  permissions: string[];
  allPermissions: string[];
  /**
   * 界面语言偏好；`null` 表示跟随浏览器。
   *
   * 放在 `/api/auth/me` 里而不是只放 `/api/settings`：member 角色没有 `settings:read`，
   * 但同样要看到正确语言的界面。
   */
  language: UiLanguage | null;
}

/** 首次初始化状态（GET /api/setup/status，免鉴权） */
export interface SetupStatus {
  needsSetup: boolean;
  defaultUsername: string;
  rules: {
    minUsernameLength: number;
    maxUsernameLength: number;
    minPasswordLength: number;
  };
  failedAttempts?: number;
}

/** API 令牌（程序化访问管理面）。列表里不含明文与哈希。 */
export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  tail: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface GatewayOverview {
  providers: {
    total: number;
    enabled: number;
    byApiType: { openai: number; anthropic: number; responses: number };
  };
  aliases: { total: number };
  settings: {
    defaultProviderId: string | null;
    defaultModel: string | null;
    protocolConversion: boolean;
    approvalReviewModel: string | null;
    disableCodexWebSearch: boolean;
    /** 写进 config.toml 的 stream_max_retries；null = 不写，用 Codex 默认 */
    codexStreamMaxRetries: number | null;
    /** 写进 config.toml 的 stream_idle_timeout_ms；null = 不写，用 Codex 默认 */
    codexStreamIdleTimeoutMs: number | null;
    agentTargets: Record<string, AgentTargetPreference>;
  };
  agents: Array<{
    id: string;
    applied: boolean;
    appliedAt: string | null;
    runningProcesses: number;
  }>;
  todayStats: { total: number; success: number; successRate: number; avgLatencyMs: number };
}

/** 多设备配置同步：角色。standalone 表示不参与同步。 */
export type SyncRole = 'standalone' | 'master' | 'follower';

/** 可同步的内容范围，与 `server/src/domain/sync.ts` 的 SYNC_SCOPES 一一对应。 */
export type SyncScope = 'providers' | 'settings' | 'agentTargets';

export interface SyncConfig {
  role: SyncRole;
  /** follower 要拉取的 master 地址；master 角色下不用 */
  masterUrl: string | null;
  /** 勾选同步哪些内容；空数组表示什么都不动（安全的默认） */
  scopes: SyncScope[];
  /** 上次成功拉取的时间 */
  lastPullAt: string | null;
  /** 上次拉取的结果摘要（不含凭据内容） */
  lastPullResult: string | null;
}

/** 一条待仲裁的冲突：同一记录本地与远端都被改过。 */
export interface SyncConflict {
  id: string;
  scope: SyncScope;
  targetId: string;
  /** 给人看的名字，例如供应商名 */
  targetLabel: string;
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  /** 两版的差异字段名列表（不含完整值） */
  changedFields: string[];
  /** 本地版的可比较形态（凭据已打码） */
  localValue: unknown;
  /** 远端版的可比较形态（凭据已打码） */
  remoteValue: unknown;
  detectedAt: string;
}

export interface SyncStatus {
  config: SyncConfig;
  /** 前端据此渲染勾选项，避免两处维护范围清单与文案 */
  availableScopes: Array<{ scope: SyncScope; label: string }>;
  conflictCount: number;
  /** 永远不会同步的内容，直接展示给用户 */
  neverSynced: string[];
}
