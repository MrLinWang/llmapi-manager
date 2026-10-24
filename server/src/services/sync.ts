import { randomBytes } from 'node:crypto';
import type { TenantRepos } from '../store/tenantScope';
import type { SecretCodec } from '../crypto/secretCodec';
import type { ProviderRecord } from '../domain/provider';
import type { SyncConfig, SyncConflict, SyncScope, SyncSnapshot } from '../domain/sync';
import type { TenantSettings } from '../domain/settings';

/**
 * 配置同步的读写。
 *
 * 只做"导出 / 应用 / 冲突判定"三件事，**不负责网络**——发请求在路由层，
 * 这样核心逻辑可以用纯函数测试，不需要起两台服务。
 *
 * 一条贯穿全文的约束：`enc:v1:` 密文绑定本机的 `DATA_ENCRYPTION_KEY`，
 * 换个密钥就解不开。所以跨机传输的永远是**明文**，落地时立刻用本机密钥重新加密。
 * 这意味着快照响应绝不能缓存、也绝不能记进日志。
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

export class SyncService {
  constructor(
    private readonly repos: TenantRepos,
    private readonly secrets: SecretCodec,
    /** 本机实例标识，用于 follower 判断"master 是否换了一台机器" */
    private readonly instanceId: string,
  ) {}

  /** 上一次 apply 是否检测到 master 换机，供路由层写入 lastPullResult。 */
  private lastMasterChanged = false;

  /** 取走"master 是否换机"的标记（读取后重置）。 */
  takeMasterChanged(): boolean {
    const value = this.lastMasterChanged;
    this.lastMasterChanged = false;
    return value;
  }

  readConfig(): SyncConfig {
    return this.repos.settings.read().sync;
  }

  /**
   * 导出快照（master 侧）。
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
      snapshot.providers = this.repos.providers
        .list()
        .map((record) => ({
          id: record.id,
          name: record.name,
          providerKey: record.providerKey,
          apiType: record.apiType,
          baseUrl: record.baseUrl,
          // 解密成明文：对端机器会用**它自己的**密钥重新加密
          apiKey: this.secrets.decode(record.apiKey),
          models: [...record.models],
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
        updatedAt: settings.updatedAt,
        // 注意：gatewayToken 不导出。它是 master 自己的凭据，
        // 传给 follower 会让两台机器共用一个令牌——泄露面翻倍且无法单独吊销。
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
          },
        ]),
      );
    }

    return snapshot;
  }

  /**
   * 把远端快照应用到本地（follower 侧）。
   *
   * 冲突判定：本地记录比远端**更新**、且内容不同 → 冲突，保留双版本不覆盖。
   * 只比时间戳不安全（改完又改回来的情况会误判），所以同时比内容哈希。
   *
   * 返回：应用了多少条、产生了多少冲突。
   */
  applySnapshot(
    snapshot: SyncSnapshot,
    now: string = new Date().toISOString(),
  ): { applied: number; conflicts: SyncConflict[] } {
    const conflicts: SyncConflict[] = [];
    let applied = 0;

    // 记录来源实例：master 换了一台机器时，"本地更新更晚"的判据可能不再成立
    // （不同机器的时钟与历史不同），值得让人知道。
    const previous = this.repos.settings.read().sync;
    if (previous.lastMasterId !== undefined && previous.lastMasterId !== snapshot.masterId) {
      this.lastMasterChanged = true;
    }

    if (snapshot.scopes.includes('providers') && snapshot.providers) {
      const local = new Map(this.repos.providers.list().map((item) => [item.id, item]));
      const merged: ProviderRecord[] = [];

      for (const remote of snapshot.providers) {
        const localRecord = local.get(remote.id);
        if (!localRecord) {
          // 本地没有 → 直接新增（重新加密后落盘）
          merged.push(this.toRecord(remote, now));
          applied += 1;
          continue;
        }

        const contentDiffers = !this.sameProviderContent(localRecord, remote);
        const timeCompare = compareTime(localRecord.updatedAt, remote.updatedAt);
        // 判据是"内容不同 + 本地不比远端旧"：
        // - 时间戳相同但内容不同 → 也算冲突。原实现走 else 分支让远端静默覆盖，
        //   等于丢掉本地改动，正是这个功能声称要避免的情况。
        // - 时间戳相同时无法判断谁先改，交给人工裁决比赌一个方向安全。
        const localChanged = contentDiffers && timeCompare >= 0;

        if (localChanged) {
          // 本地更新且内容不同 → 冲突，两边都留着等人选
          conflicts.push({
            id: `c_${randomBytes(6).toString('hex')}`,
            scope: 'providers',
            targetId: remote.id,
            targetLabel: `${remote.name} (${remote.providerKey})`,
            localUpdatedAt: localRecord.updatedAt,
            remoteUpdatedAt: remote.updatedAt,
            changedFields: this.diffProviderFields(localRecord, remote),
            localValue: this.toComparable(localRecord),
            // 远端版同样要脱敏：冲突文件会落盘给人看，不该成为凭据的第二份副本
            remoteValue: this.toComparable(remote),
            // 但"选远端"时要能真的写回去，所以另存一份加密的完整值
            remoteValueSealed: this.sealRemoteValue(remote),
            detectedAt: now,
          });
          // 冲突期间保留本地版，不静默丢弃
          merged.push(localRecord);
          continue;
        }

        // 远端更新或内容一致 → 用远端
        merged.push(this.toRecord(remote, now));
        applied += 1;
      }

      // 远端没有、本地有的供应商**不删**：master 上删掉不该自动清空 follower 的，
      // 那可能是 follower 自己加的、或 master 还没同步过去的。
      const remoteIds = new Set(snapshot.providers.map((item) => item.id));
      for (const [id, record] of local) {
        if (!remoteIds.has(id)) merged.push(record);
      }

      this.repos.providers.saveAll(merged);
    }

    if (snapshot.scopes.includes('settings') && snapshot.settings) {
      const localSettings = this.repos.settings.read();
      const remote = snapshot.settings;
      // 设置是整体一份，冲突粒度粗：本地更新更晚就保留本地并报一条冲突
      const localNewer = compareTime(localSettings.updatedAt, remote.updatedAt) > 0;
      const differs =
        localSettings.defaultProviderId !== remote.defaultProviderId ||
        localSettings.defaultModel !== remote.defaultModel ||
        localSettings.approvalReviewModel !== remote.approvalReviewModel ||
        localSettings.protocolConversion !== remote.protocolConversion ||
        localSettings.disableCodexWebSearch !== remote.disableCodexWebSearch;

      if (localNewer && differs) {
        conflicts.push({
          id: `c_${randomBytes(6).toString('hex')}`,
          scope: 'settings',
          targetId: 'settings',
          targetLabel: '网关设置',
          localUpdatedAt: localSettings.updatedAt,
          remoteUpdatedAt: remote.updatedAt,
          changedFields: this.diffSettingsFields(localSettings, remote),
          localValue: this.pickSettings(localSettings),
          remoteValue: this.pickSettings({ ...localSettings, ...remote }),
          remoteValueSealed: this.sealRemoteValue(remote),
          detectedAt: now,
        });
      } else {
        const next: TenantSettings = {
          ...localSettings,
          defaultProviderId: remote.defaultProviderId,
          defaultModel: remote.defaultModel,
          approvalReviewModel: remote.approvalReviewModel,
          protocolConversion: remote.protocolConversion,
          disableCodexWebSearch: remote.disableCodexWebSearch,
          updatedAt: remote.updatedAt,
          // gatewayToken 保留本地：每台机器有自己的一份，不能用 master 的覆盖
        };
        this.repos.settings.write(next);
        applied += 1;
      }
    }

    if (snapshot.scopes.includes('agentTargets') && snapshot.agentTargets) {
      const localSettings = this.repos.settings.read();
      const mergedTargets = { ...localSettings.agentTargets };
      for (const [agentId, remote] of Object.entries(snapshot.agentTargets)) {
        const local = mergedTargets[agentId as keyof typeof mergedTargets];
        if (!local || local.mode !== remote.mode ||
            local.directProviderId !== remote.directProviderId ||
            local.directModel !== remote.directModel) {
          mergedTargets[agentId as keyof typeof mergedTargets] = {
            mode: remote.mode as 'gateway' | 'direct',
            directProviderId: remote.directProviderId,
            directModel: remote.directModel,
          };
          applied += 1;
        }
      }
      this.repos.settings.write({
        ...localSettings,
        agentTargets: mergedTargets,
        updatedAt: localSettings.updatedAt,
      });
    }

    // 冲突累积而不是覆盖：多次拉取产生的冲突都要能被人看到
    if (conflicts.length > 0) {
      this.repos.syncConflicts.saveAll([...this.repos.syncConflicts.list(), ...conflicts]);
    }

    return { applied, conflicts };
  }

  /** 应用仲裁结果：用本地版或远端版覆盖某一项，并移除该冲突。 */
  resolveConflict(conflictId: string, choice: 'local' | 'remote'): boolean {
    const all = this.repos.syncConflicts.list();
    const conflict = all.find((item) => item.id === conflictId);
    if (!conflict) return false;

    if (choice === 'remote') {
      // 用远端版覆盖本地：重新走一次 apply，但只针对这一条
      if (conflict.scope === 'providers') {
        // 用加密保存的完整远端值，而不是界面上的脱敏版
        if (!conflict.remoteValueSealed) {
          throw new SyncSealedUnavailableError();
        }
        const remote = JSON.parse(
          this.secrets.decode(conflict.remoteValueSealed),
        ) as NonNullable<SyncSnapshot['providers']>[number];
        const local = this.repos.providers.list();
        this.repos.providers.saveAll(
          local.map((item) =>
            item.id === conflict.targetId ? this.toRecord(remote, new Date().toISOString()) : item,
          ),
        );
      } else if (conflict.scope === 'settings') {
        if (!conflict.remoteValueSealed) {
          throw new SyncSealedUnavailableError();
        }
        const remote = JSON.parse(
          this.secrets.decode(conflict.remoteValueSealed),
        ) as NonNullable<SyncSnapshot['settings']>;
        const local = this.repos.settings.read();
        this.repos.settings.write({
          ...local,
          defaultProviderId: remote.defaultProviderId,
          defaultModel: remote.defaultModel,
          approvalReviewModel: remote.approvalReviewModel,
          protocolConversion: remote.protocolConversion,
          disableCodexWebSearch: remote.disableCodexWebSearch,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    // choice === 'local' 时不改数据，只把冲突标记解决（本地版就是现值）

    this.repos.syncConflicts.saveAll(all.filter((item) => item.id !== conflictId));
    return true;
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
    remote: NonNullable<SyncSnapshot['providers']>[number],
    now: string,
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
      enabled: remote.enabled,
      priority: remote.priority,
      notes: remote.notes,
      websiteUrl: remote.websiteUrl,
      createdBy: remote.createdBy,
      createdAt: remote.createdAt,
      updatedAt: now,
    };
  }

  /** 比较内容是否等价。只比关键字段，updatedAt 单独判断。 */
  private sameProviderContent(
    local: ProviderRecord,
    remote: NonNullable<SyncSnapshot['providers']>[number],
  ): boolean {
    return (
      local.name === remote.name &&
      local.providerKey === remote.providerKey &&
      local.apiType === remote.apiType &&
      local.baseUrl === remote.baseUrl &&
      local.enabled === remote.enabled &&
      local.priority === remote.priority &&
      local.models.join('\n') === remote.models.join('\n') &&
      // 密钥比对用明文：本地是密文、远端是明文，不解码无法比较
      this.secrets.decode(local.apiKey) === remote.apiKey
    );
  }

  private diffProviderFields(
    local: ProviderRecord,
    remote: NonNullable<SyncSnapshot['providers']>[number],
  ): string[] {
    const fields: string[] = [];
    if (local.name !== remote.name) fields.push('name');
    if (local.baseUrl !== remote.baseUrl) fields.push('baseUrl');
    if (local.apiType !== remote.apiType) fields.push('apiType');
    if (local.enabled !== remote.enabled) fields.push('enabled');
    if (local.priority !== remote.priority) fields.push('priority');
    if (local.models.join('\n') !== remote.models.join('\n')) fields.push('models');
    if (this.secrets.decode(local.apiKey) !== remote.apiKey) fields.push('apiKey');
    return fields;
  }

  private diffSettingsFields(
    local: TenantSettings,
    remote: NonNullable<SyncSnapshot['settings']>,
  ): string[] {
    const fields: string[] = [];
    if (local.defaultProviderId !== remote.defaultProviderId) fields.push('defaultProviderId');
    if (local.defaultModel !== remote.defaultModel) fields.push('defaultModel');
    if (local.approvalReviewModel !== remote.approvalReviewModel) fields.push('approvalReviewModel');
    if (local.protocolConversion !== remote.protocolConversion) fields.push('protocolConversion');
    if (local.disableCodexWebSearch !== remote.disableCodexWebSearch) {
      fields.push('disableCodexWebSearch');
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
    record: ProviderRecord | NonNullable<SyncSnapshot['providers']>[number],
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
      enabled: record.enabled,
      priority: record.priority,
      updatedAt: record.updatedAt,
      apiKeyMasked: masked,
    };
  }

  private pickSettings(settings: TenantSettings): Record<string, unknown> {
    return {
      defaultProviderId: settings.defaultProviderId,
      defaultModel: settings.defaultModel,
      approvalReviewModel: settings.approvalReviewModel,
      protocolConversion: settings.protocolConversion,
      disableCodexWebSearch: settings.disableCodexWebSearch,
      updatedAt: settings.updatedAt,
    };
  }
}
