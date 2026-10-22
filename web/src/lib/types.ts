export type ApiType = 'openai' | 'anthropic' | 'responses';

export interface Provider {
  id: string;
  name: string;
  providerKey: string;
  apiType: ApiType;
  baseUrl: string;
  models: string[];
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
  error?: string;
}

export interface ModelAlias {
  alias: string;
  providerId: string;
  providerKey: string;
  providerName: string;
  apiType: ApiType;
  upstreamModel: string;
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
  role: 'config' | 'auth';
  path: string;
  exists: boolean;
  entries: PreviewEntry[];
}

export interface AgentPreview {
  agentId: string;
  name: string;
  applied: boolean;
  appliedAt?: string;
  gatewayBaseUrl: string;
  files: AgentFilePreview[];
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
