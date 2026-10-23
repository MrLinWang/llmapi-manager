import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, AgentId, AgentFileRole, PreviewEntry } from '../domain/agent';
import { AGENT_DEFINITIONS } from './registry';
import { applyTomlEdits, readTableScalars, readTomlScalar, removeTomlKeyIfValue } from './toml';

/** 我们写入某个 Agent 文件的目标键值集合。 */
export interface DesiredWrites {
  /** JSON 文件的点号路径，或 TOML 的读取键 */
  path: string;
  value: string;
  /** TOML 专属：所在表 */
  table?: string;
  /** TOML 专属：值为非字符串标量（如布尔 true）时原样写入，不加引号 */
  raw?: boolean;
  /**
   * TOML 专属：不写入，而是把这个键删掉。
   *
   * 用于"开关关掉后要撤销上一版写进去的键"——否则用户关了开关重新应用，
   * 旧值仍留在文件里，看起来像开关没生效。删除同样只在当前值等于 `value`
   * 时才执行，避免抹掉用户手改的值。
   */
  remove?: boolean;
}

export function readJsonPath(content: string, dotted: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  let cursor: unknown = parsed;
  for (const segment of dotted.split('.')) {
    if (!cursor || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null) return null;
  return typeof cursor === 'string' ? cursor : JSON.stringify(cursor);
}

export function applyJsonWrites(content: string, writes: DesiredWrites[]): string {
  let parsed: Record<string, unknown> = {};
  if (content.trim() !== '') {
    const candidate: unknown = JSON.parse(content);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('目标 JSON 顶层不是对象，拒绝覆盖');
    }
    parsed = candidate as Record<string, unknown>;
  }

  for (const write of writes) {
    const segments = write.path.split('.');
    let cursor: Record<string, unknown> = parsed;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const next = cursor[segment];
      if (next === undefined) {
        const created: Record<string, unknown> = {};
        cursor[segment] = created;
        cursor = created;
        continue;
      }
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        // 已有同名的非对象值：不擅自覆盖用户结构，直接报错让用户处理
        throw new Error(`字段 ${segments.slice(0, i + 1).join('.')} 不是对象，无法写入`);
      }
      cursor = next as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1]] = write.value;
  }

  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function removeJsonPathIfValue(
  content: string,
  dotted: string,
  expected: string,
): { content: string; removed: boolean; currentValue: string | null } {
  const currentValue = readJsonPath(content, dotted);
  if (currentValue === null) return { content, removed: false, currentValue: null };
  if (currentValue !== expected) return { content, removed: false, currentValue };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { content, removed: false, currentValue };
  }
  const segments = dotted.split('.');
  const stack: Array<Record<string, unknown>> = [parsed];
  for (let i = 0; i < segments.length - 1; i += 1) {
    const next = stack[stack.length - 1][segments[i]];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return { content, removed: false, currentValue };
    }
    stack.push(next as Record<string, unknown>);
  }
  const leafOwner = stack[stack.length - 1];
  delete leafOwner[segments[segments.length - 1]];

  // 清理因此变空的父级对象，避免留下一串 {} 噪音
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const container = stack[i];
    const key = segments[i];
    const child = container[key];
    if (child && typeof child === 'object' && Object.keys(child as object).length === 0) {
      delete container[key];
    } else {
      break;
    }
  }

  return { content: `${JSON.stringify(parsed, null, 2)}\n`, removed: true, currentValue };
}

function readCurrentValue(
  definition: AgentDefinition,
  role: AgentFileRole,
  content: string | null,
  write: DesiredWrites,
): string | null {
  if (content === null) return null;
  const spec = definition.files.find((item) => item.role === role);
  if (!spec) return null;
  return spec.format === 'toml'
    ? readTomlScalar(content, write.path, write.table)
    : readJsonPath(content, write.path);
}

export function buildPreviewEntries(
  definition: AgentDefinition,
  role: AgentFileRole,
  content: string | null,
  writes: DesiredWrites[],
): PreviewEntry[] {
  return writes.map((write) => {
    const current = readCurrentValue(definition, role, content, write);
    // 预览接口不能回传完整凭据：令牌/API Key 只显示前后片段
    const sensitive = isSensitivePreviewKey(write);
    return {
      key: write.table ? `[${write.table}] ${write.path}` : write.path,
      next: sensitive ? maskPreviewSecret(write.value) : write.value,
      current: current !== null && sensitive ? maskPreviewSecret(current) : current,
      differs: current !== null && current !== write.value,
    };
  });
}

