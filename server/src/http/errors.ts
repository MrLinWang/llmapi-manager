import type { LocalizedText, MessageKey, MessageParams } from '../i18n';
import { render } from '../i18n';
import type { UiLanguage } from '../domain/settings';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'not_implemented'
  | 'upstream_error'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_implemented: 501,
  upstream_error: 502,
  internal_error: 500,
};

/**
 * 应用错误。
 *
 * 文案存"键 + 参数"而不是成品字符串：同一处报错要能按请求语言渲染，
 * 且测试可以直接断言键名——断言译文会让每次文案微调都变成测试失败。
 *
 * 但**同时保留可读的 `message`**：日志、堆栈与 `instanceof` 分支都在用它，
 * 而且 `AppError` 通常在还没有 request 上下文的深调用栈里构造。
 * 构造函数里的 `message` 是中文渲染结果（部署者默认语言），
 * 响应阶段由错误处理器按请求语言重新渲染。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  /** 文案键与参数：响应阶段据此重渲染成请求语言 */
  readonly text: LocalizedText;

  constructor(code: ErrorCode, text: LocalizedText | MessageKey, details?: unknown) {
    const localized: LocalizedText = typeof text === 'string' ? { key: text } : text;
    // 中文渲染作为 `Error.message`：日志里看到的始终是可读中文，不是键名
    super(render('zh', localized));
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
    this.text = localized;
  }

  /** 该报错的文案键（测试与诊断用）。 */
  get messageKey(): MessageKey {
    return this.text.key;
  }

  /** 按指定语言渲染响应体。 */
  toBody(language: UiLanguage): {
    error: { code: ErrorCode; message: string; messageKey: MessageKey; details?: unknown };
  } {
    return {
      error: {
        code: this.code,
        message: render(language, this.text),
        // 同时返回键名：调用方（前端、脚本、诊断）可以据它做分支，
        // 而不必匹配会随语言变化的文案。
        messageKey: this.text.key,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** 便捷构造：键 + 插值参数。 */
export const badRequest = (key: MessageKey, params?: MessageParams, details?: unknown): AppError =>
  new AppError('bad_request', { key, params }, details);
export const unauthorized = (
  key: MessageKey = 'errors.unauthorized',
  params?: MessageParams,
): AppError => new AppError('unauthorized', { key, params });
export const forbidden = (
  key: MessageKey = 'errors.forbidden',
  params?: MessageParams,
): AppError => new AppError('forbidden', { key, params });
export const notFound = (
  key: MessageKey = 'errors.notFound',
  params?: MessageParams,
): AppError => new AppError('not_found', { key, params });
export const conflict = (key: MessageKey, params?: MessageParams, details?: unknown): AppError =>
  new AppError('conflict', { key, params }, details);
export const notImplemented = (key: MessageKey, params?: MessageParams): AppError =>
  new AppError('not_implemented', { key, params });
export const internalError = (
  key: MessageKey = 'errors.internal',
  params?: MessageParams,
): AppError => new AppError('internal_error', { key, params });
