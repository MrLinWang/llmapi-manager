import type { ServerResponse } from 'node:http';
import type { ProviderRecord } from '../domain/provider';
import type { RequestLogRecord } from '../domain/requestLog';
import { AppError } from '../http/errors';

export type GatewayPath = '/chat/completions' | '/messages' | '/responses';

export interface ForwardTarget {
  provider: ProviderRecord;
  apiKey: string;
  upstreamModel: string;
  /** 请求的 model 字段是否被改写（别名 → 上游模型名） */
  modelRewritten: boolean;
}

/**
 * 网关暴露的路径清单。清单与"哪条路径要哪种协议"只在这里定义一次，
 * routes/gateway.ts 必须 import 复用 —— 两处各维护一份时，加 /v1/responses 就只注册了路由、
 * 没补协议要求，该路径于是成了"不限协议"的直通。
 */
export const GATEWAY_PATHS: GatewayPath[] = [
  '/chat/completions',
  '/messages',
  '/responses',
];

/**
 * 每条网关路径要求的上游协议：三条路径都严格匹配，不做任何协议转换。
 * - /v1/chat/completions → openai
 * - /v1/messages          → anthropic
 * - /v1/responses         → responses（OpenAI Responses API）
 *
 * 返回 null 只表示"该路径不限制协议"，现在没有任何路径用它；
 * 之所以保留，是因为 /v1/responses 曾经就是靠 null 走直通，结果把 Responses 请求
 * 发给了只支持 Chat 的上游。将来真要为某条路径放宽，必须能说清为什么不会踩同一个坑。
 */
export function requiredApiType(path: GatewayPath): ProviderRecord['apiType'] | null {
  if (path === '/chat/completions') return 'openai';
  if (path === '/messages') return 'anthropic';
  if (path === '/responses') return 'responses';
  return null;
}

export function upstreamUrl(provider: ProviderRecord, path: GatewayPath): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const hasV1 = /\/v1$/i.test(base);
  return `${base}${hasV1 ? '' : '/v1'}${path}`;
}

export function buildUpstreamHeaders(
  provider: ProviderRecord,
  apiKey: string,
  incoming: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: incoming.accept?.toString() ?? 'application/json',
  };
  if (provider.apiType === 'anthropic') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] =
      (incoming['anthropic-version'] as string | undefined) ?? '2023-06-01';
    const beta = incoming['anthropic-beta'];
    if (beta) headers['anthropic-beta'] = beta.toString();
  } else {
    // 按鉴权体系分组而不是逐个协议罗列：openai 与 responses 同属 OpenAI 体系，共用 Bearer，
    // 只有 anthropic 走 x-api-key + anthropic-version。逐协议写分支时新协议很容易被漏掉。
    headers.authorization = `Bearer ${apiKey}`;
    const org = incoming['openai-organization'];
    if (org) headers['openai-organization'] = org.toString();
    const project = incoming['openai-project'];
    if (project) headers['openai-project'] = project.toString();
  }
  return headers;
}

export interface ForwardOutcome {
  status: number;
  stream: boolean;
  latencyMs: number;
  error?: string;
  /**
   * 仅 `deferErrorWrite` 时填充：上游原始错误响应体与 content-type。
   * 调用方决定"不回退"后必须用 `writeDeferredError` 补写，否则客户端会收到空响应。
   */
  upstreamBody?: string;
  upstreamContentType?: string;
}

export interface ForwardOptions {
  target: ForwardTarget;
  path: GatewayPath;
  body: Record<string, unknown>;
  incomingHeaders: Record<string, string | string[] | undefined>;
  reply: ServerResponse;
  onLog: (record: Omit<RequestLogRecord, 'tenantId' | 'at'>) => void;
  tenantId: string;
  requestedModel: string;
  mode: RequestLogRecord['mode'];
  fallback: boolean;
  /**
   * 为 true 时上游失败也不写响应体：调用方还有备选供应商要试。
   * 这样回退时不会出现"已经写了一版错误响应"的尴尬状态。
   */
  deferErrorWrite?: boolean;
  loggerWarn: (message: string, meta?: unknown) => void;
}

function writeLog(
  options: ForwardOptions,
  outcome: Omit<ForwardOutcome, 'stream'> & { stream?: boolean },
): void {
  try {
    options.onLog({
      path: `/v1${options.path}`,
      requestedModel: options.requestedModel,
      upstreamModel: options.target.upstreamModel,
      providerId: options.target.provider.id,
      providerName: options.target.provider.name,
      mode: options.mode,
      stream: outcome.stream ?? false,
      status: outcome.status,
      latencyMs: outcome.latencyMs,
      fallback: options.fallback,
      error: outcome.error,
    });
  } catch (error) {
    options.loggerWarn('写入请求日志失败', error);
  }
}

/**
 * 单次转发。流式时逐块透传，客户端断开立即 abort 上游，
 * 避免上游继续计费生成没人要的 token。
 */
