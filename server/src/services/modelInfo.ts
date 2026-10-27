import { filterInputModalities, filterReasoningEfforts, type ModelCapability } from '../domain/provider';
import { normalizeModelKey } from './modelRegistry';

/**
 * modelinfo.dev 的模型目录。
 *
 * 与 models.dev 的分工（已实测交叉验证）：
 * - **modelinfo 优先**：`reasoning.efforts` 是**直接给出**的数组，不需要按 provider 投票，
 *   而且它和 models.dev 的多数票结果完全一致（claude/gpt 系列逐项吻合）。
 * - **models.dev 补空**：modelinfo 只覆盖我们 11 个模型里的 9 个，且有 221 条是
 *   "supported=true 但 efforts=[]"（我们的 glm-5.3-flash / glm-5.3-flashx /
 *   kimi-k2.7-code 都属于这种）。空数组不能当成"没有档位"，要继续问 models.dev。
 *
 * 端点只有一个：`/v1/models`（OpenAI 风格 `{object:"list", data:[...]}`）。
 * 文档页是 SPA，`api.json` / `models.json` / `catalog.json` 全部 404 —— 别照搬 models.dev 的路径。
 */

interface ModelInfoEntry {
  id?: string;
  limits?: { context?: unknown; output?: unknown };
  modalities?: { input?: unknown };
  reasoning?: { supported?: unknown; efforts?: unknown };
}

const DEFAULT_URL = 'https://modelinfo.dev/v1/models';
const TIMEOUT_MS = 10_000;
/**
 * 缓存 6 小时。对方给的是 `max-age=300`，但我们只在离线同步命令里用它，
 * 没必要跟着 5 分钟一刷；太短会让"演练 + 落盘"两次调用拿到不同数据。
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CacheEntry {
  at: number;
  index: Record<string, ModelCapability>;
}

let cache: CacheEntry | null = null;

export function modelInfoUrl(): string {
  const custom = process.env.MODELINFO_URL?.trim();
  return custom && custom !== '' ? custom : DEFAULT_URL;
}

/** 供测试与同步脚本用：把一条 modelinfo 条目映射成我们的能力结构。 */
export function toCapability(entry: ModelInfoEntry): ModelCapability | undefined {
  const capability: ModelCapability = {};

  const context = toPositiveInt(entry.limits?.context);
  if (context !== undefined) capability.contextWindow = context;

  const output = toPositiveInt(entry.limits?.output);
  if (output !== undefined) capability.maxOutputTokens = output;

  if (typeof entry.reasoning?.supported === 'boolean') {
    capability.supportsReasoning = entry.reasoning.supported;
  }

  // efforts 为空数组时**不写这个字段**：它表示"支持推理但档位未知"，
  // 合并时应该继续去问 models.dev，而不是把它当成"没有档位"落盘。
  const efforts = filterReasoningEfforts(entry.reasoning?.efforts);
  if (efforts.length > 0) capability.reasoningEfforts = efforts;

  // modelinfo 的模态词表比 models.dev 多一个 `document`，同样过白名单。
  if (Array.isArray(entry.modalities?.input)) {
    const filtered = filterInputModalities(entry.modalities.input);
    if (filtered.length > 0) capability.inputModalities = filtered;
  }

  return Object.keys(capability).length > 0 ? capability : undefined;
}

function toPositiveInt(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}

/**
 * 建立归一化索引。同名多条时记为空（不可用），与 modelRegistry 的策略一致：
 * 挑一条等于给出别家模型的能力，比"不知道"更糟。
 */
export function buildIndex(payload: unknown): Record<string, ModelCapability[]> | null {
  if (!payload || typeof payload !== 'object') return null;
  const list = (payload as { data?: unknown }).data;
  if (!Array.isArray(list)) return null;

  const index: Record<string, ModelCapability[]> = {};
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (raw as ModelInfoEntry).id;
    if (typeof id !== 'string') continue;
    const capability = toCapability(raw as ModelInfoEntry);
    if (!capability) continue;
    const key = normalizeModelKey(id);
    if (key === '') continue;
    (index[key] ??= []).push(capability);
  }
  return index;
}

/** 查一个上游裸模型名；唯一命中才返回。 */
export function lookup(
  index: Record<string, ModelCapability[]> | null,
  upstreamModel: string,
): ModelCapability | undefined {
  if (!index) return undefined;
  const hits = index[normalizeModelKey(upstreamModel)];
  if (!hits || hits.length !== 1) return undefined;
  return hits[0];
}

/**
 * 拉取并建立索引。任何失败都返回 null，不抛异常 ——
 * 这是补全数据源，不能让"生成 Codex 配置"依赖它的可达性。
 */
export async function fetchModelInfo(options?: {
  force?: boolean;
  url?: string;
}): Promise<Record<string, ModelCapability[]> | null> {
  const now = Date.now();
  if (!options?.force && cache && now - cache.at < CACHE_TTL_MS) {
    return indexFromCache(cache.index);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(options?.url ?? modelInfoUrl(), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const index = buildIndex((await response.json()) as unknown);
    if (!index) return null;
    const flat: Record<string, ModelCapability> = {};
    for (const [key, list] of Object.entries(index)) {
      if (list.length === 1) flat[key] = list[0];
    }
    cache = { at: now, index: flat };
    return index;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function indexFromCache(flat: Record<string, ModelCapability>): Record<string, ModelCapability[]> {
  const index: Record<string, ModelCapability[]> = {};
  for (const [key, value] of Object.entries(flat)) index[key] = [value];
  return index;
}

/** 仅供测试。 */
export function __clearModelInfoCache(): void {
  cache = null;
}