/** 预览用脱敏：保留前 8 位与后 4 位，其余打码。 */
export function maskPreviewSecret(value: string): string {
  if (value === '') return value;
  if (value.length <= 12) return '*'.repeat(value.length);
  return `${value.slice(0, 8)}${'*'.repeat(8)}${value.slice(-4)}`;
}

const SENSITIVE_PREVIEW_KEY = /(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)/i;

function isSensitivePreviewKey(write: DesiredWrites): boolean {
  return (
    SENSITIVE_PREVIEW_KEY.test(write.path) ||
    (write.table !== undefined && SENSITIVE_PREVIEW_KEY.test(write.table))
  );
}

export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

export interface WriteResult {
  filePath: string;
  role: AgentFileRole;
  created: boolean;
  backupPath: string | null;
  values: Record<string, string>;
}

export interface ApplyFilesOptions {
  agentId: AgentId;
  definition: AgentDefinition;
  /** role → 目标文件绝对路径 */
  paths: Record<AgentFileRole, string | undefined>;
  /** role → 目标键值 */
  writes: Partial<Record<AgentFileRole, DesiredWrites[]>>;
  backupsDir: string;
  /**
   * 整体生成的文件（如 Codex 模型目录）：不做按键合并，直接用 content 覆盖。
   * 仍然遵守"写前备份"与"记录 created 以便还原时删除"。
   */
  generatedFiles?: Array<{ role: AgentFileRole; path: string; content: string }>;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * 写入前先备份；只改我们拥有的键；格式解析失败即停，绝不退回"写空文件"。
 */
export function applyAgentWrites(options: ApplyFilesOptions): WriteResult[] {
  const results: WriteResult[] = [];

  for (const [role, writes] of Object.entries(options.writes) as Array<
    [AgentFileRole, DesiredWrites[] | undefined]
  >) {
    if (!writes || writes.length === 0) continue;
    const filePath = options.paths[role];
    if (!filePath) continue;

    const spec = options.definition.files.find((item) => item.role === role);
    if (!spec) continue;

    const existing = readFileSafe(filePath);
    const created = existing === null;

    let nextContent: string;
    if (spec.format === 'toml') {
      const additions = writes.filter((write) => write.remove !== true);
      const removals = writes.filter((write) => write.remove === true);
      const edits = additions.map((write) => ({
        key: write.path,
        value: write.value,
        table: write.table,
        raw: write.raw,
      }));
      nextContent = applyTomlEdits(existing ?? '', edits);
      for (const removal of removals) {
        const outcome = removeTomlKeyIfValue(
          nextContent,
          removal.path,
          removal.value,
          removal.table,
        );
        nextContent = outcome.content;
      }
    } else {
      nextContent = applyJsonWrites(existing ?? '', writes);
    }

    let backupPath: string | null = null;
    if (existing !== null) {
      fs.mkdirSync(options.backupsDir, { recursive: true });
      const backupName = `${timestamp()}-${path.basename(filePath)}`;
      backupPath = path.join(options.backupsDir, backupName);
      fs.writeFileSync(backupPath, existing, { mode: 0o600 });
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, nextContent, { mode: 0o600 });
    fs.renameSync(tmp, filePath);

    const values: Record<string, string> = {};
    for (const write of writes) {
      // 删除项不进快照：它的语义是"让这个键消失"，不是"我们写了某个值"，
      // 放进去会让还原逻辑去找一个本就不存在的值。
      if (write.remove === true) continue;
      values[write.table ? `[${write.table}] ${write.path}` : write.path] = write.value;
    }
    results.push({ filePath, role, created, backupPath, values });
  }

  // 生成类文件：整体覆盖，不参与按键合并
  for (const file of options.generatedFiles ?? []) {
    const existing = readFileSafe(file.path);
    let backupPath: string | null = null;
    if (existing !== null) {
      fs.mkdirSync(options.backupsDir, { recursive: true });
      backupPath = path.join(options.backupsDir, `${timestamp()}-${path.basename(file.path)}`);
      fs.writeFileSync(backupPath, existing, { mode: 0o600 });
    }
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    const tmp = `${file.path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, file.content, { mode: 0o600 });
    fs.renameSync(tmp, file.path);

    // values 留空：没有"我们写入的键"可撤销；还原时靠 created 决定是否删文件
    results.push({
      filePath: file.path,
      role: file.role,
      created: existing === null,
      backupPath,
      values: {},
    });
  }

  return results;
}

export interface RevertConflict {
  key: string;
  expected: string;
  current: string | null;
}

export interface RevertResult {
  restored: string[];
  conflicts: RevertConflict[];
}

/**
 * 还原：仅当"当前值仍然等于我们当初写入的值"时才移除该键。
 * 用户改过的值保留并作为冲突返回，避免抹掉用户手改的配置。
 */
export function revertAgentWrites(
  definition: AgentDefinition,
  files: Array<{
    role: AgentFileRole;
    path: string;
    values: Record<string, string>;
    created?: boolean;
  }>,
): RevertResult {
  const restored: string[] = [];
  const conflicts: RevertConflict[] = [];

  for (const file of files) {
    const spec = definition.files.find((item) => item.role === file.role);
    if (!spec) continue;
    const content = readFileSafe(file.path);
    if (content === null) continue;

    // 生成类文件（模型目录）没有"我们写入的键"，整份都是我们写的：
    // 由我们创建的直接删掉；预先存在的置为 `{}` 并保留，避免误删用户内容。
    if (spec.generated) {
      if (Object.keys(file.values).length === 0) {
        if (file.created) {
          fs.rmSync(file.path, { force: true });
          restored.push(path.basename(file.path));
        } else {
          const tmp = `${file.path}.${process.pid}.revert.tmp`;
          fs.writeFileSync(tmp, '{}\n', { mode: 0o600 });
          fs.renameSync(tmp, file.path);
          conflicts.push({
            key: path.basename(file.path),
            expected: '(由本服务生成)',
            current: '文件原本存在，已重置为空对象',
          });
        }
        continue;
      }
    }

    let working = content;
    let changed = false;

    for (const [key, expected] of Object.entries(file.values)) {
      const tableMatch = /^\[(.+)\]\s+(.+)$/.exec(key);
      const table = tableMatch?.[1];
      const keyPath = tableMatch ? tableMatch[2] : key;

      if (spec.format === 'toml') {
        const outcome = removeTomlKeyIfValue(working, keyPath, expected, table);
        if (outcome.removed) {
          working = outcome.content;
          changed = true;
          restored.push(key);
        } else if (outcome.currentValue !== null && outcome.currentValue !== expected) {
          conflicts.push({ key, expected, current: outcome.currentValue });
        }
        continue;
      }

      const outcome = removeJsonPathIfValue(working, keyPath, expected);
      if (outcome.removed) {
        working = outcome.content;
        changed = true;
        restored.push(key);
      } else if (outcome.currentValue !== null && outcome.currentValue !== expected) {
        conflicts.push({ key, expected, current: outcome.currentValue });
      }
    }

    if (!changed) continue;

    // 文件是本次应用时创建的，且还原后已无任何有效内容：直接删掉，别在家目录留空壳
    if (file.created && isEmptyDocument(working, spec.format)) {
      fs.rmSync(file.path, { force: true });
      continue;
    }

    const tmp = `${file.path}.${process.pid}.revert.tmp`;
    fs.writeFileSync(tmp, working, { mode: 0o600 });
    fs.renameSync(tmp, file.path);
  }

  return { restored, conflicts };
}

/** 判断文档在移除我们的键之后是否已无内容（TOML 忽略空行/注释，JSON 看是否有键）。 */
export function isEmptyDocument(content: string, format: 'json' | 'toml'): boolean {
  if (format === 'toml') {
    return content
      .split('\n')
      .every((line) => {
        const trimmed = line.trim();
        return trimmed === '' || trimmed.startsWith('#');
      });
  }
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed as object).length === 0
    );
  } catch {
    return false;
  }
}

export { AGENT_DEFINITIONS, readTableScalars };
