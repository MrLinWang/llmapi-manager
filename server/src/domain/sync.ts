/**
 * 多设备配置同步。
 *
 * 用途：一台机器（master）配好供应商与 Agent 设置后，其余设备（follower）跟随，
 * 省掉逐台重配。典型场景是先在一台 Linux 上配好，再让 Windows 端同步过去，
 * 这样两端 Codex 都指向同一处，`codex` 的 SSH 远程能力才能两端都工作。
 *
 * 三个刻意的边界：
 * 1. **不传 `DATA_ENCRYPTION_KEY`**：每台机器自己的密钥独立。跨机传密钥必须
 *    解密成明文再传、落地时用本机密钥重新加密（`enc:v1:` 密文换个密钥解不开）。
 * 2. **不同步登录口令与会话**：否则一台机器被入侵等于全部沦陷。
 * 3. **不覆盖有本地改动的项**：冲突保留双版本，由人仲裁——配置被静默改掉比报错更难查。
 */

/** 可以同步的内容。用户在前端勾选，未勾选的一律不动。 */
export const SYNC_SCOPES = ['providers', 'settings', 'agentTargets'] as const;
export type SyncScope = (typeof SYNC_SCOPES)[number];

/** 各 scope 的中文说明，前端直接展示，避免两处维护文案。 */
export const SYNC_SCOPE_LABELS: Record<SyncScope, string> = {
  providers: '供应商与模型（含上游 API Key，跨机重新加密）',
  settings: '网关设置（默认模型、跨协议转发、审批模型等）',
  agentTargets: 'Agent 连接方式（走网关 / 直连）',
};

export type SyncRole = 'standalone' | 'master' | 'follower';

export interface SyncConfig {
  role: SyncRole;
  /**
   * follower 要拉取的 master 地址，形如 `https://box.example.com:8787`。
   * master 角色下不用它。
   */
  masterUrl: string | null;
  /** 勾选同步哪些内容；空数组表示什么都不动（安全的默认） */
  scopes: SyncScope[];
  /** 上次成功拉取的时间 */
  lastPullAt: string | null;
  /** 上次拉取的结果摘要，供界面显示（不含凭据内容） */
  lastPullResult: string | null;
  /**
   * 上次拉取时 master 的实例标识。
   *
   * 用于发现"master 换了一台机器"——换了之后"谁更新"的判断依据不再可靠
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
  detectedAt: string;
}

export interface SyncConflictsData {
  conflicts: SyncConflict[];
}

export function defaultSyncConflictsData(): SyncConflictsData {
  return { conflicts: [] };
}

/**
 * 同步快照：master 导出给 follower 的内容。
 *
 * 注意 `providers[].apiKey` 在这里是**明文**——`enc:v1:` 密文绑定 master 的
 * `DATA_ENCRYPTION_KEY`，直接传给 follower 解不开。落地时 follower 会用本机密钥
 * 重新加密。因此这个响应绝不能被缓存，日志里也不能记录 body。
 */
export interface SyncSnapshot {
  /** 快照格式版本，便于将来演进时识别 */
  schemaVersion: 1;
  exportedAt: string;
  /** master 的实例标识，follower 用它判断"是不是换了一台机器" */
  masterId: string;
  scopes: SyncScope[];
  providers?: Array<{
    id: string;
    name: string;
    providerKey: string;
    apiType: string;
    baseUrl: string;
    /** 明文；follower 侧立即重新加密 */
    apiKey: string;
    models: string[];
    enabled: boolean;
    priority: number;
    notes?: string;
    websiteUrl?: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  }>;
  settings?: {
    defaultProviderId: string | null;
    defaultModel: string | null;
    approvalReviewModel: string | null;
    protocolConversion: boolean;
    disableCodexWebSearch: boolean;
    updatedAt: string;
    /**
     * 网关令牌**不在这里**：它是 master 自己的凭据，follower 需要有自己的一份。
     * 传过去会让两台机器共用一个令牌，泄露面翻倍且无法单独吊销。
     */
  };
  agentTargets?: Record<
    string,
    { mode: string; directProviderId: string | null; directModel: string | null }
  >;
}
