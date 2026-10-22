export interface RequestLogRecord {
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
