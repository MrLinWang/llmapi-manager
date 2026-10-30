import { createHash, randomBytes } from 'node:crypto';
import type { TenantRepos } from '../store/tenantScope';
import type { SecretCodec } from '../crypto/secretCodec';
import {
  CODEX_REASONING_EFFORTS,
  type ModelCapability,
  type ProviderRecord,
} from '../domain/provider';
import {
  canPullSnapshot,
  canServeSnapshot,
  type SyncConfig,
  type SyncConflict,
  type SyncScope,
  type SyncSnapshot,
  type SyncSnapshotAgentTarget,
  type SyncSnapshotProvider,
  type SyncSnapshotSettings,
} from '../domain/sync';
import {
  DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_CODEX_STREAM_MAX_RETRIES,
  type AgentConnectionMode,
  type AgentTargetPreference,
  type TenantSettings,
} from '../domain/settings';
import type { AgentId } from '../domain/agent';
import { syncStateKey, type SyncStateEntry } from '../domain/syncState';

/**
 * 配置同步的读写。
 *
 * 只做"导出 / 应用 / 冲突判定"三件事，**不负责网络**——发请求在路由层，
 * 这样核心逻辑可以用纯函数测试，不需要起两台服务。
 *
 * 一条贯穿全文的约束：`enc:v1:` 密文绑定本机的 `DATA_ENCRYPTION_KEY`，
 * 换个密钥就解不开。所以跨机传输的永远是**明文**，落地时立刻用本机密钥重新加密。
 * 这意味着快照响应绝不能缓存、也绝不能记进日志。
 *
 * 合并采用三方（base/local/remote）而不是"比 updatedAt"：时间戳只能猜，
 * 而 base 能回答"这一侧到底改没改"。见 `domain/syncState.ts`。
 */
/**
 * 冲突里没有可用的"远端完整值"。
 *
 * 只有一个成因：本机未配置 `DATA_ENCRYPTION_KEY`，因此拒绝把远端明文
 * 落进冲突文件（见 `sealRemoteValue` 的说明）。这种情况要让用户知道
 * 该去配密钥，而不是笼统报"未知冲突"。
 */
export class SyncSealedUnavailableError extends Error {
  constructor() {
    super('这个冲突没有保存远端完整值（本机未配置 DATA_ENCRYPTION_KEY）。');
    this.name = 'SyncSealedUnavailableError';
  }
}

/**
 * 比较两个 ISO 时间戳的先后。
 *
 * **不能直接比字符串**：`'2026-05-05T10:00:00+08:00'`（=02:00Z）按字典序
 * 排在 `'2026-05-05T05:00:00.000Z'` 之后，但它实际更早。同步数据来自另一台
 * 机器，时区写法不保证一致，字符串比较会把"远端更新"误判成"本地更新"，
 * 于是产生假冲突、并保留本该被覆盖的旧值。
 *
 * 解析失败时回退到 0（当作最旧），让远端胜出——宁可多覆盖一次，
 * 也好过因为一个坏时间戳把配置永久冻住。
 */
