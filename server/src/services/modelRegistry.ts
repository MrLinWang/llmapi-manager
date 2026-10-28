import type { ModelCapability } from '../domain/provider';
import { filterInputModalities } from '../domain/provider';

/**
 * models.dev 的公开模型规格库（provider-agnostic）。
 *
 * 为什么需要它：上游 `/models` 只在中转商愿意透传时才给 context_limit / output_budget，
 * 拿不到就只能回落 128k —— 1M 上下文的上游会被 Codex 在 ~121k 处自动压缩。
 * models.dev 按模型名给出公开规格，正好补这个空缺。
 *
 * 为什么只用 `models.json` 而不是 `api.json` / `catalog.json`：
 * 我们面对的是**自建/聚合上游**，它不在 models.dev 收录的公开供应商里（已实测）。
 * 所以只有"与供应商无关"的模型元数据对我们有意义，按名字匹配是唯一可行的路径。
 *
 * 定位是**兜底**而非权威：上游自己声明的值永远优先，同样的数据 modelinfo.dev
 * 给得更直接时也优先于它（见 services/providers.ts 的 mergeCapabilities）。
 * 网络不可达时返回 null，调用方按"没有额外信息"处理，绝不影响主流程。
 */

/** models.dev 单个模型的字段子集：只保留 Codex 真正会读的那几个。 */
interface RegistryModel {
  id?: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: unknown };
  limit?: { context?: unknown; output?: unknown };
}

const DEFAULT_URL = 'https://models.dev/models.json?type=all';
const TIMEOUT_MS = 10_000;
/** 进程内缓存时长。models.dev 自身带 must-revalidate，一天一刷足够。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  at: number;
  value: Record<string, ModelCapability>;
}

let cache: CacheEntry | null = null;

export function registryUrl(): string {
  const custom = process.env.MODELS_DEV_URL?.trim();
  return custom && custom !== '' ? custom : DEFAULT_URL;
}

/**
 * 名字归一化：把 `.` 与 `-` 抹平、忽略大小写、去掉作者前缀。
 *
 * 必要性（实测）：上游叫 `claude-opus-5.5`，models.dev 叫 `anthropic/claude-opus-5-5`；
 * `deepseek-v4.1-flash` 对 `deepseek/deepseek-v4.1-flash`。不归一化就一个都匹配不上。
 *
 * 安全性：617 个模型名归一化后**没有一对冲突**（已实测），所以按名字匹配在这个数据集上
 * 是确定的，不是碰运气。即便如此仍保留"多候选即放弃"的防御（见 lookupModel）。
 */
export function normalizeModelKey(raw: string): string {
  const base = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  return base.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 把一条 models.dev 记录映射成我们的能力结构；一个可用字段都没有时返回 undefined。 */
export function toModelCapability(model: RegistryModel): ModelCapability | undefined {
  const capability: ModelCapability = {};

  const context = toPositiveInt(model.limit?.context);
  if (context !== undefined) capability.contextWindow = context;

  const output = toPositiveInt(model.limit?.output);
  if (output !== undefined) capability.maxOutputTokens = output;

  if (typeof model.reasoning === 'boolean') {
    capability.supportsReasoning = model.reasoning;
  }

  // 上游可能声称自己支持 pdf / video，而 Codex 的 InputModality 只有
  // text/image/audio —— 多写一个值会让**整份目录**解析失败并静默回退到
  // 内置官方模型列表（已实测，见 docs/agents.md）。所以一律过白名单。
  if (Array.isArray(model.modalities?.input)) {
    const filtered = filterInputModalities(model.modalities.input);
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
 * 构建归一化索引。同一个 key 出现多条时**记为空数组**，
 * 让 lookupModel 明确放弃而不是随便挑一条——挑错会给出别家模型的窗口。
 */
export function buildRegistryIndex(
  payload: unknown,
): Record<string, ModelCapability[]> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const index: Record<string, ModelCapability[]> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const capability = toModelCapability(value as RegistryModel);
    if (!capability) continue;
    const normalized = normalizeModelKey(key);
    if (normalized === '') continue;
    (index[normalized] ??= []).push(capability);
  }
  return index;
}

/** 查一个上游裸模型名。命中唯一一条才返回；没有或多条都返回 undefined。 */
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
 * 拉取并建立索引。任何失败（网络、超时、非 JSON、结构不符）都返回 null，
 * **不抛异常**：这是锦上添花的数据源，不能让它把"生成 Codex 配置"搞挂。
 */
export async function fetchModelRegistry(options?: {
  force?: boolean;
  url?: string;
}): Promise<Record<string, ModelCapability[]> | null> {
  const now = Date.now();
  if (!options?.force && cache && now - cache.at < CACHE_TTL_MS) {
    // 缓存的是索引；用一次空查询把"已缓存"与"命中"分开表达
    return indexFromCache(cache.value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(options?.url ?? registryUrl(), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    const index = buildRegistryIndex(payload);
    if (!index) return null;
    // 缓存展平后的单值索引：同一个归一化名有多条时存空数组（= 不可用）
    const flat: Record<string, ModelCapability> = {};
    for (const [key, list] of Object.entries(index)) {
      if (list.length === 1) flat[key] = list[0];
    }
    cache = { at: now, value: flat };
    return index;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function indexFromCache(
  flat: Record<string, ModelCapability>,
): Record<string, ModelCapability[]> {
  const index: Record<string, ModelCapability[]> = {};
  for (const [key, value] of Object.entries(flat)) index[key] = [value];
  return index;
}

/** 仅供测试：清空进程内缓存。 */
export function __clearRegistryCache(): void {
  cache = null;
}
