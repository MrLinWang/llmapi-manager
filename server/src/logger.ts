import type { LogLevel } from './config';

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
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
    return ` ${meta.name}: ${redactText(meta.message)}`;
  }
  try {
    return ` ${JSON.stringify(redact(meta))}`;
  } catch {
    return ' [unserializable]';
  }
}

export function createLogger(level: LogLevel): Logger {
  const threshold = ORDER[level];

  const emit = (target: LogLevel, message: string, meta?: unknown): void => {
    if (ORDER[target] < threshold) return;
    const line = `[${new Date().toISOString()}] ${target.toUpperCase()} ${redactText(message)}${format(meta)}`;
    if (target === 'error') console.error(line);
    else if (target === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  };
}
