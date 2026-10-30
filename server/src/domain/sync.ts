/**
 * 多设备配置同步。
 *
 * 用途：一台机器（master/peer）配好供应商与 Agent 设置后，其余设备（follower/peer）
 * 跟随，省掉逐台重配。典型场景是先在一台 Linux 上配好，再让 Windows 端同步过去，
 * 这样两端 Codex 都指向同一处，`codex` 的 SSH 远程能力才能两端都工作。
 *
 * 四个刻意的边界：
 * 1. **不传 `DATA_ENCRYPTION_KEY`**：每台机器自己的密钥独立。跨机传密钥必须
 *    解密成明文再传、落地时用本机密钥重新加密（`enc:v1:` 密文换个密钥解不开）。
 * 2. **不同步登录口令与会话**：否则一台机器被入侵等于全部沦陷。
 * 3. **不覆盖有本地改动的项**：冲突保留双版本，由人仲裁——配置被静默改掉比报错更难查。
 * 4. **双向同步靠三方合并**：`sync-state.json` 记住双方上次确认过的内容哈希，
 *    才能区分"这一侧没改"与"这一侧改回了原值"。详见 `domain/syncState.ts`。
 */
import { API_TYPES, type ModelCapability } from './provider';

/** 可以同步的内容。用户在前端勾选，未勾选的一律不动。 */
export const SYNC_SCOPES = ['providers', 'settings', 'agentTargets'] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];

/** 各 scope 的中文说明，前端直接展示，避免两处维护文案。 */
export const SYNC_SCOPE_LABELS: Record<SyncScope, string> = {
  providers: '供应商与模型（含上游 API Key，跨机重新加密）',
  settings: '网关设置（默认模型、跨协议转发、审批模型等）',
  agentTargets: 'Agent 连接方式（走网关 / 直连）',
};

/**
 * 同步角色。
 *
 * - `standalone`：不提供、不拉取（默认，升级不该让单机部署突然对外开接口）
 * - `master`：只提供 `GET /api/sync/snapshot`
 * - `follower`：只拉取
 * - `peer`：既提供快照、也拉取对端（双向同步）
 */
export type SyncRole = 'standalone' | 'master' | 'follower' | 'peer';

/** 该角色能否对外提供快照。 */
export function canServeSnapshot(role: SyncRole): boolean {
  return role === 'master' || role === 'peer';
}

/** 该角色能否从对端拉取。 */
export function canPullSnapshot(role: SyncRole): boolean {
  return role === 'follower' || role === 'peer';
}

export interface SyncConfig {
  role: SyncRole;
  /**
   * 对端地址，形如 `https://box.example.com:8787`。
   *
   * 字段名保持 `masterUrl`（兼容已落盘的 `settings.json`），但 `peer` 角色下
   * 语义就是"对端"：既从这里拉，也接受对端来拉。`follower` / `peer` 必须有值。
   */
  masterUrl: string | null;
  /** 勾选同步哪些内容；空数组表示什么都不动（安全的默认） */
  scopes: SyncScope[];
  /** 上次成功拉取的时间 */
  lastPullAt: string | null;
  /** 上次拉取的结果摘要，供界面显示（不含凭据内容） */
  lastPullResult: string | null;
  /**
   * 上次拉取时对端的实例标识。
   *
   * 用于发现"对端换了一台机器"——换了之后"谁更新"的判断依据不再可靠
   * （两台机器的时钟与配置历史不同），值得在界面上提示重新核对。
   * 与 `masterUrl` 不同：反代部署下两台机器可能配同一个对外地址。
   */
  lastMasterId: string | null;
}

export function defaultSyncConfig(): SyncConfig {
  return {
    // 默认 standalone：不开同步时行为与之前完全一致，不会因为升级而突然开始联网
    role: 'standalone',
    masterUrl: null,
    scopes: [],
    lastPullAt: null,
    lastPullResult: null,
    lastMasterId: null,
  };
}

