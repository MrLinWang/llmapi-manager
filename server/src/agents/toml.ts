/**
 * 极简 TOML 编辑器：只处理"我们拥有的键"，其余行原样保留。
 * 支持：
 *  - 顶层标量键 model_provider / model
 *  - 表 [model_providers.llmapi] 下的标量键
 * 不支持的复杂语法（内联表、数组表）一律不碰，交给用户自己维护。
 */

export interface TomlScalarEdit {
  /** 顶层键名，或表内的键名 */
  key: string;
  value: string;
  /** 目标表名，如 model_providers.llmapi；为空表示顶层 */
  table?: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keyPattern(key: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
}

function headerOf(line: string): string | null {
  const match = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line);
  return match ? match[1].trim() : null;
}

interface Section {
  header: string | null;
  start: number;
  end: number;
}

function sectionsOf(lines: string[]): Section[] {
  const result: Section[] = [];
  let current: Section = { header: null, start: 0, end: lines.length };
  for (let i = 0; i < lines.length; i += 1) {
    const header = headerOf(lines[i]);
    if (header !== null) {
      current.end = i;
      result.push(current);
      current = { header, start: i, end: lines.length };
    }
  }
  result.push(current);
  return result;
}

export function readTomlScalar(
  content: string,
  key: string,
  table?: string,
): string | null {
  const lines = content.split('\n');
  const section = sectionsOf(lines).find((item) => (item.header ?? null) === (table ?? null));
  if (!section) return null;
  // 顶层段没有表头行，从段首开始；有表头时跳过表头那一行
  const from = section.header === null ? section.start : section.start + 1;
  for (let i = from; i < section.end; i += 1) {
    if (!keyPattern(key).test(lines[i])) continue;
    const raw = lines[i].slice(lines[i].indexOf('=') + 1).trim();
    const withoutComment = raw.replace(/\s+#.*$/, '');
    if (withoutComment.startsWith('"') && withoutComment.endsWith('"')) {
      try {
        return JSON.parse(withoutComment) as string;
      } catch {
        return withoutComment.slice(1, -1);
      }
    }
    if (withoutComment.startsWith("'") && withoutComment.endsWith("'")) {
      return withoutComment.slice(1, -1);
    }
    return withoutComment === '' ? null : withoutComment;
  }
  return null;
}

function setInSection(lines: string[], edit: TomlScalarEdit, section: Section): string[] {
  const next = [...lines];
  const line = `${edit.key} = ${tomlString(edit.value)}`;

  for (let i = section.start + 1; i < section.end; i += 1) {
    if (keyPattern(edit.key).test(next[i])) {
      next[i] = line;
      return next;
    }
  }

  if (section.header === null) {
    // 顶层：追加到第一个表头之前，保持顶层键聚在一起
    const insertAt = section.end;
    next.splice(insertAt, 0, line);
    return next;
  }

  // 表内：插到该表最后一行有内容的行之后（跳过尾部空行）
  let insertAt = section.end;
  while (insertAt > section.start + 1 && next[insertAt - 1].trim() === '') {
    insertAt -= 1;
  }
  next.splice(insertAt, 0, line);
  return next;
}

export function applyTomlEdits(content: string, edits: TomlScalarEdit[]): string {
  let lines = content === '' ? [] : content.replace(/\r\n/g, '\n').split('\n');
  const hadTrailingNewline = content.endsWith('\n');

  for (const edit of edits) {
    if (edit.table) {
      let section = sectionsOf(lines).find((item) => item.header === edit.table);
      if (!section) {
        if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push(`[${edit.table}]`);
        section = { header: edit.table, start: lines.length - 1, end: lines.length };
      }
      lines = setInSection(lines, edit, section);
      continue;
    }
    const root = sectionsOf(lines)[0];
    lines = setInSection(lines, edit, { ...root, start: -1 });
  }

  let result = lines.join('\n');
  if (hadTrailingNewline && !result.endsWith('\n')) result += '\n';
  if (result !== '' && !result.endsWith('\n')) result += '\n';
  return result;
}

/** 删除我们写入的键；仅在当前值仍等于 expected 时才删，避免抹掉用户改动。 */
export function removeTomlKeyIfValue(
  content: string,
  key: string,
  expected: string,
  table?: string,
): { content: string; removed: boolean; currentValue: string | null } {
  const currentValue = readTomlScalar(content, key, table);
  if (currentValue === null) {
    return { content, removed: false, currentValue: null };
  }
  if (currentValue !== expected) {
    return { content, removed: false, currentValue };
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const section = sectionsOf(lines).find((item) => (item.header ?? null) === (table ?? null));
  if (!section) return { content, removed: false, currentValue };

  const flag = { removed: false };
  const next: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const inSection = i > (section.header === null ? -1 : section.start) && i < section.end;
    if (inSection && keyPattern(key).test(lines[i])) {
      flag.removed = true;
      continue;
    }
    next.push(lines[i]);
  }

  // 表内最后一个键被移除后，顺手删掉只剩空行的表头，避免留下空的 [model_providers.llmapi]
  const cleaned = table ? pruneEmptyTable(next, table) : next;
  return { content: cleaned.join('\n'), removed: flag.removed, currentValue };
}

/** 仅当该表只剩空行/注释时移除表头；有用户内容一律保留。 */
function pruneEmptyTable(lines: string[], table: string): string[] {
  const section = sectionsOf(lines).find((item) => item.header === table);
  if (!section) return lines;

  const body = lines.slice(section.start + 1, section.end);
  const hasContent = body.some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
  if (hasContent) return lines;

  // 连同表头所在的空行一起删掉，保持文件整洁
  const end = section.end;
  const start = section.start;
  const next = [...lines.slice(0, start), ...lines.slice(end)];
  while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
  next.push('');
  return next;
}

/** 读取表下所有标量键，供预览 diff 使用。 */
export function readTableScalars(content: string, table: string): Record<string, string> {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const section = sectionsOf(lines).find((item) => item.header === table);
  if (!section) return {};
  const out: Record<string, string> = {};
  for (let i = section.start + 1; i < section.end; i += 1) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const raw = match[2].replace(/\s+#.*$/, '').trim();
    out[match[1]] = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return out;
}
