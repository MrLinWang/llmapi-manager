import fs from 'node:fs';
import path from 'node:path';
import { addWarning } from '../resilience';
import type { Logger } from '../logger';

export interface Envelope<T> {
  schemaVersion: number;
  data: T;
}

export interface JsonFileOptions<T> {
  filePath: string;
  schemaVersion: number;
  defaultValue: () => T;
  /** 未来版本读取：默认拒绝，避免把不认识的结构当成空数据覆盖掉。 */
  onUnknownVersion?: 'error' | 'accept';
  logger?: Logger;
}

export interface JsonFile<T> {
  readonly filePath: string;
  read(): T;
  write(data: T): void;
}

/**
 * rename 在 Windows 上的瞬时失败码：目标文件正被杀毒软件/索引器/另一个进程打开时，
 * `MoveFileEx` 会返回 EPERM/EBUSY/EACCES。这不是数据错误，稍等重试就能成功。
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [10, 20, 50] as const;

/** 同步睡眠：写入路径是同步 API（createJsonFile.write 返回 void），不能 await。 */
function sleepSync(ms: number): void {
  // Atomics.wait 是标准库里唯一不忙等的同步睡眠；SharedArrayBuffer 不会被实际修改。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RenameRetryOptions {
  /** 测试注入；默认 fs.renameSync */
  rename?: (from: string, to: string) => void;
  /** 测试注入；默认同步 Atomics.wait */
  sleep?: (ms: number) => void;
}

/**
 * 临时文件 → 目标文件的重命名，瞬时失败最多重试 3 次（10/20/50ms）。
 *
 * 为什么必须重试：Windows 没有 POSIX 的"rename 覆盖是原子且几乎不失败"的保证。
 * 杀毒软件/Windows Search 会短暂持有文件句柄，rename 抛 EPERM，表现为**偶发写入失败**
 * ——用户看到保存报错，重试一次又好了，极难归因。三次总等待 80ms，足够让持锁方释放。
 *
 * 非瞬时错误（ENOENT、EXDEV 等）立即抛出：重试解决不了，只会掩盖真实问题。
 */
export function renameWithRetry(
  tmp: string,
  filePath: string,
  options: RenameRetryOptions = {},
): void {
  const rename = options.rename ?? fs.renameSync;
  const sleep = options.sleep ?? sleepSync;

  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(tmp, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable =
        code !== undefined &&
        TRANSIENT_RENAME_CODES.has(code) &&
        attempt < RENAME_RETRY_DELAYS_MS.length;
      if (!retryable) throw error;
      sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function writeFileAtomic(filePath: string, content: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  try {
    renameWithRetry(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function quarantine(filePath: string, reason: string, logger?: Logger): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${filePath}.corrupt-${stamp}`;
  try {
    fs.renameSync(filePath, target);
    logger?.warn('logs.store.quarantined', { file: path.basename(filePath), target, reason });
    addWarning('corrupt_file', 'warnings.corruptFileQuarantined', {
      file: path.basename(filePath),
      target: path.basename(target),
    });
  } catch (error) {
    logger?.error('logs.store.quarantineFailed', { file: filePath, error });
    addWarning('corrupt_file', 'warnings.corruptFileNotQuarantined', {
      file: path.basename(filePath),
    });
  }
}

export function createJsonFile<T>(options: JsonFileOptions<T>): JsonFile<T> {
  const { filePath, schemaVersion, defaultValue, logger } = options;

  const read = (): T => {
    if (!fs.existsSync(filePath)) return defaultValue();
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      logger?.error('logs.store.readFailed', { file: filePath, error });
      return defaultValue();
    }
    if (raw.trim() === '') return defaultValue();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      quarantine(filePath, error instanceof Error ? error.message : 'JSON parse failed', logger);
      return defaultValue();
    }

    if (parsed && typeof parsed === 'object' && 'schemaVersion' in (parsed as object)) {
      const envelope = parsed as Envelope<T>;
      const version = Number(envelope.schemaVersion);
      if (version > schemaVersion) {
        quarantine(
          filePath,
          `file schemaVersion ${version} is newer than the supported ${schemaVersion}`,
          logger,
        );
        return defaultValue();
      }
      return envelope.data ?? defaultValue();
    }

    // 无信封的旧结构：按当前 schema 视作裸数据，保证升级路径不丢数据
    return parsed as T;
  };

  const write = (data: T): void => {
    const envelope: Envelope<T> = { schemaVersion, data };
    writeFileAtomic(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  };

  return { filePath, read, write };
}

export function appendJsonLine(filePath: string, record: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function readJsonLines<T>(filePath: string, limit?: number): T[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const target = limit && limit > 0 ? lines.slice(-limit) : lines;
  const out: T[] = [];
  for (const line of target) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // 单行损坏不应让整份日志不可读
    }
  }
  return out;
}