/** 一条冲突：同一条记录的本地版与远端版都被改过，需要人选一个。 */
export interface SyncConflict {
  id: string;
  /** 冲突发生在哪类数据上 */
  scope: SyncScope;
  /** 记录标识（供应商 id / 设置项名 / agent id） */
  targetId: string;
  /** 给人看的名字，例如供应商名 */
  targetLabel: string;
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  /** 两版的差异摘要（字段名列表），不含完整值以免把 Key 写进冲突文件 */
  changedFields: string[];
  /** 本地版的可比较形态（凭据已打码），给界面展示差异用 */
  localValue: unknown;
  /** 远端版的可比较形态（凭据已打码） */
  remoteValue: unknown;
  /**
   * 远端版的**完整值**，用本机 `secrets.encode()` 加密后保存。
   *
   * 为什么需要它：用户选"用远端版"时必须能把对方的密钥真正写进来，
   * 而 `remoteValue` 为了不落明文已经把 Key 打码了。这份是加密过的，
   * 既能还原、又不会让冲突文件成为凭据的第二份明文副本。
   */
  remoteValueSealed: string | null;
  /**
   * 远端版的规范内容哈希（内部字段，**任何接口响应都必须剔除**）。
   *
   * 解决冲突时（无论选 local 还是 remote）都要把基线推进到远端哈希：
   * 选 remote 后本地内容等于远端；选 local 后本地内容成为双方确认的版本，
   * 下一次拉取不应再因为同一份远端值反复产生冲突。
   */
  remoteHash: string;
  detectedAt: string;
}

/** 冲突的对外形态：剔除凭据副本与内部哈希。 */
export type SyncConflictPublic = Omit<SyncConflict, 'remoteValueSealed' | 'remoteHash'>;

export function toPublicSyncConflict(conflict: SyncConflict): SyncConflictPublic {
  const { remoteValueSealed: _sealed, remoteHash: _hash, ...rest } = conflict;
  return rest;
}

export interface SyncConflictsData {
  conflicts: SyncConflict[];
}

export function defaultSyncConflictsData(): SyncConflictsData {
  return { conflicts: [] };
}

/** 跨机快照格式版本。读到更大的值必须拒绝应用，而不是按当前结构硬解读。 */
export const SYNC_SNAPSHOT_SCHEMA_VERSION = 1;

