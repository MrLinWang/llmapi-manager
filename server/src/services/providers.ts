import { randomUUID } from 'node:crypto';
import type { TenantRepos } from '../store/tenantScope';
import type { SecretCodec } from '../crypto/secretCodec';
import {
  API_TYPES,
  allocateProviderKey,
  filterInputModalities,
  filterReasoningEfforts,
  toProviderView,
  type ApiType,
  type ModelCapability,
  type ProviderRecord,
  type ProviderView,
} from '../domain/provider';
import { badRequest, conflict, notFound } from '../http/errors';
import type { TenantSettings } from '../domain/settings';

export interface ProviderInput {
  name: string;
  apiType: ApiType;
  baseUrl: string;
  apiKey?: string;
  models?: string[];
  /**
   * 按模型名记录的上游能力（上下文窗口 / 输出上限）。
   *
   * 由「从上游获取模型」或显式提交带上来；不传表示"保持已存的值不变"，
   * 传空对象表示"明确清空"。注意**不要**在没有新数据时退回默认值，
   * 那会把之前拉到的真实能力覆盖成保守值。
   */
  modelCapabilities?: Record<string, ModelCapability>;
  enabled?: boolean;
  priority?: number;
  notes?: string;
  websiteUrl?: string;
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw badRequest('providers.validation.baseUrlEmpty');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw badRequest('providers.validation.baseUrlInvalid', { url: input });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('providers.validation.baseUrlProtocol');
  }
  return trimmed;
}

function normalizeModels(models: string[] | undefined): string[] {
  if (!models) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const model = raw.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  return out;
}

/**
 * 规范化模型能力表。
 *
 * 三条规则都是有原因的：
 * 1. 只保留仍在 `models` 里的条目 —— 模型删掉了，它的能力就是死数据，
 *    留着会让"下一个人同名模型"读到上一个模型的窗口，属于静默错配。
 * 2. 只接受正整数，非法值整条丢弃 —— 上下文写成 0/负数会被 Codex 当成
 *    "窗口为 0"，比缺省更糟（缺省会回落保守默认值）。
 * 3. 规范化后为空则返回 undefined 而不是 `{}` —— 让落盘里不出现空对象噪音，
 *    也让"未知"与"明确无能力"在存储层可区分。
 */
