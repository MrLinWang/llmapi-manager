import i18next, { currentLanguage } from '../i18n';
import type { UiLanguage } from '../i18n/language';
import type {
  AgentPreview,
  AgentConnectionMode,
  AgentTargetPreference,
  ApiTokenView,
  EffortProbeProgress,
  EffortProbeResult,
  GatewayOverview,
  StopProcessesResult,
  AgentSummary,
  Me,
  ModelsResponse,
  ModelCapability,
  Provider,
  RequestLog,
  RequestStats,
  SetupStatus,
  SyncConflict,
  SyncConfig,
  SyncRole,
  SyncScope,
  SyncStatus,
  TestResult,
  TokenView,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * 服务端附带的机读信息。与 message 分开：message 是给人读的句子（会随语言变），
     * details 是给代码判断用的，不要靠匹配 message 里的字面量来分支。
     * 目前唯一的使用方是 501 时的 `{ canEnableConversion: true }`。
     */
    readonly details?: unknown,
    /**
     * 稳定的错误标识（如 `providers.validation.nameType`）。
     *
     * 比 `code` 细、比 `message` 稳：`code` 只区分 HTTP 语义（bad_request），
     * 而同一类错误下有很多具体原因。需要精确区分时用它。
     * 注意 `message` 已经由服务端按当前语言渲染好了，显示直接用 `message` 即可。
     */
    readonly messageKey?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;

/** 由 AuthProvider 注册：任何 401 都统一回到登录页，避免每个页面各自处理。 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * 统一把非 2xx 响应的载荷转成 ApiError。
 *
 * 抽出来是因为「逐档实测」走流式响应，错误仍然可能是普通 JSON（400/404/401），
 * 而它的读取路径不经过 request()。两处必须共用同一套错误解析与 401 处理。
 */
function toApiError(response: Response, payload: unknown): ApiError {
  const body = payload as {
    error?: { code?: string; message?: string; messageKey?: string; details?: unknown };
  } | null;
  const code = body?.error?.code ?? 'unknown';
  // 服务端 message 已经按请求语言渲染（见上面 accept-language 与
  // server/src/i18n/language.ts 的优先级），可以直接显示。
  // 这里只兜"连 message 都没有"的情况——那是前端自己造的句子，走字典。
  const message =
    body?.error?.message ?? i18next.t('common.requestFailed', { status: response.status });
  if (response.status === 401) onUnauthorized?.();
  return new ApiError(
    response.status,
    code,
    message,
    body?.error?.details,
    body?.error?.messageKey,
  );
}

/**
 * 读「逐档实测」的 NDJSON 流：每行一个事件。
 *
 * 事件类型：
 * - start    : { total, candidates, models }，用于进度条分母
 * - progress : { done, total, model, effort, accepted }，每完成一次上游请求一条
 * - result   : 最终结果（写入后的供应商 + 逐模型 accepted/rejected）
 * - error    : 流中途失败（响应头已发出，改不了状态码）
 *
 * 没有 `response.body` 时（测试桩或环境不支持流）退化为整段文本解析，
 * 这样两种读取路径共用同一套事件处理。
 */
async function readProbeStream(
  response: Response,
  onProgress?: (progress: EffortProbeProgress) => void,
): Promise<EffortProbeResult> {
  const handle = (line: string): EffortProbeResult | undefined => {
    const trimmed = line.trim();
    if (trimmed === '') return undefined;
    let event: { type?: string } & Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as { type?: string } & Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (event.type === 'progress') {
      onProgress?.(event as unknown as EffortProbeProgress);
      return undefined;
    }
    if (event.type === 'error') {
      throw new ApiError(
        502,
        'probe_stream_error',
        String(event.message ?? i18next.t('common.requestFailed', { status: 502 })),
      );
    }
    if (event.type === 'result') {
      return event as unknown as EffortProbeResult;
    }
    return undefined;
  };

  let result: EffortProbeResult | undefined;
  const reader = response.body?.getReader();
  if (!reader) {
    for (const line of (await response.text()).split('\n')) {
      result = handle(line) ?? result;
    }
  } else {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        result = handle(buffer.slice(0, index)) ?? result;
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    }
    // 最后一行可能没有换行符（服务端 end 前都会补，但不要依赖它）
    result = handle(buffer) ?? result;
  }

  if (!result) {
    throw new ApiError(
      502,
      'probe_stream_truncated',
      i18next.t('common.requestFailed', { status: 502 }),
    );
  }
  return result;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  // 只有真的有 body 时才声明 JSON：Fastify 对「Content-Type: application/json + 空 body」
  // 会直接返回 400，而预览/应用/还原/登出都是无 body 的 POST。
  if (init?.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  // 带上界面语言：服务端据此渲染 error.message。
  //
  // 已登录时服务端会优先用租户设置，这个头只在两处真正起作用：未登录（登录页、
  // 首次初始化）和租户还没选过语言。但不带它的后果很具体——英文界面上登录失败
  // 会弹出一句中文，用户会以为是两个不同的系统。
  if (headers['accept-language'] === undefined) {
    headers['accept-language'] = currentLanguage();
  }

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) throw toApiError(response, payload);

  return payload as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  /** 首次初始化状态：免鉴权，用于判断是否强制跳转设置页 */
  setupStatus: () => request<SetupStatus>('/api/setup/status'),
  /** 提交首次初始化：token 来自服务端控制台，明码只在这一次请求里传递 */
  completeSetup: (token: string, username: string, password: string) =>
    request<{ user: Me['user'] }>('/api/setup', json({ token, username, password })),

  login: (username: string, password: string) =>
    request<{ user: Me['user'] }>('/api/auth/login', json({ username, password })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<Me>('/api/auth/me'),
  changePassword: (oldPassword: string, newPassword: string) =>
    request<{ ok: boolean; message: string }>(
      '/api/auth/password',
      json({ oldPassword, newPassword }),
    ),

  /** 程序化访问令牌。列表不含明文与哈希；明文只在创建响应里出现一次。 */
  apiTokens: () =>
    request<{ tokens: ApiTokenView[]; availableScopes: string[] }>('/api/tokens'),
  createApiToken: (body: { name: string; scopes: string[]; expiresAt?: string | null }) =>
    request<{ token: string; tokenView: ApiTokenView }>('/api/tokens', json(body)),
  revokeApiToken: (id: string) =>
    request<{ tokenView: ApiTokenView }>(`/api/tokens/${id}`, { method: 'DELETE' }),

  overview: () => request<GatewayOverview>('/api/overview'),

  providers: () => request<{ providers: Provider[] }>('/api/providers'),
  createProvider: (body: ProviderInput) =>
    request<{ provider: Provider }>('/api/providers', json(body)),
  updateProvider: (id: string, body: ProviderInput) =>
    request<{ provider: Provider }>(`/api/providers/${id}`, { ...json(body), method: 'PUT' }),
  deleteProvider: (id: string) =>
    request<{ newDefaultProviderId: string | null }>(`/api/providers/${id}`, {
      method: 'DELETE',
    }),
  testProvider: (id: string) =>
    request<TestResult>(`/api/providers/${id}/test`, { method: 'POST' }),
  /**
   * 逐档实测：服务端按档位逐个向上游发极小请求，把真正接受的档位写回
   * `modelCapabilities`。响应是 NDJSON 流（进度事件 + 最终结果）。
   *
   * 无 body 的 POST —— 不要加 JSON 头，Fastify 会把「application/json + 空 body」
   * 直接判 400。这里没有复用 request()，因为它要等整个响应体读完，会把进度丢掉。
   */
  probeProviderEfforts: async (
    id: string,
    onProgress?: (progress: EffortProbeProgress) => void,
  ): Promise<EffortProbeResult> => {
    const response = await fetch(`/api/providers/${id}/probe-efforts`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'accept-language': currentLanguage() },
    });
    if (!response.ok) {
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      throw toApiError(response, payload);
    }
    return readProbeStream(response, onProgress);
  },
  /**
   * 按表单当前值拉取上游模型列表，不要求供应商已保存。
   * apiKey 留空时传 providerId，服务端沿用已保存的 Key。
   */
  fetchProviderModels: (body: {
    apiType: 'openai' | 'anthropic' | 'responses';
    baseUrl: string;
    apiKey?: string;
    providerId?: string;
  }) => request<TestResult>('/api/providers/models', json(body)),
  setProviderEnabled: (id: string, enabled: boolean) =>
    request<{ provider: Provider }>(`/api/providers/${id}/enabled`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  reorderProviders: (ids: string[]) =>
    request<{ providers: Provider[] }>('/api/providers/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    }),

  models: () => request<ModelsResponse>('/api/models'),
  setDefault: (providerId: string | null, model?: string | null) =>
    request<{ defaultProviderId: string | null; defaultModel: string | null }>(
      '/api/settings/default',
      { method: 'PUT', body: JSON.stringify({ providerId, model }) },
    ),
  settings: () =>
    request<{
      language: UiLanguage | null;
      disableCodexWebSearch: boolean;
      approvalReviewModel: string | null;
      protocolConversion: boolean;
      codexStreamMaxRetries: number | null;
      codexStreamIdleTimeoutMs: number | null;
      agentTargets: Record<string, AgentTargetPreference>;
    }>('/api/settings'),
  /**
   * 改界面语言。`null` = 跟随浏览器。
   *
   * 与其它设置的差别：它不影响网关与下发文件，所以响应里没有 requiresReapply。
   */
  setLanguage: (language: UiLanguage | null) =>
    request<{ language: UiLanguage | null }>('/api/settings/language', {
      method: 'PATCH',
      body: JSON.stringify({ language }),
    }),
  /**
   * 改 Codex 的行为开关与下发数值。
   *
   * 服务端一律返回 requiresReapply: true，但要不要真的重新 apply 并不相同：
   * - disableCodexWebSearch / codexStreamMaxRetries / codexStreamIdleTimeoutMs：
   *   都写进 config.toml，必须重新 apply 才生效；
   * - approvalReviewModel / protocolConversion：纯网关侧运行时行为，不改下发文件，
   *   所以调用方**不要**跟着 apply（AgentsPage 就是按这个区别处理的）。
   */
  setCodexOptions: (input: {
    disableCodexWebSearch?: boolean;
    approvalReviewModel?: string | null;
    protocolConversion?: boolean;
    codexStreamMaxRetries?: number | null;
    codexStreamIdleTimeoutMs?: number | null;
  }) =>
    request<{
      disableCodexWebSearch: boolean;
      approvalReviewModel: string | null;
      protocolConversion: boolean;
      codexStreamMaxRetries: number | null;
      codexStreamIdleTimeoutMs: number | null;
      requiresReapply: boolean;
    }>('/api/settings/codex', { method: 'PATCH', body: JSON.stringify(input) }),
  /**
   * 设置某个 Agent 的连接方式与直连目标，按 Agent 分开存。
   *
   * 改完不会自己下发：这里的响应同样带 requiresReapply，由调用方决定何时 apply。
   * 直连但没选供应商时就别 apply —— 服务端会 400，等于拿报错当交互反馈。
   */
  setAgentTarget: (
    id: string,
    input: { mode?: AgentConnectionMode; directProviderId?: string | null; directModel?: string | null },
  ) =>
    request<{ agentTargets: Record<string, AgentTargetPreference>; requiresReapply: boolean }>(
      `/api/agents/${id}/target`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),
  resetGatewayToken: () =>
    request<{ token: string; masked: string; createdAt: string; note: string }>(
      '/api/gateway/token',
      { method: 'POST' },
    ),

  agents: () => request<{ agents: AgentSummary[] }>('/api/agents'),
  previewAgent: (id: string) =>
    request<AgentPreview>(`/api/agents/${id}/preview`, { method: 'POST' }),
  /**
   * 下发配置。注意返回体里的 runningProcesses：写成功不等于生效，
   * 仍在运行的 Agent 进程内存里还是旧配置，必须由调用方提示用户重启。
   */
  applyAgent: (id: string) =>
    request<{ binding: { appliedAt: string; appliedBy: string; runningProcesses?: number } }>(
      `/api/agents/${id}/apply`,
      { method: 'POST' },
    ),
  revertAgent: (id: string) =>
    request<{ restored: string[]; conflicts: Array<{ key: string; expected: string; current: string | null }> }>(
      `/api/agents/${id}/revert`,
      { method: 'POST' },
    ),

  stopAgentProcesses: (id: string) =>
    request<StopProcessesResult>(`/api/agents/${id}/stop-processes`, { method: 'POST' }),

  /**
   * 多设备配置同步。
   *
   * 注意 pull 的 token 是 **master 的 API 令牌**（`api_` 前缀且含 `sync:read`），
   * 不是本机的登录会话，也不是网关令牌 —— 它只在这一处使用，不落盘。
   */
  syncStatus: () => request<SyncStatus>('/api/sync/status'),
  setSyncConfig: (body: { role?: SyncRole; masterUrl?: string | null; scopes?: SyncScope[] }) =>
    request<{ config: SyncConfig }>('/api/sync/config', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  /** 立即从 master 拉取并应用；conflicts 是本次新产生的待仲裁项。 */
  syncPull: (token: string) =>
    request<{ applied: number; conflicts: SyncConflict[]; summary: string }>(
      '/api/sync/pull',
      json({ token }),
    ),
  syncConflicts: () => request<{ conflicts: SyncConflict[] }>('/api/sync/conflicts'),
  resolveSyncConflict: (id: string, choice: 'local' | 'remote') =>
    request<{ ok: boolean; conflictCount: number }>(
      `/api/sync/conflicts/${id}/resolve`,
      json({ choice }),
    ),

  logs: (providerId?: string, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (providerId) params.set('providerId', providerId);
    return request<{ logs: RequestLog[] }>(`/api/logs?${params.toString()}`);
  },
  stats: () => request<RequestStats>('/api/stats'),

  health: () =>
    request<{ ok: boolean; warnings: Array<{ code: string; message: string }>; gatewayBaseUrl: string }>(
      '/api/health',
    ),
};

export interface ProviderInput {
  name: string;
  apiType: 'openai' | 'anthropic' | 'responses';
  baseUrl: string;
  apiKey?: string;
  models: string[];
  /**
   * 按模型名记录的上游能力（上下文窗口等）。
   * 不传表示保持已存值不变；传了则整体替换（服务端按 models 裁剪）。
   */
  modelCapabilities?: Record<string, ModelCapability>;
  enabled?: boolean;
  priority?: number;
  notes?: string;
  websiteUrl?: string;
}

export type { TokenView };
