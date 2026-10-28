import type { ServerResponse } from 'node:http';
import type { ProviderRecord } from '../domain/provider';
import type { UiLanguage } from '../domain/settings';
import { translate } from '../i18n';
import { ConversionError, responsesToChatRequest } from './convert/responsesToChat';
import { chatToResponsesResponse } from './convert/chatToResponses';
import {
  ChatStreamToResponsesConverter,
  serializeResponsesEvent,
} from './convert/chatToResponsesStream';
import type { RequestLogRecord } from '../domain/requestLog';
import { AppError } from '../http/errors';

export type GatewayPath = '/chat/completions' | '/messages' | '/responses';

export interface ForwardTarget {
  /**
   * 需要把 Responses 请求转成 Chat 发给上游（`protocolConversion` 打开时）。
   * 为真时请求体、响应体、流式事件都要经过转换。
   *
   * 这个标记挂在 target 而不是 ForwardOptions 上：回退候选可能来自另一种协议，
   * 主供应商直通、备选需要转换是完全可能的。挂在请求级会让回退方向转错或漏转。
   */
  convertResponsesToChat?: boolean;
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
 * 每条网关路径要求的上游协议：
 * - /v1/chat/completions → openai
 * - /v1/messages          → anthropic
 * - /v1/responses         → responses（OpenAI Responses API）
 *
 * 这是**默认**要求，不匹配一律 501。唯一的放宽是 `protocolConversion` 打开后
 * `/v1/responses → openai`（见 assertApiTypeMatch），因为只有这一个方向有转换器；
 * 其余组合即便开关打开也仍然拒绝，别把这里当成"任意协议互转"的入口。
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

/**
 * 转换请求时要打的上游路径。
 *
 * 关键：请求体被改写成 Chat 形状后，路径也必须跟着变成 `/chat/completions`。
 * 只改 body 不改路径的话，Chat 上游会收到一个打到自己 `/responses` 端点的
 * Chat 请求体，返回 404 或奇怪的参数错误。
 */
/**
 * 上游实际要打的路径。
 *
 * 转换时**必须**改成 /chat/completions：只改请求体不改路径，就是把 Chat 形状的
 * body 发到 /responses 端点，上游会报 404 或奇怪参数错误（真实踩过）。
 *
 * 导出是给诊断接口用的，让它算出的 URL 与实际转发一致——诊断自己拼一份路径
 * 就会出现"诊断说打 A、实际打 B"，比没有诊断更误导。
 */
export function upstreamPathFor(
  // 只取这一个字段：诊断接口传的是选路结果（Candidate），不是完整的 ForwardTarget
  target: Pick<ForwardTarget, 'convertResponsesToChat'>,
  path: GatewayPath,
): GatewayPath {
  return target.convertResponsesToChat === true ? '/chat/completions' : path;
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
  /**
   * 本次请求的响应语言。
   *
   * 网关直接写 `reply`（不经过错误处理器），所以转换失败这类响应要在这里自己渲染。
   * 缺省中文：保持既有内部调用（测试、回退重试）行为不变。
   */
  language?: UiLanguage;
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
    options.loggerWarn('logs.gateway.logWriteFailed', error);
  }
}

