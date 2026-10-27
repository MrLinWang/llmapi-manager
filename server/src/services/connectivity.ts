import type { ApiType, ModelCapability, ProviderRecord } from '../domain/provider';

const TIMEOUT_MS = 10_000;
const MAX_ERROR_SNIPPET = 200;

export interface ConnectivityResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  models?: string[];
  /**
   * 模型名 → 上游声明的能力（上下文窗口 / 输出上限）。
   *
   * 只在响应里确实带了这些字段的模型上出现；取不到的模型**不出现在这里**，
   * 由调用方回落到保守默认值。这个 map 只做"有就带回去"，不做推测。
   */
  capabilities?: Record<string, ModelCapability>;
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

/**
 * 从上游 `/models` 的条目里读"上下文窗口 / 输出上限"。
 *
 * 为什么要读它：Codex 目录里的 `context_window` 是客户端**真正使用**的字段，
 * 写死保守值会让 1M 上下文的上游只用到十分之一（客户端在 ~121k token 就压缩）。
 *
 * 字段名各家不一，这里按常见几组依次尝试，全部取不到就返回空对象——
 * 宁可让调用方回落保守默认值，也不要猜一个大数：猜大了 Codex 会把上下文塞到爆，
 * 上游直接回"超长"错误，那比用不满更难排查。
 */
function readCapability(entry: Record<string, unknown>): ModelCapability | undefined {
  // 常见落点：metadata.context_limit（本机聚合上游）、顶层 context_window，
  // 以及 OpenAI 官方 /models 里没有、但第三方常加的 max_output_tokens。
  const metadata =
    entry.metadata && typeof entry.metadata === 'object'
      ? (entry.metadata as Record<string, unknown>)
      : {};

  const pick = (...candidates: unknown[]): number | undefined => {
    for (const raw of candidates) {
      const value = typeof raw === 'string' ? Number(raw) : raw;
      // 只接受正整数：0 / 负数 / NaN 都视为"没声明"，不能当成"窗口为 0"。
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);
      }
    }
    return undefined;
  };

  const contextWindow = pick(
    metadata.context_limit,
    metadata.context_window,
    entry.context_window,
    entry.context_length,
  );
  const maxOutputTokens = pick(
    metadata.output_budget,
    metadata.max_output_tokens,
    entry.max_output_tokens,
  );

  if (contextWindow === undefined && maxOutputTokens === undefined) return undefined;
  const capability: ModelCapability = {};
  if (contextWindow !== undefined) capability.contextWindow = contextWindow;
  if (maxOutputTokens !== undefined) capability.maxOutputTokens = maxOutputTokens;
  return capability;
}

/** 一次遍历同时取出模型名与能力，避免为了多拿一个字段再解析一遍 JSON。 */
function extractModels(payload: unknown): {
  models: string[];
  capabilities: Record<string, ModelCapability>;
} | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : undefined;
  if (!list) return undefined;
  const models: string[] = [];
  const capabilities: Record<string, ModelCapability> = {};
  for (const item of list) {
    if (typeof item === 'string') {
      models.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = entry.id ?? entry.name ?? entry.model;
    if (typeof id !== 'string') continue;
    models.push(id);
    const capability = readCapability(entry);
    if (capability) capabilities[id] = capability;
  }
  return { models, capabilities };
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

    let extracted:
      | { models: string[]; capabilities: Record<string, ModelCapability> }
      | undefined;
    try {
      extracted = extractModels(JSON.parse(text));
    } catch {
      return {
        ok: false,
        latencyMs,
        status: response.status,
        error: `响应不是合法 JSON：${trimSnippet(text)}`,
      };
    }
    if (!extracted) {
      return {
        ok: false,
        latencyMs,
        status: response.status,
        // 上游可能把模型列表放在别的字段里；明确告诉用户"连上了但没认出结构"，
        // 而不是让界面显示一个空列表让人以为上游真没有模型。
        error: `连上了但响应里没有可识别的模型列表（期望 data[] 或 models[]）：${trimSnippet(text)}`,
      };
    }
    return {
      ok: true,
      latencyMs,
      status: response.status,
      models: extracted.models,
      // 一个能力都没解析出来时不给这个字段，免得调用方把空对象当成"上游明确声明无限制"
      capabilities:
        Object.keys(extracted.capabilities).length > 0
          ? extracted.capabilities
          : undefined,
    };
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
