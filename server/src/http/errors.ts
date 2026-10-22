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

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = details;
  }

  toBody(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', message, details);
export const unauthorized = (message = '需要登录'): AppError =>
  new AppError('unauthorized', message);
export const forbidden = (message = '没有执行该操作的权限'): AppError =>
  new AppError('forbidden', message);
export const notFound = (message = '资源不存在'): AppError =>
  new AppError('not_found', message);
export const conflict = (message: string, details?: unknown): AppError =>
  new AppError('conflict', message, details);
