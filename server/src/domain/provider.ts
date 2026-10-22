export type ApiType = 'openai' | 'anthropic';

/** 落盘形态：apiKey 存的是 SecretCodec 编码后的字符串。 */
export interface ProviderRecord {
  id: string;
  tenantId: string;
  name: string;
  /** 出现在聚合别名里的稳定短名，租户内唯一 */
  providerKey: string;
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  /** 数值小的优先；相同优先级按创建顺序 */
  priority: number;
  notes?: string;
  websiteUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastTest?: ProviderTestResult;
}

export interface ProviderTestResult {
  at: string;
  ok: boolean;
  latencyMs: number;
  status?: number;
  models?: string[];
  error?: string;
}

/** 接口返回形态：apiKey 脱敏。 */
export interface ProviderView extends Omit<ProviderRecord, 'apiKey' | 'tenantId'> {
  apiKeyMasked: string;
  apiKeyTail: string;
  hasApiKey: boolean;
}

export interface ProvidersData {
  providers: ProviderRecord[];
}

export function maskApiKey(apiKey: string): { masked: string; tail: string } {
  if (!apiKey) return { masked: '', tail: '' };
  const tail = apiKey.slice(-4);
  if (apiKey.length <= 8) return { masked: '*'.repeat(apiKey.length), tail };
  return { masked: `${apiKey.slice(0, 3)}${'*'.repeat(8)}${tail}`, tail };
}

export function toProviderView(record: ProviderRecord, plainApiKey: string): ProviderView {
  const { apiKey: _apiKey, tenantId: _tenantId, ...rest } = record;
  const { masked, tail } = maskApiKey(plainApiKey);
  return {
    ...rest,
    apiKeyMasked: masked,
    apiKeyTail: tail,
    hasApiKey: plainApiKey.length > 0,
  };
}

/** 从名称派生 providerKey：只保留小写字母数字，允许内部连字符。 */
export function slugifyProviderKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'provider';
}

/**
 * 生成租户内唯一的 providerKey。重名时追加 -2、-3……，
 * 保证别名 `lmm-<key>/<model>` 长期稳定可解析。
 */
export function allocateProviderKey(
  name: string,
  taken: ReadonlySet<string>,
): string {
  const base = slugifyProviderKey(name);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}
