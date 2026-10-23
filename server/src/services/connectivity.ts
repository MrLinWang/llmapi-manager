import type { ApiType, ProviderRecord } from '../domain/provider';

const TIMEOUT_MS = 10_000;
const MAX_ERROR_SNIPPET = 200;

export interface ConnectivityResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  models?: string[];
  error?: string;
}

/** 拉取模型列表所需的参数：表单里填的临时值，不要求供应商已保存。 */
export interface ModelListTarget {
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
}

function trimSnippet(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_ERROR_SNIPPET
    ? `${compact.slice(0, MAX_ERROR_SNIPPET)}…`
    : compact;
}

/**
 * 上游 /models 地址。
 *
 * Anthropic 官方把模型列表放在 /v1/models（且需要 anthropic-version 头），
 * 而 OpenAI 体系常见写法是 baseUrl 已含 /v1，再拼 /models 即可。
 * 与转发路径一致：baseUrl 自带 /v1 时不重复添加。
 */
function modelsUrl(target: ModelListTarget): string {
  const base = target.baseUrl.trim().replace(/\/+$/, '');
  const hasV1 = /\/v1$/i.test(base);
  return `${base}${hasV1 ? '' : '/v1'}/models`;
}

function authHeaders(target: ModelListTarget, apiKey: string): Record<string, string> {
  if (target.apiType === 'anthropic') {
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
 * 请求上游 /models 拉取模型列表。
 *
 * 用表单里的临时值（baseUrl/apiKey/apiType）而不是 ProviderRecord：
 * 新增供应商时还没有 id、也还没落盘，必须先能试连再保存。
 * 10s 超时，失败信息截断，任何异常都不抛出 —— 拉取失败不该让接口 500。
 */
export async function fetchProviderModels(
  target: ModelListTarget,
): Promise<ConnectivityResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(modelsUrl(target), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...authHeaders(target, target.apiKey),
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
    if (!models) {
      return {
        ok: false,
        latencyMs,
        status: response.status,
        // 上游可能把模型列表放在别的字段里；明确告诉用户"连上了但没认出结构"，
        // 而不是让界面显示一个空列表让人以为上游真没有模型。
        error: `连上了但响应里没有可识别的模型列表（期望 data[] 或 models[]）：${trimSnippet(text)}`,
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

/** 对已保存的供应商做连通性测试（沿用旧签名，内部复用 fetchProviderModels）。 */
export async function testProviderConnectivity(
  provider: ProviderRecord,
  apiKey: string,
): Promise<ConnectivityResult> {
  return fetchProviderModels({
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
    apiKey,
  });
}
