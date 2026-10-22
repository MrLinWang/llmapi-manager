/**
 * 上游协议类型：一家供应商只服务与它同协议的那条网关路径。
 *
 * - openai     : /v1/chat/completions（Chat Completions 形态）
 * - anthropic  : /v1/messages
 * - responses  : /v1/responses（OpenAI Responses API，Codex 原生使用）
 *
 * 三条路径都严格匹配、互不做协议转换，不匹配一律 501。之所以不能放宽成"直通"：
 * 那会把 Responses 请求发给只支持 Chat 的上游，客户端只会收到上游的参数错误，
 * 完全看不出是选错了供应商——这条被真实问题踩过。
 */
export type ApiType = 'openai' | 'anthropic' | 'responses';

/**
 * 服务端协议枚举的唯一来源：路由层入参校验与 ProviderService 校验都从这里取，
 * 新增协议只改这一处；两侧各硬编码一份的旧写法在加 responses 时就被漏改过。
 */
export const API_TYPES: readonly ApiType[] = ['openai', 'anthropic', 'responses'];

/**
 * 报错文案用的可读名称，统一成「<厂商> 兼容（<API 形态>）」：括号里才是决定路由的
 * API 形态，只说"OpenAI 兼容"会让用户以为这家一定能走 /v1/chat/completions。
 * 与前端 web/src/lib/labels.ts 的 API_TYPE_META 口径一致，避免同一协议两处叫法不同。
 */
export function apiTypeLabel(apiType: ApiType): string {
  if (apiType === 'openai') return 'OpenAI 兼容（Chat Completions）';
  if (apiType === 'anthropic') return 'Anthropic 兼容（Messages）';
  return 'OpenAI 兼容（Responses）';
}

/** 落盘形态：apiKey 存的是 SecretCodec 编码后的字符串。 */
export interface ProviderRecord {
  id: string;
  tenantId: string;
  name: string;
  /** 出现在聚合别名里的稳定短名，租户内唯一 */
  providerKey: string;
  /** 决定这条上游只接哪条网关路径；改协议等于换上游，不能当展示字段看待 */
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
