import fs from 'node:fs';
import path from 'node:path';
import type { LogLevel } from './config';

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  /** 关闭文件句柄；仅在使用文件日志时需要（进程退出、测试清理）。 */
  close?(): void;
}

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
}

export function createLogger(level: LogLevel, options: LoggerOptions = {}): Logger {
  const threshold = ORDER[level];
  const sink = options.file ? createFileSink(options.file) : null;

  const emit = (target: LogLevel, message: string, meta?: unknown): void => {
    if (ORDER[target] < threshold) return;
    const line = `[${new Date().toISOString()}] ${target.toUpperCase()} ${redactText(message)}${format(meta)}`;
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