/**
 * 单次转发。流式时逐块透传，客户端断开立即 abort 上游，
 * 避免上游继续计费生成没人要的 token。
 *
 * 开了 `convertResponsesToChat` 时三条通道都要转换：请求体在发请求前改写、非流式响应
 * 转成 Responses 形状、流式逐事件翻译。任何一条漏了，Codex 侧都会表现为"没有输出"或
 * 一直等待——它只认 Responses 的形状。
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

  let payload: Record<string, unknown> = { ...body };
  if (target.modelRewritten) payload.model = target.upstreamModel;

  // 跨协议转发：把 Responses 请求体改写成 Chat 形状。
  // 转换失败必须在发出请求**之前**报错——否则上游会收到一个残缺请求，
  // 返回的参数错误与本服务无关，排查方向会被带偏。
  const convertRequest = target.convertResponsesToChat === true;
  /** custom 工具名：响应方向要把它们的调用还原成 custom_tool_call */
  const customToolNames = new Set<string>();
  if (convertRequest) {
    try {
      const originalTools = body.tools;
      if (Array.isArray(originalTools)) {
        for (const tool of originalTools) {
          if (
            typeof tool === 'object' &&
            tool !== null &&
            (tool as { type?: unknown }).type === 'custom' &&
            typeof (tool as { name?: unknown }).name === 'string'
          ) {
            customToolNames.add((tool as { name: string }).name);
          }
        }
      }
      const converted = responsesToChatRequest(payload, String(payload.model ?? target.upstreamModel));
      payload = converted.body;
    } catch (cause) {
      const message = cause instanceof ConversionError ? cause.message : String(cause);
      writeLog(options, { status: 400, latencyMs: Date.now() - startedAt, stream, error: message });
      reply.statusCode = 400;
      reply.setHeader('content-type', 'application/json');
      reply.end(
        JSON.stringify({
          error: {
            code: 'conversion_failed',
            message: translate(options.language ?? 'zh', 'gateway.forward.requestConvertFailed', {
              detail: message,
            }),
          },
        }),
      );
      return { status: 400, stream, latencyMs: Date.now() - startedAt, error: message };
    }
  }

  try {
    const response = await fetch(upstreamUrl(target.provider, upstreamPathFor(target, path)), {
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
        // 文案同时用作日志与（非流式时的）响应体，因此走字典而不是硬编码
        const emptyUpstream = translate(
          options.language ?? 'zh',
          'gateway.forward.upstreamEmptyBody',
        );
        reply.end();
        writeLog(options, {
          status: 502,
          latencyMs,
          stream: true,
          error: emptyUpstream,
        });
        return { status: 502, stream: true, latencyMs, error: emptyUpstream };
      }
      try {
        if (convertRequest) {
          // 逐行解析上游的 Chat SSE，翻译成 Responses 事件再写给客户端。
          // 不能攒完整个响应：那等于把流式退化成非流式，Codex 会看起来卡住。
          const converter = new ChatStreamToResponsesConverter(
            String(payload.model ?? target.upstreamModel),
            undefined,
            customToolNames,
          );
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            buffer += decoder.decode(value, { stream: true });
            // SSE 以换行分隔；只处理完整的行，残留部分留到下次
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex >= 0) {
              const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
              buffer = buffer.slice(newlineIndex + 1);
              for (const event of converter.feedLine(line)) {
                reply.write(serializeResponsesEvent(event));
              }
              newlineIndex = buffer.indexOf('\n');
            }
          }
          // 上游可能没发 [DONE] 就断开，兜底补完事件，否则 Codex 会一直等
          if (buffer.trim() !== '') {
            for (const event of converter.feedLine(buffer.replace(/\r$/, ''))) {
              reply.write(serializeResponsesEvent(event));
            }
          }
          for (const event of converter.finish()) reply.write(serializeResponsesEvent(event));
          reply.end();
        } else {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) reply.write(Buffer.from(value));
          }
          reply.end();
        }
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

    let text = await response.text();
    const latencyMs = Date.now() - startedAt;

    if (convertRequest) {
      // Chat 响应 → Responses 形状。Codex 解析的是 output 数组，
      // 直接透传 Chat 的 choices 会让它认为"没有输出"。
      try {
        const converted = chatToResponsesResponse({
          model: String(payload.model ?? target.upstreamModel),
          chat: JSON.parse(text) as unknown,
          customToolNames,
        });
        text = JSON.stringify(converted);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        writeLog(options, { status: 502, latencyMs, stream: false, error: message });
        reply.statusCode = 502;
        reply.setHeader('content-type', 'application/json');
        reply.end(
          JSON.stringify({
            error: {
              code: 'conversion_failed',
              message: translate(options.language ?? 'zh', 'gateway.forward.responseConvertFailed', {
                detail: message,
              }),
            },
          }),
        );
        return { status: 502, stream: false, latencyMs, error: message };
      }
    }

    reply.statusCode = 200;
    reply.setHeader('content-type', 'application/json');
    if (options.fallback) reply.setHeader('x-llmapi-fallback', '1');
    reply.end(text);
    writeLog(options, { status: 200, latencyMs, stream: false });
    return { status: 200, stream: false, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? translate(options.language ?? 'zh', 'gateway.forward.requestAborted')
          : error.message
        : String(error);
    writeLog(options, { status: 502, latencyMs, stream, error: message });
    if (!reply.headersSent && !options.deferErrorWrite) {
      reply.statusCode = 502;
      reply.setHeader('content-type', 'application/json');
      reply.end(
        JSON.stringify({
          error: {
            code: 'upstream_error',
            message: translate(options.language ?? 'zh', 'gateway.forward.upstreamRequestFailed', {
              detail: message,
            }),
          },
        }),
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
  language: UiLanguage = 'zh',
): void {
  if (reply.headersSent || reply.writableEnded) return;
  reply.statusCode = outcome.status;
  reply.setHeader('content-type', outcome.upstreamContentType ?? 'application/json');
  reply.end(
    outcome.upstreamBody ??
      JSON.stringify({
        error: {
          code: 'upstream_error',
          message:
            outcome.error ??
            translate(language, 'gateway.forward.upstreamStatus', { status: outcome.status }),
        },
      }),
  );
}

/**
 * 路径与上游协议不匹配就拒绝。必须在真正发上游请求之前调用（见 routes/gateway.ts）：
 * 一旦请求已经打出去，客户端拿到的会是上游的参数错误，而看不出是本服务选错了协议。
 *
 * `allowConversion` 是用户开关（不是一个"要不要严格"的权限位）。即便为真也只放过
 * Responses→Chat 这一种组合——别处没有转换器，放过就是把非法请求交给上游。
 */
export function assertApiTypeMatch(
  provider: ProviderRecord,
  path: GatewayPath,
  allowConversion = false,
): void {
  const required = requiredApiType(path);
  if (required && provider.apiType !== required) {
    // 只有 Responses→Chat 这一个方向有转换器；其余组合仍然拒绝。
    // 打开了开关却没转换器，说明是代码/配置对不上，不能放行。
    const convertible =
      allowConversion && required === 'responses' && provider.apiType === 'openai';
    if (convertible) return;
    const params = { path, apiType: provider.apiType, required, name: provider.name };
    throw new AppError(
      'not_implemented',
      {
        key: allowConversion ? 'gateway.forward.conversionUnsupported' : 'gateway.forward.conversionDisabled',
        params,
      },
      // 机读标记：前端据此弹出"一键开启"提示，而不是只让用户读一句错误文字。
      // 只有"开关没开、但打开就能解决"这种情况才带，避免误导。
      allowConversion || required !== 'responses' || provider.apiType !== 'openai'
        ? undefined
        : { canEnableConversion: true },
    );
  }
}
