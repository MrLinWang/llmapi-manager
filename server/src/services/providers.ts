import { randomUUID } from 'node:crypto';
import type { TenantRepos } from '../store/tenantScope';
import type { SecretCodec } from '../crypto/secretCodec';
import {
  allocateProviderKey,
  toProviderView,
  type ApiType,
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
  enabled?: boolean;
  priority?: number;
  notes?: string;
  websiteUrl?: string;
}

const API_TYPES: ApiType[] = ['openai', 'anthropic'];

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) throw badRequest('Base URL 不能为空');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw badRequest(`Base URL 不是合法地址：${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('Base URL 只支持 http/https');
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

  /** 内部使用：含明文 key，仅供网关转发与连通性测试。 */
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
    if (!record) throw notFound(`供应商 ${id} 不存在`);
    return record;
  }

  create(input: ProviderInput, actorId: string): ProviderView {
    this.validateInput(input);
    const records = this.repos.providers.list();
    const taken = new Set(records.map((item) => item.providerKey));
    const now = new Date().toISOString();
    const record: ProviderRecord = {
      id: `p_${randomUUID().slice(0, 8)}`,
      tenantId: this.repos.tenantId,
      name: input.name.trim(),
      providerKey: allocateProviderKey(input.name, taken),
      apiType: input.apiType,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: this.secrets.encode(input.apiKey ?? ''),
      models: normalizeModels(input.models),
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
    if (index < 0) throw notFound(`供应商 ${id} 不存在`);
    const current = records[index];

    const nextApiKey =
      input.apiKey === undefined || input.apiKey.trim() === ''
        ? current.apiKey
        : this.secrets.encode(input.apiKey.trim());

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
      models: normalizeModels(input.models),
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
    if (!target) throw notFound(`供应商 ${id} 不存在`);

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
      throw badRequest(`模型 ${chosenModel} 不在供应商 ${record.name} 的模型列表中`);
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
    if (index < 0) throw notFound(`供应商 ${id} 不存在`);
    records[index] = { ...records[index], enabled, updatedAt: new Date().toISOString() };
    this.repos.providers.saveAll(records);
    return this.toView(records[index]);
  }

  reorder(orderedIds: string[]): ProviderView[] {
    const records = this.repos.providers.list();
    const byId = new Map(records.map((item) => [item.id, item]));
    for (const id of orderedIds) {
      if (!byId.has(id)) throw badRequest(`未知供应商 ${id}`);
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
    if (!input.name || !input.name.trim()) throw badRequest('供应商名称不能为空');
    if (!API_TYPES.includes(input.apiType)) {
      throw badRequest(`不支持的协议类型：${input.apiType}`);
    }
    if (input.priority !== undefined && !Number.isFinite(input.priority)) {
      throw badRequest('优先级必须是数字');
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
  if (clash) throw conflict(`已存在同名供应商：${clash.name}`);
}
