import type {
  AgentPreview,
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
    const body = payload as { error?: { code?: string; message?: string } } | null;
    const code = body?.error?.code ?? 'unknown';
    const message = body?.error?.message ?? `请求失败（HTTP ${response.status}）`;
    if (response.status === 401) onUnauthorized?.();
    throw new ApiError(response.status, code, message);
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
  resetGatewayToken: () =>
    request<{ token: string; masked: string; createdAt: string; note: string }>(
      '/api/gateway/token',
      { method: 'POST' },
    ),

  agents: () => request<{ agents: AgentSummary[] }>('/api/agents'),
  previewAgent: (id: string) =>
    request<AgentPreview>(`/api/agents/${id}/preview`, { method: 'POST' }),
  applyAgent: (id: string) =>
    request<{ binding: { appliedAt: string; appliedBy: string } }>(
      `/api/agents/${id}/apply`,
      { method: 'POST' },
    ),
  revertAgent: (id: string) =>
    request<{ restored: string[]; conflicts: Array<{ key: string; expected: string; current: string | null }> }>(
      `/api/agents/${id}/revert`,
      { method: 'POST' },
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
  apiType: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  models: string[];
  enabled?: boolean;
  priority?: number;
  notes?: string;
  websiteUrl?: string;
}

export type { TokenView };
