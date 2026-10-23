import type {
  AgentPreview,
  AgentConnectionMode,
  AgentTargetPreference,
  StopProcessesResult,
  AgentSummary,
  Me,
  ModelsResponse,
  Provider,
  RequestLog,
  RequestStats,
  SetupStatus,
  TestResult,
  TokenView,
} from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * 服务端附带的机读信息。与 message 分开：message 是给人读的中文句子，
     * details 是给代码判断用的，不要靠匹配 message 里的字面量来分支。
     * 目前唯一的使用方是 501 时的 `{ canEnableConversion: true }`。
     */
    readonly details?: unknown,
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  // 只有真的有 body 时才声明 JSON：Fastify 对「Content-Type: application/json + 空 body」
  // 会直接返回 400，而预览/应用/还原/登出都是无 body 的 POST。
  if (init?.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
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

  if (!response.ok) {
    const body = payload as {
      error?: { code?: string; message?: string; details?: unknown };
    } | null;
    const code = body?.error?.code ?? 'unknown';
    const message = body?.error?.message ?? `请求失败（HTTP ${response.status}）`;
    if (response.status === 401) onUnauthorized?.();
    throw new ApiError(response.status, code, message, body?.error?.details);
  }

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
      disableCodexWebSearch: boolean;
      approvalReviewModel: string | null;
      protocolConversion: boolean;
      agentTargets: Record<string, AgentTargetPreference>;
    }>('/api/settings'),
  /**
   * 改 Codex 的三个行为开关。
   *
   * 服务端一律返回 requiresReapply: true，但三个开关要不要真的重新 apply 并不相同：
   * - disableCodexWebSearch：写进 config.toml，必须重新 apply 才生效；
   * - approvalReviewModel / protocolConversion：纯网关侧运行时行为，不改下发文件，
   *   所以调用方**不要**跟着 apply（AgentsPage 就是按这个区别处理的）。
   */
  setCodexOptions: (input: {
    disableCodexWebSearch?: boolean;
    approvalReviewModel?: string | null;
    protocolConversion?: boolean;
  }) =>
    request<{
      disableCodexWebSearch: boolean;
      approvalReviewModel: string | null;
      protocolConversion: boolean;
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
  enabled?: boolean;
  priority?: number;
  notes?: string;
  websiteUrl?: string;
}

export type { TokenView };
