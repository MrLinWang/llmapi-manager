import type { ProviderRecord } from '../domain/provider';

const TIMEOUT_MS = 10_000;
const MAX_ERROR_SNIPPET = 200;

export interface ConnectivityResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  models?: string[];
  error?: string;
}

function trimSnippet(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_ERROR_SNIPPET
    ? `${compact.slice(0, MAX_ERROR_SNIPPET)}…`
    : compact;
}

function modelsUrl(provider: ProviderRecord): string {
  return `${provider.baseUrl.replace(/\/+$/, '')}/models`;
}

function authHeaders(provider: ProviderRecord, apiKey: string): Record<string, string> {
  if (provider.apiType === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  // 按鉴权体系分组：openai 与 responses 都是 OpenAI 体系的 Bearer，
  // 只有 anthropic 用 x-api-key + anthropic-version。逐个协议罗列时新协议容易漏。
  return { authorization: `Bearer ${apiKey}` };
}

function extractModels(payload: unknown): string[] | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : undefined;
  if (!list) return undefined;
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') ids.push(item);
    else if (item && typeof item === 'object') {
      const entry = item as Record<string, unknown>;
      const id = entry.id ?? entry.name ?? entry.model;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

/**
 * 请求上游 /models 判断连通性。10s 超时，失败信息截断，
 * 任何异常都不抛出 —— 测试失败不该让接口 500。
 */
export async function testProviderConnectivity(
  provider: ProviderRecord,
  apiKey: string,
): Promise<ConnectivityResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(modelsUrl(provider), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...authHeaders(provider, apiKey),
      },
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        status: response.status,
        error: `HTTP ${response.status}: ${trimSnippet(text) || response.statusText}`,
      };
    }

    let models: string[] | undefined;
    try {
      models = extractModels(JSON.parse(text));
    } catch {
      return {
        ok: false,
        latencyMs,
        status: response.status,
        error: `响应不是合法 JSON：${trimSnippet(text)}`,
      };
    }
    return { ok: true, latencyMs, status: response.status, models };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `请求超时（${TIMEOUT_MS / 1000}s）`
          : error.message
        : String(error);
    return { ok: false, latencyMs, error: trimSnippet(message) };
  } finally {
    clearTimeout(timer);
  }
}