/** 快照里的一个供应商。`apiKey` 是**明文**（见 `SyncSnapshot` 的说明）。 */
export interface SyncSnapshotProvider {
  id: string;
  name: string;
  providerKey: string;
  apiType: string;
  baseUrl: string;
  /** 明文；对端立即重新加密 */
  apiKey: string;
  models: string[];
  /** 生图模型（只服务 /v1/images/*，不发布别名、不进 Codex 目录） */
  imageModels?: string[];
  /** 按模型名记录的上游能力 */
  modelCapabilities?: Record<string, ModelCapability>;
  enabled: boolean;
  priority: number;
  notes?: string;
  websiteUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 快照里的网关设置。旧快照可能缺两个 Codex 流式字段，按默认值处理。 */
export interface SyncSnapshotSettings {
  defaultProviderId: string | null;
  defaultModel: string | null;
  approvalReviewModel: string | null;
  protocolConversion: boolean;
  disableCodexWebSearch: boolean;
  /** 缺省（旧版本导出的快照）= 用默认值 10，显式 null = 不写该键 */
  codexStreamMaxRetries?: number | null;
  /** 缺省（旧版本导出的快照）= 用默认值 600000，显式 null = 不写该键 */
  codexStreamIdleTimeoutMs?: number | null;
  updatedAt: string;
  /**
   * 网关令牌**不在这里**：它是每台机器自己的凭据，传过去会让两台机器共用
   * 一个令牌，泄露面翻倍且无法单独吊销。
   */
}

/** 快照里的一个 Agent 连接偏好。`updatedAt` 用于三方合并与"应用远端保留时间"。 */
export interface SyncSnapshotAgentTarget {
  mode: string;
  directProviderId: string | null;
  directModel: string | null;
  updatedAt?: string;
}

/**
 * 同步快照：一侧导出给另一侧的内容。
 *
 * 注意 `providers[].apiKey` 在这里是**明文**——`enc:v1:` 密文绑定导出方的
 * `DATA_ENCRYPTION_KEY`，直接传给对端解不开。落地时对端会用本机密钥
 * 重新加密。因此这个响应绝不能被缓存，日志里也不能记录 body。
 */
export interface SyncSnapshot {
  /** 快照格式版本，便于将来演进时识别 */
  schemaVersion: 1;
  exportedAt: string;
  /** 导出方的实例标识，拉取方用它判断"是不是换了一台机器" */
  masterId: string;
  scopes: SyncScope[];
  providers?: SyncSnapshotProvider[];
  settings?: SyncSnapshotSettings;
  agentTargets?: Record<string, SyncSnapshotAgentTarget>;
}

/** 快照校验结果：合法时给回结构化快照，不合法时给文案键与参数。 */
export type SyncSnapshotValidation =
  | { ok: true; snapshot: SyncSnapshot }
  | {
      ok: false;
      messageKey: 'sync.snapshot.malformed' | 'sync.snapshot.futureSchema';
      params: Record<string, string | number>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 只描述"哪个字段不对"，不拼成品文案——译文由请求边界渲染。 */
function malformed(reason: string): SyncSnapshotValidation {
  return { ok: false, messageKey: 'sync.snapshot.malformed', params: { reason } };
}

type Validation<T> = { ok: true; value: T } | { ok: false; reason: string };

function validateCapabilities(raw: unknown, where: string): Validation<Record<string, ModelCapability>> {
  if (!isRecord(raw)) return { ok: false, reason: where };
  const out: Record<string, ModelCapability> = {};
  for (const [model, capability] of Object.entries(raw)) {
    if (!isRecord(capability)) return { ok: false, reason: `${where}.${model}` };
    const next: ModelCapability = {};
    if (capability.contextWindow !== undefined) {
      if (!isFiniteNumber(capability.contextWindow)) {
        return { ok: false, reason: `${where}.${model}.contextWindow` };
      }
      next.contextWindow = capability.contextWindow;
    }
    if (capability.maxOutputTokens !== undefined) {
      if (!isFiniteNumber(capability.maxOutputTokens)) {
        return { ok: false, reason: `${where}.${model}.maxOutputTokens` };
      }
      next.maxOutputTokens = capability.maxOutputTokens;
    }
    if (capability.supportsReasoning !== undefined) {
      if (typeof capability.supportsReasoning !== 'boolean') {
        return { ok: false, reason: `${where}.${model}.supportsReasoning` };
      }
      next.supportsReasoning = capability.supportsReasoning;
    }
    if (capability.reasoningEfforts !== undefined) {
      if (!isStringArray(capability.reasoningEfforts)) {
        return { ok: false, reason: `${where}.${model}.reasoningEfforts` };
      }
      next.reasoningEfforts = [...capability.reasoningEfforts];
    }
    if (capability.inputModalities !== undefined) {
      if (!isStringArray(capability.inputModalities)) {
        return { ok: false, reason: `${where}.${model}.inputModalities` };
      }
      next.inputModalities = [...capability.inputModalities];
    }
    out[model] = next;
  }
  return { ok: true, value: out };
}

function validateProvider(raw: unknown, index: number): Validation<SyncSnapshotProvider> {
  const where = `providers[${index}]`;
  if (!isRecord(raw)) return { ok: false, reason: where };

  const stringFields: Array<keyof SyncSnapshotProvider & string> = [
    'id',
    'name',
    'providerKey',
    'apiType',
    'baseUrl',
    'apiKey',
    'createdBy',
    'createdAt',
    'updatedAt',
  ];
  for (const field of stringFields) {
    const value = raw[field];
    if (typeof value !== 'string' || (field === 'id' && value === '')) {
      return { ok: false, reason: `${where}.${field}` };
    }
  }
  if (!(API_TYPES as readonly string[]).includes(raw.apiType as string)) {
    return { ok: false, reason: `${where}.apiType` };
  }
  if (!isStringArray(raw.models)) return { ok: false, reason: `${where}.models` };
  if (typeof raw.enabled !== 'boolean') return { ok: false, reason: `${where}.enabled` };
  if (!isFiniteNumber(raw.priority)) return { ok: false, reason: `${where}.priority` };
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    return { ok: false, reason: `${where}.notes` };
  }
  if (raw.websiteUrl !== undefined && typeof raw.websiteUrl !== 'string') {
    return { ok: false, reason: `${where}.websiteUrl` };
  }
  if (raw.imageModels !== undefined && !isStringArray(raw.imageModels)) {
    return { ok: false, reason: `${where}.imageModels` };
  }

  const provider: SyncSnapshotProvider = {
    id: raw.id as string,
    name: raw.name as string,
    providerKey: raw.providerKey as string,
    apiType: raw.apiType as string,
    baseUrl: raw.baseUrl as string,
    apiKey: raw.apiKey as string,
    models: [...(raw.models as string[])],
    enabled: raw.enabled,
    priority: raw.priority,
    createdBy: raw.createdBy as string,
    createdAt: raw.createdAt as string,
    updatedAt: raw.updatedAt as string,
  };
  if (raw.notes !== undefined) provider.notes = raw.notes as string;
  if (raw.websiteUrl !== undefined) provider.websiteUrl = raw.websiteUrl as string;
  if (raw.imageModels !== undefined) provider.imageModels = [...(raw.imageModels as string[])];
  if (raw.modelCapabilities !== undefined) {
    const capabilities = validateCapabilities(
      raw.modelCapabilities,
      `${where}.modelCapabilities`,
    );
    if (!capabilities.ok) return capabilities;
    provider.modelCapabilities = capabilities.value;
  }
  return { ok: true, value: provider };
}

function validateSettings(raw: unknown): Validation<SyncSnapshotSettings> {
  const where = 'settings';
  if (!isRecord(raw)) return { ok: false, reason: where };
  for (const field of ['defaultProviderId', 'defaultModel', 'approvalReviewModel'] as const) {
    if (!isNullableString(raw[field])) return { ok: false, reason: `${where}.${field}` };
  }
  if (typeof raw.protocolConversion !== 'boolean') {
    return { ok: false, reason: `${where}.protocolConversion` };
  }
  if (typeof raw.disableCodexWebSearch !== 'boolean') {
    return { ok: false, reason: `${where}.disableCodexWebSearch` };
  }
  if (typeof raw.updatedAt !== 'string' || raw.updatedAt === '') {
    return { ok: false, reason: `${where}.updatedAt` };
  }
  for (const field of ['codexStreamMaxRetries', 'codexStreamIdleTimeoutMs'] as const) {
    const value = raw[field];
    if (value !== undefined && value !== null && !isFiniteNumber(value)) {
      return { ok: false, reason: `${where}.${field}` };
    }
  }

  const settings: SyncSnapshotSettings = {
    defaultProviderId: raw.defaultProviderId as string | null,
    defaultModel: raw.defaultModel as string | null,
    approvalReviewModel: raw.approvalReviewModel as string | null,
    protocolConversion: raw.protocolConversion,
    disableCodexWebSearch: raw.disableCodexWebSearch,
    updatedAt: raw.updatedAt,
  };
  if (raw.codexStreamMaxRetries !== undefined) {
    settings.codexStreamMaxRetries = raw.codexStreamMaxRetries as number | null;
  }
  if (raw.codexStreamIdleTimeoutMs !== undefined) {
    settings.codexStreamIdleTimeoutMs = raw.codexStreamIdleTimeoutMs as number | null;
  }
  return { ok: true, value: settings };
}

function validateAgentTarget(raw: unknown, agentId: string): Validation<SyncSnapshotAgentTarget> {
  const where = `agentTargets.${agentId}`;
  if (!isRecord(raw)) return { ok: false, reason: where };
  if (raw.mode !== 'gateway' && raw.mode !== 'direct') {
    return { ok: false, reason: `${where}.mode` };
  }
  if (!isNullableString(raw.directProviderId)) {
    return { ok: false, reason: `${where}.directProviderId` };
  }
  if (!isNullableString(raw.directModel)) {
    return { ok: false, reason: `${where}.directModel` };
  }
  if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'string') {
    return { ok: false, reason: `${where}.updatedAt` };
  }
  const target: SyncSnapshotAgentTarget = {
    mode: raw.mode,
    directProviderId: raw.directProviderId,
    directModel: raw.directModel,
  };
  if (raw.updatedAt !== undefined) target.updatedAt = raw.updatedAt;
  return { ok: true, value: target };
}