function compareTime(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  const na = Number.isNaN(ta) ? 0 : ta;
  const nb = Number.isNaN(tb) ? 0 : tb;
  return na - nb;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 推理档位按**强度**排序（`none < minimal < low < … < persistent`），不是字典序。
 *
 * 哈希只关心"集合是否相同"，排序只是为了消除书写顺序差异；按强度排还能让
 * 冲突里展示的档位顺序与 Codex 目录一致。未知值排在已知值之后并保持确定顺序。
 */
function sortReasoningEfforts(efforts: readonly string[]): string[] {
  const rank = new Map(CODEX_REASONING_EFFORTS.map((value, index) => [value, index]));
  return [...efforts].sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * 稳定序列化：对象键递归排序后再拼 JSON。
 *
 * 哈希必须对"键的书写顺序"免疫——两端各写一份 JSON 时 `{name,baseUrl}`
 * 与 `{baseUrl,name}` 是同一份内容，按原序哈希会制造大量假冲突。
 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

interface ProviderContentInput {
  name: string;
  providerKey: string;
  apiType: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  imageModels?: string[];
  modelCapabilities?: Record<string, ModelCapability>;
  enabled: boolean;
  priority: number;
  notes?: string;
  websiteUrl?: string;
}

/**
 * 供应商的规范内容。
 *
 * 排除 `updatedAt/createdAt/createdBy/lastTest/tenantId`：它们要么是同步元数据，
 * 要么每台机器本来就不同（tenantId），要么是本地探测结果（lastTest），
 * 放进哈希会让"其实没改配置"被算成改动。
 */
function providerContent(input: ProviderContentInput): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  for (const [model, capability] of Object.entries(input.modelCapabilities ?? {})) {
    capabilities[model] = {
      contextWindow: capability.contextWindow,
      maxOutputTokens: capability.maxOutputTokens,
      supportsReasoning: capability.supportsReasoning,
      // 档位数组的顺序来自探测过程，不代表内容；按强度排序后再哈希
      reasoningEfforts: capability.reasoningEfforts
        ? sortReasoningEfforts(capability.reasoningEfforts)
        : undefined,
      inputModalities: capability.inputModalities,
    };
  }
  return {
    name: input.name,
    providerKey: input.providerKey,
    apiType: input.apiType,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: input.models,
    imageModels: input.imageModels ?? [],
    modelCapabilities: capabilities,
    enabled: input.enabled,
    priority: input.priority,
    notes: input.notes ?? null,
    websiteUrl: input.websiteUrl ?? null,
  };
}

interface SettingsContentInput {
  defaultProviderId: string | null;
  defaultModel: string | null;
  approvalReviewModel: string | null;
  protocolConversion: boolean;
  disableCodexWebSearch: boolean;
  codexStreamMaxRetries?: number | null;
  codexStreamIdleTimeoutMs?: number | null;
}

/** 缺字段的旧快照按"代码默认值"处理，而不是按 null（null 是"不写该键"的明确选择）。 */
function normalizeStreamRetries(value: number | null | undefined): number | null {
  return value === undefined ? DEFAULT_CODEX_STREAM_MAX_RETRIES : value;
}

function normalizeStreamIdleTimeout(value: number | null | undefined): number | null {
  return value === undefined ? DEFAULT_CODEX_STREAM_IDLE_TIMEOUT_MS : value;
}

/**
 * 网关设置的规范内容。
 *
 * 排除 `updatedAt/gatewayToken/language/sync/networking/agentTargets`：
 * 令牌与语言是每台机器的本地偏好，同步元数据与 AgentTarget 各自单独处理。
 */
function settingsContent(input: SettingsContentInput): Record<string, unknown> {
  return {
    defaultProviderId: input.defaultProviderId ?? null,
    defaultModel: input.defaultModel ?? null,
    approvalReviewModel: input.approvalReviewModel ?? null,
    protocolConversion: input.protocolConversion,
    disableCodexWebSearch: input.disableCodexWebSearch,
    codexStreamMaxRetries: normalizeStreamRetries(input.codexStreamMaxRetries),
    codexStreamIdleTimeoutMs: normalizeStreamIdleTimeout(input.codexStreamIdleTimeoutMs),
  };
}

interface AgentTargetContentInput {
  mode: string;
  directProviderId: string | null;
  directModel: string | null;
}

/** AgentTarget 的规范内容；排除 `updatedAt`（它是同步元数据）。 */
function agentTargetContent(input: AgentTargetContentInput): Record<string, unknown> {
  return {
    mode: input.mode,
    directProviderId: input.directProviderId ?? null,
    directModel: input.directModel ?? null,
  };
}

/** AgentTarget 的"本地是否不旧于远端"；缺时间字段时按"远端更新"处理。 */
function localTargetNotOlder(local: AgentTargetPreference, remote: SyncSnapshotAgentTarget): boolean {
  if (local.updatedAt === undefined) return false;
  if (remote.updatedAt === undefined) return true;
  return compareTime(local.updatedAt, remote.updatedAt) >= 0;
}

interface ConflictFields {
  targetLabel: string;
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  changedFields: string[];
  localValue: unknown;
  remoteValue: unknown;
  remoteValueSealed: string | null;
}

export class SyncService {
  constructor(
    private readonly repos: TenantRepos,
    private readonly secrets: SecretCodec,
    /** 本机实例标识，用于拉取方判断"对端是否换了一台机器" */
    private readonly instanceId: string,
  ) {}

  /** 上一次 apply 是否检测到对端换机，供路由层写入 lastPullResult。 */
  private lastMasterChanged = false;

  /** 取走"对端是否换机"的标记（读取后重置）。 */
  takeMasterChanged(): boolean {
    const value = this.lastMasterChanged;
    this.lastMasterChanged = false;
    return value;
  }

  readConfig(): SyncConfig {
    return this.repos.settings.read().sync;
  }

  /** 当前角色能否提供快照（master / peer）。 */
  canServe(): boolean {
    return canServeSnapshot(this.readConfig().role);
  }

  /** 当前角色能否拉取对端（follower / peer）。 */
  canPull(): boolean {
    return canPullSnapshot(this.readConfig().role);
  }

  /**
   * 导出快照（master / peer 侧）。
   *
   * `apiKey` 在这里是明文——这是唯一一处有意把凭据明文放进出口函数的地方，
   * 因为请求方是另一台需要重新加密的机器。调用方（路由）必须保证：
   * 走 HTTPS（或显式允许不安全）、响应 no-store、日志不记 body。
   */
  exportSnapshot(scopes: SyncScope[]): SyncSnapshot {
    const settings = this.repos.settings.read();
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      masterId: this.instanceId,
      scopes,
    };

    if (scopes.includes('providers')) {
      snapshot.providers = this.repos.providers.list().map((record) => ({
        id: record.id,
        name: record.name,
        providerKey: record.providerKey,
        apiType: record.apiType,
        baseUrl: record.baseUrl,
        // 解密成明文：对端机器会用**它自己的**密钥重新加密
        apiKey: this.secrets.decode(record.apiKey),
        models: [...record.models],
        imageModels: record.imageModels ? [...record.imageModels] : undefined,
        modelCapabilities: record.modelCapabilities
          ? this.cloneCapabilities(record.modelCapabilities)
          : undefined,
        enabled: record.enabled,
        priority: record.priority,
        notes: record.notes,
        websiteUrl: record.websiteUrl,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
    }

    if (scopes.includes('settings')) {
      snapshot.settings = {
        defaultProviderId: settings.defaultProviderId,
        defaultModel: settings.defaultModel,
        approvalReviewModel: settings.approvalReviewModel,
        protocolConversion: settings.protocolConversion,
        disableCodexWebSearch: settings.disableCodexWebSearch,
        codexStreamMaxRetries: normalizeStreamRetries(settings.codexStreamMaxRetries),
        codexStreamIdleTimeoutMs: normalizeStreamIdleTimeout(settings.codexStreamIdleTimeoutMs),
        updatedAt: settings.updatedAt,
        // 注意：gatewayToken 不导出。它是本机自己的凭据，
        // 传给对端会让两台机器共用一个令牌——泄露面翻倍且无法单独吊销。
      };
    }

    if (scopes.includes('agentTargets')) {
      snapshot.agentTargets = Object.fromEntries(
        Object.entries(settings.agentTargets).map(([agentId, target]) => [
          agentId,
          {
            mode: target?.mode ?? 'gateway',
            directProviderId: target?.directProviderId ?? null,
            directModel: target?.directModel ?? null,
            updatedAt: target?.updatedAt,
          },
        ]),
      );
    }

    return snapshot;
  }

  /**
   * 把远端快照应用到本地（follower / peer 侧）。
   *
   * 三方合并（按 scope/targetId 逐项）：
   * - 有 base 时，`localChanged = localHash !== base`、`remoteChanged = remoteHash !== base`；
   *   只有远端变才应用，只有本地变就保留，两边都变成同一内容就收敛，都变但不同才冲突。
   * - 没有 base（首次同步）只能按 `updatedAt` 猜：本地不比远端旧且内容不同 → 冲突。
   *   时间戳相同也判冲突——让远端静默覆盖等于丢掉本地改动，那正是同步要避免的事。
   *
   * 返回：本次应用了多少条、本次涉及的冲突。
   */
  applySnapshot(
    snapshot: SyncSnapshot,
    now: string = new Date().toISOString(),
  ): { applied: number; conflicts: SyncConflict[] } {
    let applied = 0;

    // 记录来源实例：对端换了一台机器时，"本地更新更晚"的判据可能不再成立
    // （不同机器的时钟与历史不同），值得让人知道。
    //
    // 首次拉取时 lastMasterId 是 null（不是 undefined）：早先判断
    // `!== undefined` 会把"第一次"误报成"换机"，因为 null !== undefined。
    const previous = this.repos.settings.read().sync;
    if (previous.lastMasterId != null && previous.lastMasterId !== snapshot.masterId) {
      this.lastMasterChanged = true;
    }

    const stateMap = new Map<string, SyncStateEntry>();
    for (const entry of this.repos.syncState.read().entries) {
      stateMap.set(syncStateKey(entry.scope, entry.targetId), entry);
    }
    let stateDirty = false;

    const originalConflicts = this.repos.syncConflicts.list();
    const conflictMap = new Map<string, SyncConflict>();
    for (const conflict of originalConflicts) {
      conflictMap.set(syncStateKey(conflict.scope, conflict.targetId), conflict);
    }
    const touchedConflicts = new Set<string>();
    let conflictDirty = false;

    const getBase = (scope: SyncScope, targetId: string): string | undefined =>
      stateMap.get(syncStateKey(scope, targetId))?.hash;

    /** 推进基线；"只本地变"与"冲突"分支绝不调用它，否则下次会把本地改动当成已同步。 */
    const setBase = (scope: SyncScope, targetId: string, hash: string): void => {
      const key = syncStateKey(scope, targetId);
      const current = stateMap.get(key);
      if (current && current.hash === hash) return;
      stateMap.set(key, { scope, targetId, hash });
      stateDirty = true;
    };

    /** 发现两侧内容已经一致时删掉旧冲突（收敛），不让它一直挂在界面上。 */
    const clearConflict = (scope: SyncScope, targetId: string): void => {
      const key = syncStateKey(scope, targetId);
      if (conflictMap.delete(key)) {
        conflictDirty = true;
        touchedConflicts.delete(key);
      }
    };

    /** 同一条记录只保留一条冲突：重复拉取更新远端值，不堆重复项。 */
    const upsertConflict = (
      scope: SyncScope,
      targetId: string,
      hash: string,
      fields: ConflictFields,
    ): void => {
      const key = syncStateKey(scope, targetId);
      const existing = conflictMap.get(key);
      conflictMap.set(key, {
        // id 不变：前端可能正开着这条冲突的仲裁对话框
        id: existing?.id ?? `c_${randomBytes(6).toString('hex')}`,
        scope,
        targetId,
        targetLabel: fields.targetLabel,
        localUpdatedAt: fields.localUpdatedAt,
        remoteUpdatedAt: fields.remoteUpdatedAt,
        changedFields: fields.changedFields,
        localValue: fields.localValue,
        remoteValue: fields.remoteValue,
        remoteValueSealed: fields.remoteValueSealed,
        remoteHash: hash,
        // 首次发现时间保留，便于判断它挂了多久
        detectedAt: existing?.detectedAt ?? now,
      });
      conflictDirty = true;
      touchedConflicts.add(key);
    };

    // ── providers ────────────────────────────────────────────────
    if (snapshot.scopes.includes('providers') && snapshot.providers) {
      const local = new Map(this.repos.providers.list().map((item) => [item.id, item]));
      const merged: ProviderRecord[] = [];
      const remoteIds = new Set<string>();

      for (const remote of snapshot.providers) {
        remoteIds.add(remote.id);
        const localRecord = local.get(remote.id);

        if (!localRecord) {
          // 新建记录用 now：远端没变过，本机也没有历史可保留
          merged.push(this.toRecord(remote, now));
          setBase('providers', remote.id, this.hashRemoteProvider(remote));
          clearConflict('providers', remote.id);
          applied += 1;
          continue;
        }

        const localHash = this.hashProvider(localRecord);
        const remoteHash = this.hashRemoteProvider(remote);
        const base = getBase('providers', remote.id);

        if (base === undefined) {
          if (localHash === remoteHash) {
            setBase('providers', remote.id, localHash);
            clearConflict('providers', remote.id);
            merged.push(localRecord);
            continue;
          }
          // 首次同步没有共同基线，只能沿用 updatedAt 启发式。时间相同时判冲突：
          // 无法判断谁先改，交给人工裁决比赌一个方向安全。
          if (compareTime(localRecord.updatedAt, remote.updatedAt) >= 0) {
            upsertConflict('providers', remote.id, remoteHash, {
              targetLabel: `${remote.name} (${remote.providerKey})`,
              localUpdatedAt: localRecord.updatedAt,
              remoteUpdatedAt: remote.updatedAt,
              changedFields: this.diffProviderFields(localRecord, remote),
              localValue: this.toComparable(localRecord),
              // 远端版同样要脱敏：冲突文件会落盘给人看，不该成为凭据的第二份副本
              remoteValue: this.toComparable(remote),
              // 但"选远端"时要能真的写回去，所以另存一份加密的完整值
              remoteValueSealed: this.sealRemoteValue(remote),
            });
            merged.push(localRecord);
            continue;
          }
          // 应用远端时保留远端的 updatedAt：那是"这份配置从何时开始生效"的事实，
          // 换成 now 会让下一次比较看不出远端到底改没改。
          merged.push(this.toRecord(remote, now, remote.updatedAt));
          setBase('providers', remote.id, remoteHash);
          clearConflict('providers', remote.id);
          applied += 1;
          continue;
        }

        const localChanged = localHash !== base;
        const remoteChanged = remoteHash !== base;

        if (!localChanged && !remoteChanged) {
          // 两边都没动：不写盘、不计数。两侧内容一致（都等于 base），
          // 顺手清掉可能残留的旧冲突。
          merged.push(localRecord);
          clearConflict('providers', remote.id);
          continue;
        }
        if (localChanged && !remoteChanged) {
          // 只有本地改：保留本地，且**不推进基线**，否则下次会把这次改动当成已同步
          merged.push(localRecord);
          continue;
        }
        if (!localChanged && remoteChanged) {
          merged.push(this.toRecord(remote, now, remote.updatedAt));
          setBase('providers', remote.id, remoteHash);
          clearConflict('providers', remote.id);
          applied += 1;
          continue;
        }
        // 两边都改：内容一样就收敛
        if (localHash === remoteHash) {
          merged.push(this.toRecord(remote, now, remote.updatedAt));
          setBase('providers', remote.id, remoteHash);
          clearConflict('providers', remote.id);
          applied += 1;
          continue;
        }
        // 两边都改且内容不同 → 冲突，保留本地
        upsertConflict('providers', remote.id, remoteHash, {
          targetLabel: `${remote.name} (${remote.providerKey})`,
          localUpdatedAt: localRecord.updatedAt,
          remoteUpdatedAt: remote.updatedAt,
          changedFields: this.diffProviderFields(localRecord, remote),
          localValue: this.toComparable(localRecord),
          remoteValue: this.toComparable(remote),
          remoteValueSealed: this.sealRemoteValue(remote),
        });
        merged.push(localRecord);
      }

      // 远端没有、本地有的供应商**不删**：对端上删掉不该自动清空本机，
      // 那可能是本机自己加的、或对端还没同步过去的。
      for (const [id, record] of local) {
        if (!remoteIds.has(id)) merged.push(record);
      }

      this.repos.providers.saveAll(merged);
    }

    // ── settings ─────────────────────────────────────────────────
    if (snapshot.scopes.includes('settings') && snapshot.settings) {
      const remote = snapshot.settings;
      const localSettings = this.repos.settings.read();
      const localHash = this.settingsHash(localSettings);
      const remoteHash = this.settingsHash(remote);
      const base = getBase('settings', 'settings');

      const applyRemote = (): void => {
        this.writeRemoteSettings(remote);
        setBase('settings', 'settings', remoteHash);
        clearConflict('settings', 'settings');
        applied += 1;
      };
      const raiseConflict = (): void => {
        upsertConflict('settings', 'settings', remoteHash, {
          targetLabel: '网关设置',
          localUpdatedAt: localSettings.updatedAt,
          remoteUpdatedAt: remote.updatedAt,
          changedFields: this.diffSettingsFields(localSettings, remote),
          localValue: this.pickSettings(localSettings),
          remoteValue: this.pickSettings(remote),
          remoteValueSealed: this.sealRemoteValue(remote),
        });
      };

      if (base === undefined) {
        if (localHash === remoteHash) {
          setBase('settings', 'settings', localHash);
          clearConflict('settings', 'settings');
        } else if (compareTime(localSettings.updatedAt, remote.updatedAt) >= 0) {
          raiseConflict();
        } else {
          applyRemote();
        }
      } else {
        // 设置是整体一份、粒度粗：任一字段不同就算"这份设置变了"
        const localChanged = localHash !== base;
        const remoteChanged = remoteHash !== base;
        if (!localChanged && !remoteChanged) {
          // 两侧都等于 base，内容一致：清掉可能残留的旧冲突
          clearConflict('settings', 'settings');
        } else if (localChanged && !remoteChanged) {
          // 保留本地
        } else if (!localChanged && remoteChanged) {
          applyRemote();
        } else if (localHash === remoteHash) {
          applyRemote();
        } else {
          raiseConflict();
        }
      }
    }

    // ── agentTargets ─────────────────────────────────────────────
    if (snapshot.scopes.includes('agentTargets') && snapshot.agentTargets) {
      const localSettings = this.repos.settings.read();
      const mergedTargets = {
        ...localSettings.agentTargets,
      } as Partial<Record<AgentId, AgentTargetPreference>>;
      let settingsChanged = false;

      for (const [agentId, remote] of Object.entries(snapshot.agentTargets)) {
        const local = mergedTargets[agentId as AgentId];
        const remoteHash = this.agentTargetHash(remote);
        const remoteTarget: AgentTargetPreference = {
          mode: remote.mode as AgentConnectionMode,
          directProviderId: remote.directProviderId,
          directModel: remote.directModel,
          updatedAt: remote.updatedAt ?? now,
        };

        const applyRemote = (): void => {
          mergedTargets[agentId as AgentId] = remoteTarget;
          setBase('agentTargets', agentId, remoteHash);
          clearConflict('agentTargets', agentId);
          applied += 1;
          settingsChanged = true;
        };
        const raiseConflict = (current: AgentTargetPreference): void => {
          upsertConflict('agentTargets', agentId, remoteHash, {
            targetLabel: agentId,
            localUpdatedAt: current.updatedAt ?? null,
            remoteUpdatedAt: remote.updatedAt ?? null,
            changedFields: this.diffAgentTargetFields(current, remote),
            localValue: agentTargetContent(current),
            remoteValue: agentTargetContent(remote),
            remoteValueSealed: this.sealRemoteValue(remoteTarget),
          });
        };

        if (!local) {
          applyRemote();
          continue;
        }

        const localHash = this.agentTargetHash(local);
        const base = getBase('agentTargets', agentId);

        if (base === undefined) {
          if (localHash === remoteHash) {
            setBase('agentTargets', agentId, localHash);
            clearConflict('agentTargets', agentId);
          } else if (localTargetNotOlder(local, remote)) {
            raiseConflict(local);
          } else {
            applyRemote();
          }
          continue;
        }

        const localChanged = localHash !== base;
        const remoteChanged = remoteHash !== base;
        if (!localChanged && !remoteChanged) {
          // 两侧都等于 base，内容一致：清掉可能残留的旧冲突
          clearConflict('agentTargets', agentId);
          continue;
        }
        if (localChanged && !remoteChanged) {
          continue;
        }
        if ((!localChanged && remoteChanged) || localHash === remoteHash) {
          applyRemote();
          continue;
        }
        raiseConflict(local);
      }

      // agentTargets 住在 settings 里，但不该因此改动整份设置的 updatedAt：
      // 否则一个 Agent 的偏好变化会让 settings scope 看起来"本地改过"。
      if (settingsChanged) {
        this.repos.settings.write({ ...localSettings, agentTargets: mergedTargets });
      }
    }

    if (stateDirty) {
      this.repos.syncState.write({ entries: [...stateMap.values()], updatedAt: now });
    }
    if (conflictDirty) {
      this.repos.syncConflicts.saveAll([...conflictMap.values()]);
    }

    return {
      applied,
      conflicts: [...touchedConflicts]
        .map((key) => conflictMap.get(key))
        .filter((item): item is SyncConflict => item !== undefined),
    };
  }

  /**
   * 应用仲裁结果：用本地版或远端版覆盖某一项，并移除该冲突。
   *
   * 两种选择都把基线推进到**远端哈希**：选远端后本地内容等于远端；选本地后
   * 这份本地内容成为双方确认的版本，下次拉取不应因为同一份远端值反复报冲突。
   */
  resolveConflict(conflictId: string, choice: 'local' | 'remote'): boolean {
    const all = this.repos.syncConflicts.list();
    const conflict = all.find((item) => item.id === conflictId);
    if (!conflict) return false;

    const now = new Date().toISOString();
    const remoteHash =
      typeof conflict.remoteHash === 'string' && conflict.remoteHash !== ''
        ? conflict.remoteHash
        : null;

    if (choice === 'remote') {
      // 用加密保存的完整远端值，而不是界面上的脱敏版
      if (!conflict.remoteValueSealed) {
        throw new SyncSealedUnavailableError();
      }
      const remote = JSON.parse(this.secrets.decode(conflict.remoteValueSealed)) as unknown;

      if (conflict.scope === 'providers') {
        const entry = remote as SyncSnapshotProvider;
        const list = this.repos.providers.list();
        const index = list.findIndex((item) => item.id === conflict.targetId);
        // 冲突产生后本地记录可能已被删除；这时"选远端"应当把它建回来
        const record = this.toRecord(entry, now, entry.updatedAt ?? now);
        if (index >= 0) list[index] = record;
        else list.push(record);
        this.repos.providers.saveAll(list);
      } else if (conflict.scope === 'settings') {
        const entry = remote as SyncSnapshotSettings;
        // 契约：解决 remote 时本地 updatedAt 也用远端的时间，而不是 now
        this.writeRemoteSettings(entry);
      } else {
        const entry = remote as SyncSnapshotAgentTarget;
        const settings = this.repos.settings.read();
        const target: AgentTargetPreference = {
          mode: entry.mode as AgentConnectionMode,
          directProviderId: entry.directProviderId,
          directModel: entry.directModel,
          updatedAt: entry.updatedAt ?? now,
        };
        this.repos.settings.write({
          ...settings,
          agentTargets: { ...settings.agentTargets, [conflict.targetId as AgentId]: target },
        });
      }
    }
    // choice === 'local' 时不改数据，只把冲突标记解决（本地版就是现值）

    if (remoteHash) {
      const state = this.repos.syncState.read();
      const key = syncStateKey(conflict.scope, conflict.targetId);
      const entries = state.entries.filter(
        (entry) => syncStateKey(entry.scope, entry.targetId) !== key,
      );
      entries.push({ scope: conflict.scope, targetId: conflict.targetId, hash: remoteHash });
      this.repos.syncState.write({ entries, updatedAt: now });
    }

    this.repos.syncConflicts.saveAll(all.filter((item) => item.id !== conflictId));
    return true;
  }

  /** 把远端设置写进本地，保留本机的令牌、语言、同步与组网配置。 */
  private writeRemoteSettings(remote: SyncSnapshotSettings): void {
    const local = this.repos.settings.read();
    this.repos.settings.write({
      ...local,
      defaultProviderId: remote.defaultProviderId,
      defaultModel: remote.defaultModel,
      approvalReviewModel: remote.approvalReviewModel,
      protocolConversion: remote.protocolConversion,
      disableCodexWebSearch: remote.disableCodexWebSearch,
      codexStreamMaxRetries: normalizeStreamRetries(remote.codexStreamMaxRetries),
      codexStreamIdleTimeoutMs: normalizeStreamIdleTimeout(remote.codexStreamIdleTimeoutMs),
      // 契约：应用远端时保留远端 updatedAt
      updatedAt: remote.updatedAt,
      // gatewayToken 保留本地：每台机器有自己的一份
    });
  }

  /**
   * 把远端完整值封存起来供"选远端"时还原。
   *
   * **只在真正有加密密钥时才封存**：`secrets.encode()` 在未配置
   * `DATA_ENCRYPTION_KEY` 时是恒等函数（直通），此时"封存"等于把明文写进
   * `sync-conflicts.json` —— 而那个文件会经 `GET /api/sync/conflicts` 返回给
   * 任何有 `settings:read` 的人。宁可让"用远端版"这个操作不可用，
   * 也不要制造一份凭据明文副本。
   */
  private sealRemoteValue(value: unknown): string | null {
    if (!this.secrets.encrypted) return null;
    return this.secrets.encode(JSON.stringify(value));
  }

  /** 远端供应商 → 本地记录，密钥用本机 codec 重新加密。 */
  private toRecord(
    remote: SyncSnapshotProvider,
    now: string,
    updatedAt: string = now,
  ): ProviderRecord {
    return {
      id: remote.id,
      tenantId: this.repos.tenantId,
      name: remote.name,
      providerKey: remote.providerKey,
      apiType: remote.apiType as ProviderRecord['apiType'],
      baseUrl: remote.baseUrl,
      apiKey: this.secrets.encode(remote.apiKey),
      models: [...remote.models],
      imageModels: remote.imageModels ? [...remote.imageModels] : undefined,
      modelCapabilities: remote.modelCapabilities
        ? this.cloneCapabilities(remote.modelCapabilities)
        : undefined,
      enabled: remote.enabled,
      priority: remote.priority,
      notes: remote.notes,
      websiteUrl: remote.websiteUrl,
      createdBy: remote.createdBy,
      createdAt: remote.createdAt,
      updatedAt,
    };
  }

  /** 复制能力表：避免落盘记录与快照对象共享引用（后续改动会互相影响）。 */
  private cloneCapabilities(
    raw: Record<string, ModelCapability>,
  ): Record<string, ModelCapability> {
    const out: Record<string, ModelCapability> = {};
    for (const [model, capability] of Object.entries(raw)) {
      out[model] = {
        ...capability,
        reasoningEfforts: capability.reasoningEfforts
          ? [...capability.reasoningEfforts]
          : undefined,
        inputModalities: capability.inputModalities
          ? [...capability.inputModalities]
          : undefined,
      };
    }
    return out;
  }

  private hashProvider(record: ProviderRecord): string {
    return sha256(
      stableSerialize(
        providerContent({
          ...record,
          // 密钥比对/哈希用明文：本地是密文、远端是明文，不解码无法比较
          apiKey: this.secrets.decode(record.apiKey),
        }),
      ),
    );
  }

  private hashRemoteProvider(remote: SyncSnapshotProvider): string {
    return sha256(stableSerialize(providerContent(remote)));
  }

  private settingsHash(input: SettingsContentInput): string {
    return sha256(stableSerialize(settingsContent(input)));
  }

  private agentTargetHash(input: AgentTargetContentInput): string {
    return sha256(stableSerialize(agentTargetContent(input)));
  }

  private diffProviderFields(
    local: ProviderRecord,
    remote: SyncSnapshotProvider,
  ): string[] {
    const fields: string[] = [];
    if (local.name !== remote.name) fields.push('name');
    if (local.providerKey !== remote.providerKey) fields.push('providerKey');
    if (local.baseUrl !== remote.baseUrl) fields.push('baseUrl');
    if (local.apiType !== remote.apiType) fields.push('apiType');
    if (local.enabled !== remote.enabled) fields.push('enabled');
    if (local.priority !== remote.priority) fields.push('priority');
    if (local.models.join('\n') !== remote.models.join('\n')) fields.push('models');
    if ((local.imageModels ?? []).join('\n') !== (remote.imageModels ?? []).join('\n')) {
      fields.push('imageModels');
    }
    if (stableSerialize(providerContent({ ...local, apiKey: '' }).modelCapabilities) !==
        stableSerialize(providerContent({ ...remote, apiKey: '' }).modelCapabilities)) {
      fields.push('modelCapabilities');
    }
    if ((local.notes ?? '') !== (remote.notes ?? '')) fields.push('notes');
    if ((local.websiteUrl ?? '') !== (remote.websiteUrl ?? '')) fields.push('websiteUrl');
    if (this.secrets.decode(local.apiKey) !== remote.apiKey) fields.push('apiKey');
    return fields;
  }

  private diffSettingsFields(
    local: TenantSettings,
    remote: SyncSnapshotSettings,
  ): string[] {
    const fields: string[] = [];
    if (local.defaultProviderId !== remote.defaultProviderId) fields.push('defaultProviderId');
    if (local.defaultModel !== remote.defaultModel) fields.push('defaultModel');
    if (local.approvalReviewModel !== remote.approvalReviewModel) {
      fields.push('approvalReviewModel');
    }
    if (local.protocolConversion !== remote.protocolConversion) fields.push('protocolConversion');
    if (local.disableCodexWebSearch !== remote.disableCodexWebSearch) {
      fields.push('disableCodexWebSearch');
    }
    if (local.codexStreamMaxRetries !== normalizeStreamRetries(remote.codexStreamMaxRetries)) {
      fields.push('codexStreamMaxRetries');
    }
    if (
      local.codexStreamIdleTimeoutMs !== normalizeStreamIdleTimeout(remote.codexStreamIdleTimeoutMs)
    ) {
      fields.push('codexStreamIdleTimeoutMs');
    }
    return fields;
  }

  private diffAgentTargetFields(
    local: AgentTargetPreference,
    remote: SyncSnapshotAgentTarget,
  ): string[] {
    const fields: string[] = [];
    if (local.mode !== remote.mode) fields.push('mode');
    if ((local.directProviderId ?? null) !== (remote.directProviderId ?? null)) {
      fields.push('directProviderId');
    }
    if ((local.directModel ?? null) !== (remote.directModel ?? null)) {
      fields.push('directModel');
    }
    return fields;
  }

  /**
   * 冲突里存的可比较形态：**不含明文 Key**。
   *
   * 冲突文件会落盘、也会经接口返回给前端，把凭据放进去等于多了一份副本，
   * 而且它不在 `secrets.encode()` 的保护范围内（那是明文 JSON 文件）。
   * 所以两边都只留打码后的尾巴——足够让人判断"密钥是不是被改过"，
   * 但拿不到可用的值。真正的值仍在各自的 settings/providers 文件里。
   */
  private toComparable(
    record: ProviderRecord | SyncSnapshotProvider,
  ): Record<string, unknown> {
    const apiKey = 'apiKey' in record ? record.apiKey : '';
    // 本地记录的 apiKey 是密文，远端的是明文；打码都只取尾部几位，
    // 因为密文尾部与明文无关，这个字段仅用于"看起来是不是同一个"的粗判断
    const masked = apiKey === '' ? '' : `***${apiKey.slice(-4)}`;
    return {
      id: record.id,
      name: record.name,
      providerKey: record.providerKey,
      apiType: record.apiType,
      baseUrl: record.baseUrl,
      models: record.models,
      imageModels: record.imageModels ?? [],
      modelCapabilities: record.modelCapabilities ?? {},
      notes: record.notes ?? null,
      websiteUrl: record.websiteUrl ?? null,
      enabled: record.enabled,
      priority: record.priority,
      updatedAt: record.updatedAt,
      apiKeyMasked: masked,
    };
  }

  private pickSettings(input: SettingsContentInput & { updatedAt?: string }): Record<string, unknown> {
    return {
      defaultProviderId: input.defaultProviderId,
      defaultModel: input.defaultModel,
      approvalReviewModel: input.approvalReviewModel,
      protocolConversion: input.protocolConversion,
      disableCodexWebSearch: input.disableCodexWebSearch,
      codexStreamMaxRetries: normalizeStreamRetries(input.codexStreamMaxRetries),
      codexStreamIdleTimeoutMs: normalizeStreamIdleTimeout(input.codexStreamIdleTimeoutMs),
      updatedAt: input.updatedAt ?? null,
    };
  }
}