export async function forwardOnce(options: ForwardOptions): Promise<ForwardOutcome> {
  const { target, path, body, reply } = options;
  const startedAt = Date.now();
  const stream = body.stream === true;
  const controller = new AbortController();
  /**
   * 只在"客户端真的断开"时中止上游。
   * 注意不能用 request 的 'close'：Node 在请求体读完后就会触发它，
   * 那样会在请求刚发出时就把上游 abort 掉。
   */
  const onClientClose = (): void => {
    if (!reply.writableFinished) controller.abort();
  };
  reply.once('close', onClientClose);

  const payload = { ...body };
  if (target.modelRewritten) payload.model = target.upstreamModel;

  try {
    const response = await fetch(upstreamUrl(target.provider, path), {
      method: 'POST',
      headers: buildUpstreamHeaders(target.provider, target.apiKey, options.incomingHeaders),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const latencyMs = Date.now() - startedAt;
      const snippet = text.slice(0, 400);
      writeLog(options, {
        status: response.status,
        latencyMs,
        stream,
        error: snippet || response.statusText,
      });
      if (options.deferErrorWrite) {
        // 交给调用方决定是否回退；这里不碰 reply，但要把原始响应带出去，
        // 否则"不回退"时调用方无从补写，客户端会拿到空响应。
        return {
          status: response.status,
          stream,
          latencyMs,
          error: snippet || response.statusText,
          upstreamBody: snippet || response.statusText,
          upstreamContentType: response.headers.get('content-type') ?? 'application/json',
        };
      }
      reply.statusCode = response.status;
      reply.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
      reply.end(
        snippet ||
          JSON.stringify({
            error: { code: 'upstream_error', message: response.statusText },
          }),
      );
      return {
        status: response.status,
        stream,
        latencyMs,
        error: snippet || response.statusText,
      };
    }

    if (stream) {
      reply.statusCode = 200;
      reply.setHeader('content-type', 'text/event-stream; charset=utf-8');
      reply.setHeader('cache-control', 'no-cache, no-transform');
      reply.setHeader('connection', 'keep-alive');
      reply.setHeader('x-accel-buffering', 'no');
      if (options.fallback) reply.setHeader('x-llmapi-fallback', '1');
      reply.flushHeaders?.();

      const reader = response.body?.getReader();
      if (!reader) {
        const latencyMs = Date.now() - startedAt;
        reply.end();
        writeLog(options, {
          status: 502,
          latencyMs,
          stream: true,
          error: '上游未返回响应体',
        });
        return { status: 502, stream: true, latencyMs, error: '上游未返回响应体' };
      }
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) reply.write(Buffer.from(value));
        }
        reply.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          reply.end();
        } catch {
          // 客户端已断开，忽略
        }
        const latencyMs = Date.now() - startedAt;
        writeLog(options, { status: 499, latencyMs, stream: true, error: message });
        return { status: 499, stream: true, latencyMs, error: message };
      } finally {
        reader.releaseLock();
      }

      const latencyMs = Date.now() - startedAt;
      writeLog(options, { status: 200, latencyMs, stream: true });
      return { status: 200, stream: true, latencyMs };
    }

    const text = await response.text();
    const latencyMs = Date.now() - startedAt;
    reply.statusCode = 200;
    reply.setHeader('content-type', response.headers.get('content-type') ?? 'application/json');
    if (options.fallback) reply.setHeader('x-llmapi-fallback', '1');
    reply.end(text);
    writeLog(options, { status: 200, latencyMs, stream: false });
    return { status: 200, stream: false, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? '请求被中止（客户端断开或超时）'
          : error.message
        : String(error);
    writeLog(options, { status: 502, latencyMs, stream, error: message });
    if (!reply.headersSent && !options.deferErrorWrite) {
      reply.statusCode = 502;
      reply.setHeader('content-type', 'application/json');
      reply.end(
        JSON.stringify({ error: { code: 'upstream_error', message: `上游请求失败：${message}` } }),
      );
    }
    return { status: 502, stream, latencyMs, error: message };
  } finally {
    reply.off('close', onClientClose);
  }
}

/**
 * 补写被延迟的上游错误响应。
 *
 * `deferErrorWrite` 让 `forwardOnce` 在失败时不碰 reply，好让调用方先判断能否回退；
 * 一旦决定不回退（非 5xx、没有备选、或回退也失败），必须调用这里把错误发给客户端。
 * 漏掉这一步的表现是：上游 4xx，客户端却收到 200 + 空 body。
 */
export function writeDeferredError(
  reply: ServerResponse,
  outcome: Pick<ForwardOutcome, 'status' | 'upstreamBody' | 'upstreamContentType' | 'error'>,
): void {
  if (reply.headersSent || reply.writableEnded) return;
  reply.statusCode = outcome.status;
  reply.setHeader('content-type', outcome.upstreamContentType ?? 'application/json');
  reply.end(
    outcome.upstreamBody ??
      JSON.stringify({
        error: {
          code: 'upstream_error',
          message: outcome.error ?? `上游返回 ${outcome.status}`,
        },
      }),
  );
}

/**
 * 路径与上游协议不匹配就拒绝。必须在真正发上游请求之前调用（见 routes/gateway.ts）：
 * 一旦请求已经打出去，客户端拿到的会是上游的参数错误，而看不出是本服务选错了协议。
 */
export function assertApiTypeMatch(
  provider: ProviderRecord,
  path: GatewayPath,
): void {
  const required = requiredApiType(path);
  if (required && provider.apiType !== required) {
    throw new AppError(
      'not_implemented',
      `骨架期不做协议转换：${path} 需要 ${required} 上游，而供应商 ${provider.name} 是 ${provider.apiType}`,
    );
  }
}