/**
 * 校验从对端取回的快照。
 *
 * 为什么在领域层做：它只依赖输入、不碰 IO，可以单测；路由层只负责把结果
 * 翻译成 400。**不能跳过这层直接 `as SyncSnapshot`**——对端可能是旧版本、
 * 被中间人改写、或根本不是本服务，坏结构进合并逻辑后可能写坏数据文件。
 *
 * 返回的是**重新构造**的对象：只保留认识的字段，避免把任意键带进哈希与落盘。
 */
export function validateSyncSnapshot(raw: unknown): SyncSnapshotValidation {
  if (!isRecord(raw)) return malformed('snapshot');

  const version = raw.schemaVersion;
  if (!isFiniteNumber(version) || !Number.isInteger(version)) {
    return malformed('schemaVersion');
  }
  if (version > SYNC_SNAPSHOT_SCHEMA_VERSION) {
    return {
      ok: false,
      // 未来版本不能按当前结构硬解读：字段语义可能已经变了
      messageKey: 'sync.snapshot.futureSchema',
      params: { remote: version, local: SYNC_SNAPSHOT_SCHEMA_VERSION },
    };
  }
  if (version !== SYNC_SNAPSHOT_SCHEMA_VERSION) return malformed('schemaVersion');

  if (typeof raw.masterId !== 'string' || raw.masterId.trim() === '') {
    return malformed('masterId');
  }
  if (typeof raw.exportedAt !== 'string' || raw.exportedAt === '') {
    return malformed('exportedAt');
  }
  if (!Array.isArray(raw.scopes)) return malformed('scopes');

  const scopes: SyncScope[] = [];
  for (const item of raw.scopes) {
    if (typeof item !== 'string' || !(SYNC_SCOPES as readonly string[]).includes(item)) {
      return malformed('scopes[]');
    }
    if (!scopes.includes(item as SyncScope)) scopes.push(item as SyncScope);
  }

  const snapshot: SyncSnapshot = {
    schemaVersion: SYNC_SNAPSHOT_SCHEMA_VERSION,
    exportedAt: raw.exportedAt,
    masterId: raw.masterId,
    scopes,
  };

  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers)) return malformed('providers');
    const ids = new Set<string>();
    const providers: SyncSnapshotProvider[] = [];
    for (let index = 0; index < raw.providers.length; index += 1) {
      const result = validateProvider(raw.providers[index], index);
      if (!result.ok) return malformed(result.reason);
      // 重复 id 会让合并时"同一家供应商"出现两个来源，后写入的静默覆盖前面的。
      if (ids.has(result.value.id)) {
        return malformed(`providers[${index}].id (duplicate)`);
      }
      ids.add(result.value.id);
      providers.push(result.value);
    }
    snapshot.providers = providers;
  }

  if (raw.settings !== undefined) {
    const result = validateSettings(raw.settings);
    if (!result.ok) return malformed(result.reason);
    snapshot.settings = result.value;
  }

  if (raw.agentTargets !== undefined) {
    if (!isRecord(raw.agentTargets)) return malformed('agentTargets');
    const targets: Record<string, SyncSnapshotAgentTarget> = {};
    for (const [agentId, entry] of Object.entries(raw.agentTargets)) {
      const result = validateAgentTarget(entry, agentId);
      if (!result.ok) return malformed(result.reason);
      targets[agentId] = result.value;
    }
    snapshot.agentTargets = targets;
  }

  return { ok: true, snapshot };
}
