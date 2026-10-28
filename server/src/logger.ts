import fs from 'node:fs';
import path from 'node:path';
import type { LogLanguage, LogLevel } from './config';
import { translate, type MessageKey, type MessageParams } from './i18n';

export interface Logger {
  /**
   * 第一条参数既可以是成品文案，也可以是**文案键**。
   *
   * 键形如 `logs.gateway.fallbackAttempted`：logger 按 `logLanguage` 渲染它，
   * 插值参数走 `meta`。这样调用点不用每处都 `translate(...)`，也避免
   * "日志文案散落在 20 个地方、每处各自选语言"。
   *
   * 传成品文案也支持（含变量拼接的场景），此时不做翻译。
   */
  debug(message: MessageKey | string, meta?: LogMeta): void;
  info(message: MessageKey | string, meta?: LogMeta): void;
  warn(message: MessageKey | string, meta?: LogMeta): void;
  error(message: MessageKey | string, meta?: LogMeta): void;
  /** 关闭文件句柄；仅在使用文件日志时需要（进程退出、测试清理）。 */
  close?(): void;
}

/** 日志的 meta：既是插值参数，也照常序列化进日志行。 */
export type LogMeta = unknown;

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** 日志里出现这些键时一律打码，避免 API Key 通过错误对象泄漏到终端。 */
const SENSITIVE_KEYS = /^(apikey|api_key|authorization|token|password|secret|openai_api_key)$/i;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1***'],
  [/(Bearer\s+[A-Za-z0-9_-]{4})[A-Za-z0-9._-]+/gi, '$1***'],
];

function redactText(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

function format(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    // 带上调用栈：排查线上问题时，只有 message 往往不够
    const stack = meta.stack ? `\n${meta.stack}` : '';
    return ` ${meta.name}: ${redactText(meta.message)}${stack ? redactText(stack) : ''}`;
  }
  try {
    return ` ${JSON.stringify(redact(meta))}`;
  } catch {
    return ' [unserializable]';
  }
}

export interface FileLogOptions {
  /** 日志目录；启动时创建 */
  dir: string;
  /** 当前写入的文件名，默认 app.log */
  fileName?: string;
  /** 超过该字节数就滚动 */
  maxBytes: number;
  /** 保留的历史文件个数 */
  maxFiles: number;
}

interface FileSink {
  write(line: string): void;
  close(): void;
  readonly filePath: string;
}

/**
 * 追加写日志文件，按大小滚动。
 *
 * 为什么是同步写：日志量小（只有启动、转发失败、未处理异常等事件），
 * 同步能保证进程崩溃前最后一条日志已经落盘 —— 异步写反而可能丢掉最关键的那条。
 * 写日志本身出错绝不能拖垮服务，所以所有文件异常都被吞掉并降级为控制台输出。
 */
function createFileSink(options: FileLogOptions): FileSink {
  const fileName = options.fileName ?? 'app.log';
  const filePath = path.join(options.dir, fileName);
  const { maxBytes, maxFiles } = options;
  fs.mkdirSync(options.dir, { recursive: true });

  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }
  let handle: number | null = fs.openSync(filePath, 'a', 0o600);

  /** 滚动：app.log → app.1.log → app.2.log …，超出 maxFiles 的最老文件删除。 */
  const rotate = (): void => {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // 已经关掉或不可用，继续往下滚动
      }
      handle = null;
    }
    const ext = path.extname(fileName);
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    const nameOf = (index: number): string => `${base}.${index}${ext}`;

    try {
      fs.rmSync(path.join(options.dir, nameOf(maxFiles)), { force: true });
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const from = path.join(options.dir, nameOf(index));
        if (fs.existsSync(from)) fs.renameSync(from, path.join(options.dir, nameOf(index + 1)));
      }
      fs.renameSync(filePath, path.join(options.dir, nameOf(1)));
    } catch {
      // 滚动失败不致命：接下来截断重写，至少保证还能继续记日志
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // 忽略
      }
    }
    handle = fs.openSync(filePath, 'a', 0o600);
    size = 0;
  };

  return {
    filePath,
    write(line: string): void {
      const payload = `${line}\n`;
      const bytes = Buffer.byteLength(payload);
      if (size + bytes > maxBytes && size > 0) rotate();
      if (handle === null) return;
      try {
        fs.writeSync(handle, payload);
        size += bytes;
      } catch {
        // 磁盘满/权限问题：不抛，控制台仍然有输出
      }
    },
    close(): void {
      if (handle === null) return;
      try {
        fs.closeSync(handle);
      } catch {
        // 忽略
      }
      handle = null;
    },
  };
}

export interface LoggerOptions {
  /** 缺省时不落盘，只写控制台 */
  file?: FileLogOptions;
  /**
   * 日志语言，默认中文。由 `config.logLanguage`（`LOG_LANGUAGE`）决定：
   * 日志的读者是部署者，跟随请求语言漂移会让 grep 失效。
   */
  language?: LogLanguage;
}

/**
 * 键的样子：`logs.` 开头、且字典里确实有。
 *
 * 不用"是否全英文"判断——`logs.x` 与一条以英文开头的成品文案无法区分，
 * 而误判会把成品文案当成键、渲染成键名。用前缀 + 字典命中两道判断。
 */
function looksLikeKey(message: string): boolean {
  return (
    message.startsWith('logs.') ||
    message.startsWith('errors.') ||
    message.startsWith('warnings.')
  );
}

export function createLogger(level: LogLevel, options: LoggerOptions = {}): Logger {
  const threshold = ORDER[level];
  const sink = options.file ? createFileSink(options.file) : null;
  const language = options.language ?? 'zh';

  const emit = (target: LogLevel, message: string, meta?: unknown): void => {
    if (ORDER[target] < threshold) return;
    // 键 → 按日志语言渲染，meta 兼作插值参数；成品文案原样输出（仍做打码）
    const text = looksLikeKey(message)
      ? translate(language, message, meta as MessageParams | undefined)
      : message;
    const line = `[${new Date().toISOString()}] ${target.toUpperCase()} ${redactText(text)}${format(meta)}`;
    if (target === 'error') console.error(line);
    else if (target === 'warn') console.warn(line);
    else console.log(line);
    sink?.write(line);
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    close: () => sink?.close(),
  };
}

/** 便于启动日志与文档展示实际写入位置。 */
export function logFilePath(options: FileLogOptions): string {
  return path.join(options.dir, options.fileName ?? 'app.log');
}