function normalizeCapabilities(
  capabilities: Record<string, ModelCapability> | undefined,
  models: readonly string[],
): Record<string, ModelCapability> | undefined {
  if (!capabilities) return undefined;
  const allowed = new Set(models);
  const out: Record<string, ModelCapability> = {};
  for (const [model, capability] of Object.entries(capabilities)) {
    if (!allowed.has(model) || !capability || typeof capability !== 'object') continue;
    const entry: ModelCapability = {};
    for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
      const value = capability[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        entry[key] = Math.floor(value);
      }
    }
    if (typeof capability.supportsReasoning === 'boolean') {
      entry.supportsReasoning = capability.supportsReasoning;
    }
    // 落盘前再过一次白名单：调用方可能是前端提交的任意字符串，
    // 而这个字段最终会写进 Codex 目录（非法值会让整份目录失效）。
    if (capability.inputModalities !== undefined) {
      const filtered = filterInputModalities(capability.inputModalities);
      if (filtered.length > 0) entry.inputModalities = filtered;
    }
    // 档位同样过白名单并排序。**空数组要保留**：它表达"查过、没有可用档位"，
    // 落盘后目录会写成空数组（隐藏推理菜单），与 undefined（未知，回落三档）不同。
    if (capability.reasoningEfforts !== undefined) {
      entry.reasoningEfforts = filterReasoningEfforts(capability.reasoningEfforts);
    }
    if (Object.keys(entry).length > 0) out[model] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 四源合并：上游声明 → modelinfo.dev → models.dev → 交给目录生成回落代码默认值。
 *
 * 优先级与取舍理由：
 * - **上下文窗口取上游值**：上游 1048000 与公开规格 1000000 的差异是实现细节，
 *   以上游为准更贴近这个中转的真实额度。上游没有才用公开数据。
 * - **输出上限取所有来源的较小值**：上游 `output_budget`(128k) 往往比模型规格
 *   (384k) 更保守也更真实。高估的后果是上游直接报超长，比"用不满"更难排查。
 * - **档位优先 modelinfo**：它直接给出 `efforts` 数组，不需要按 provider 投票；
 *   实测它与 models.dev 的多数票逐项吻合。它给的空数组表示"支持推理但档位未知"，
 *   此时继续问 models.dev，而不是当成"没有档位"。
 * - 逐个字段合并而不是整条覆盖：上游只给了 context 时，其余字段仍能从公开源补齐。
 */
export function mergeCapabilities(
  upstream: ModelCapability | undefined,
  registry: ModelCapability | undefined,
  info?: ModelCapability | undefined,
): ModelCapability | undefined {
  if (!upstream && !registry && !info) return undefined;
  const merged: ModelCapability = {};

  const context = upstream?.contextWindow ?? info?.contextWindow ?? registry?.contextWindow;
  if (context !== undefined) merged.contextWindow = context;

  const candidates = [
    upstream?.maxOutputTokens,
    info?.maxOutputTokens,
    registry?.maxOutputTokens,
  ].filter((value): value is number => typeof value === 'number' && value > 0);
  if (candidates.length > 0) merged.maxOutputTokens = Math.min(...candidates);

  const reasoning =
    upstream?.supportsReasoning ?? info?.supportsReasoning ?? registry?.supportsReasoning;
  if (reasoning !== undefined) merged.supportsReasoning = reasoning;

  // 档位：取第一个"非空"的来源。空数组要跳过（那是"支持但未知"，不是"无档位"）。
  // 全部为空时才落到 undefined，让目录去用默认三档。
  const effortsSource = [upstream, info, registry]
    .map((source) => source?.reasoningEfforts)
    .find((values) => Array.isArray(values) && values.length > 0);
  if (effortsSource) {
    const filtered = filterReasoningEfforts(effortsSource);
    if (filtered.length > 0) merged.reasoningEfforts = filtered;
  }

  const modalities = upstream?.inputModalities ?? info?.inputModalities ?? registry?.inputModalities;
  if (modalities !== undefined) {
    const filtered = filterInputModalities(modalities);
    if (filtered.length > 0) merged.inputModalities = filtered;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export class ProviderService {
  constructor(
    private readonly repos: TenantRepos,
    private readonly secrets: SecretCodec,
  ) {}

  list(): ProviderView[] {
    const records = [...this.repos.providers.list()].sort(
      (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
    );
    return records.map((record) => this.toView(record));
  }

  /**
   * 返回落盘形态（apiKey 是 SecretCodec 编码后的值），只给网关转发、连通性测试这类
   * 内部调用方用；任何接口输出都必须走 `toView`，否则密文/tenantId 会漏出去。
   */
  listRecords(): ProviderRecord[] {
    return [...this.repos.providers.list()].sort(
      (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt),
    );
  }

  /** 明文 key 只在需要真正发请求时取用。 */
  plainApiKey(record: ProviderRecord): string {
    return this.secrets.decode(record.apiKey);
  }

  get(id: string): ProviderRecord {
    const record = this.repos.providers.get(id);
    if (!record) throw notFound('providers.notFound', { id });
    return record;
  }

  create(input: ProviderInput, actorId: string): ProviderView {
    this.validateInput(input);
    const records = this.repos.providers.list();
    const taken = new Set(records.map((item) => item.providerKey));
    const now = new Date().toISOString();
    const models = normalizeModels(input.models);
    const record: ProviderRecord = {
      id: `p_${randomUUID().slice(0, 8)}`,
      tenantId: this.repos.tenantId,
      name: input.name.trim(),
      providerKey: allocateProviderKey(input.name, taken),
      apiType: input.apiType,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: this.secrets.encode(input.apiKey ?? ''),
      models,
      modelCapabilities: normalizeCapabilities(input.modelCapabilities, models),
      enabled: input.enabled ?? true,
      priority: input.priority ?? this.nextPriority(records),
      notes: input.notes?.trim() || undefined,
      websiteUrl: input.websiteUrl?.trim() || undefined,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.providers.saveAll([...records, record]);
    return this.toView(record);
  }

  update(id: string, input: ProviderInput): ProviderView {
    this.validateInput(input);
    const records = this.repos.providers.list();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) throw notFound('providers.notFound', { id });
    const current = records[index];

    const nextApiKey =
      input.apiKey === undefined || input.apiKey.trim() === ''
        ? current.apiKey
        : this.secrets.encode(input.apiKey.trim());

    const models = normalizeModels(input.models);
    const updated: ProviderRecord = {
      ...current,
      name: input.name.trim(),
      providerKey:
        current.name.trim() === input.name.trim()
          ? current.providerKey
          : this.reallocateKey(current, input.name, records),
      apiType: input.apiType,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: nextApiKey,
      models,
      // 没传就沿用已存的能力（前端编辑态不一定重新拉列表）；传了就整体替换，
      // 但仍然只保留仍在新 models 里的条目，避免删模型后留下死数据。
      modelCapabilities:
        input.modelCapabilities === undefined
          ? normalizeCapabilities(current.modelCapabilities, models)
          : normalizeCapabilities(input.modelCapabilities, models),
      enabled: input.enabled ?? current.enabled,
      priority: input.priority ?? current.priority,
      notes: input.notes?.trim() || undefined,
      websiteUrl: input.websiteUrl?.trim() || undefined,
      updatedAt: new Date().toISOString(),
    };
    records[index] = updated;
    this.repos.providers.saveAll(records);
    return this.toView(updated);
  }

  remove(id: string): { newDefaultProviderId: string | null } {
    const records = this.repos.providers.list();
    const target = records.find((item) => item.id === id);
    if (!target) throw notFound('providers.notFound', { id });

    const remaining = records.filter((item) => item.id !== id);
    this.repos.providers.saveAll(remaining);

    const settings = this.repos.settings.read();
    if (settings.defaultProviderId === id) {
      const fallback =
        remaining
          .filter((item) => item.enabled)
          .sort((a, b) => a.priority - b.priority)[0] ??
        remaining.sort((a, b) => a.priority - b.priority)[0];
      this.writeSettings({
        ...settings,
        defaultProviderId: fallback?.id ?? null,
        defaultModel: fallback ? (fallback.models[0] ?? null) : null,
      });
      return { newDefaultProviderId: fallback?.id ?? null };
    }
    return { newDefaultProviderId: settings.defaultProviderId };
  }

  setDefault(providerId: string, model?: string): TenantSettings {
    const record = this.get(providerId);
    const chosenModel = model?.trim() || record.models[0] || null;
    if (chosenModel && record.models.length > 0 && !record.models.includes(chosenModel)) {
      throw badRequest('providers.defaultModel.notInProvider', {
        model: chosenModel,
        provider: record.name,
      });
    }
    const settings = this.repos.settings.read();
    const next: TenantSettings = {
      ...settings,
      defaultProviderId: record.id,
      defaultModel: chosenModel,
      updatedAt: new Date().toISOString(),
    };
    this.writeSettings(next);
    return next;
  }

  setEnabled(id: string, enabled: boolean): ProviderView {
    const records = this.repos.providers.list();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) throw notFound('providers.notFound', { id });
    records[index] = { ...records[index], enabled, updatedAt: new Date().toISOString() };
    this.repos.providers.saveAll(records);
    return this.toView(records[index]);
  }

  reorder(orderedIds: string[]): ProviderView[] {
    const records = this.repos.providers.list();
    const byId = new Map(records.map((item) => [item.id, item]));
    for (const id of orderedIds) {
      if (!byId.has(id)) throw badRequest('providers.unknownProvider', { id });
    }
    const now = new Date().toISOString();
    orderedIds.forEach((id, index) => {
      const record = byId.get(id)!;
      byId.set(id, { ...record, priority: index, updatedAt: now });
    });
    const next = [...byId.values()];
    this.repos.providers.saveAll(next);
    return this.list();
  }

  recordTest(id: string, result: ProviderRecord['lastTest']): void {
    const records = this.repos.providers.list();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return;
    records[index] = { ...records[index], lastTest: result };
    this.repos.providers.saveAll(records);
  }

  toView(record: ProviderRecord): ProviderView {
    return toProviderView(record, this.plainApiKeyForDisplay(record));
  }

  /**
   * 展示用的"明文"：若密钥可解密则返回真实值供脱敏，否则返回空。
   * 脱敏结果只暴露首 3 位与尾 4 位，不允许完整 key 出接口。
   */
  private plainApiKeyForDisplay(record: ProviderRecord): string {
    const decoded = this.secrets.decode(record.apiKey);
    return decoded;
  }

  private reallocateKey(
    current: ProviderRecord,
    newName: string,
    records: ProviderRecord[],
  ): string {
    const taken = new Set(
      records.filter((item) => item.id !== current.id).map((item) => item.providerKey),
    );
    return allocateProviderKey(newName, taken);
  }

  private nextPriority(records: ProviderRecord[]): number {
    if (records.length === 0) return 0;
    return Math.max(...records.map((item) => item.priority)) + 1;
  }

  private validateInput(input: ProviderInput): void {
    if (!input.name || !input.name.trim()) throw badRequest('providers.validation.nameRequired');
    // 不信任调用方已校验过：值一旦落盘，接错协议的请求会被网关卡在 501，
    // 而现场只留下一家"看起来正常"的供应商，很难回溯是写入了非法 apiType。
    if (!API_TYPES.includes(input.apiType)) {
      throw badRequest('providers.validation.apiTypeUnsupported', { apiType: input.apiType });
    }
    if (input.priority !== undefined && !Number.isFinite(input.priority)) {
      throw badRequest('providers.validation.priorityType');
    }
  }

  private writeSettings(settings: TenantSettings): void {
    this.repos.settings.write(settings);
  }
}

/** 同一租户内不允许同名供应商，否则 providerKey 会不断加后缀，别名难以预测。 */
export function assertNameAvailable(
  records: readonly ProviderRecord[],
  name: string,
  exceptId?: string,
): void {
  const normalized = name.trim().toLowerCase();
  const clash = records.find(
    (item) => item.id !== exceptId && item.name.trim().toLowerCase() === normalized,
  );
  if (clash) throw conflict('providers.nameTaken', { name: clash.name });
}
