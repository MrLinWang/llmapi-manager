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

export function writeFileAtomic(filePath: string, content: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode });
  try {
    fs.renameSync(tmp, filePath);
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
