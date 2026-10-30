import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, type TenantRepos } from '../src/store/tenantScope';
import { StorePaths } from '../src/store/paths';
import { createIdentityRepo } from '../src/store/identityRepo';
import { createLogger } from '../src/logger';
import { createSecretCodec } from '../src/crypto/secretCodec';
import { SyncService } from '../src/services/sync';
import { resetWarnings } from '../src/resilience';
import type { SyncSnapshot } from '../src/domain/sync';
import { toPublicSyncConflict, validateSyncSnapshot } from '../src/domain/sync';
import type { ProviderRecord } from '../src/domain/provider';
import { translate } from '../src/i18n';

/**
 * 同步的单元测试。
 *
 * 重点不在"能跑通"，而在三件容易做错的事：
 * 1. 跨机传的一定是**明文**（`enc:v1:` 密文换密钥解不开），落地必须重新加密
 * 2. 冲突**不覆盖**本地，且冲突文件里不能有明文 Key
 * 3. 每台机器的 `gatewayToken` 独立，不能被 master 的覆盖
 */

let dirs: string[] = [];

function makeTenant(encryptionKey: string | undefined): {
  repos: TenantRepos;
  secrets: ReturnType<typeof createSecretCodec>;
  instanceId: string;
  dataDir: string;
} {
  resetWarnings();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  dirs.push(dataDir);
  const paths = new StorePaths(dataDir);
  const logger = createLogger('error');
  const identity = createIdentityRepo(paths, logger);
  const store = createStore(paths, identity, logger);
  const repos = store.forTenant('t_default');
  return {
    repos,
    secrets: createSecretCodec(encryptionKey),
    instanceId: 'inst_test',
    dataDir,
  };
}

function sampleProvider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'p_1',
    tenantId: 't_default',
    name: 'wllapi',
    providerKey: 'wllapi',
    apiType: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret-value-abcdef',
    models: ['gpt-6-luna'],
    enabled: true,
    priority: 1,
    createdBy: 'u_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('同步：快照导出', () => {
  it('导出的 apiKey 是明文（对端要用自己的密钥重新加密）', () => {
    const { repos, secrets, instanceId } = makeTenant('master-encryption-key');
    // 落盘时是密文
    const stored = { ...sampleProvider(), apiKey: secrets.encode('sk-secret-value-abcdef') };
    expect(stored.apiKey.startsWith('enc:v1:')).toBe(true);
    repos.providers.saveAll([stored]);

    const service = new SyncService(repos, secrets, instanceId);
    const snapshot = service.exportSnapshot(['providers']);

    // 导出的必须是明文：对端机器的 DATA_ENCRYPTION_KEY 不同，密文解不开
    expect(snapshot.providers?.[0].apiKey).toBe('sk-secret-value-abcdef');
    expect(snapshot.providers?.[0].apiKey).not.toContain('enc:v1:');
  });

  it('不导出网关令牌（每台机器要有自己的一份）', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    const settings = repos.settings.read();
    repos.settings.write({
      ...settings,
      gatewayToken: {
        tokenHash: 'hash',
        tokenCipher: secrets.encode('lam_secret'),
        prefix: 'lam_abcd',
        tail: 'wxyz',
        createdAt: '2026-01-01T00:00:00.000Z',
        tenantId: 't_default',
        createdBy: 'u_1',
      },
    });

    const snapshot = new SyncService(repos, secrets, instanceId).exportSnapshot(['settings']);
    expect(snapshot.settings).toBeDefined();
    expect(snapshot.settings).not.toHaveProperty('gatewayToken');
    // 序列化后也不该出现令牌内容
    expect(JSON.stringify(snapshot)).not.toContain('lam_secret');
  });

  it('只导出勾选的范围', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([sampleProvider()]);
    const service = new SyncService(repos, secrets, instanceId);

    const onlyProviders = service.exportSnapshot(['providers']);
    expect(onlyProviders.providers).toBeDefined();
    expect(onlyProviders.settings).toBeUndefined();
    expect(onlyProviders.agentTargets).toBeUndefined();
  });
});

describe('同步：应用快照', () => {
  it('跨机应用后能用本机密钥解出正确明文', () => {
    // master 用 key A 加密
    const master = makeTenant('master-key-A');
    master.repos.providers.saveAll([
      { ...sampleProvider(), apiKey: master.secrets.encode('sk-real-upstream-key') },
    ]);
    const snapshot = new SyncService(
      master.repos,
      master.secrets,
      'master',
    ).exportSnapshot(['providers']);

    // follower 用完全不同的 key B
    const follower = makeTenant('follower-key-B');
    const result = new SyncService(follower.repos, follower.secrets, 'follower').applySnapshot(
      snapshot,
    );

    expect(result.conflicts).toHaveLength(0);
    const applied = follower.repos.providers.list()[0];
    // 落盘是 follower 的密文形态
    expect(applied.apiKey.startsWith('enc:v1:')).toBe(true);
    // 但必须能解出原文——这是整个功能的核心
    expect(follower.secrets.decode(applied.apiKey)).toBe('sk-real-upstream-key');
  });

  it('本地更新更晚且内容不同 → 冲突且不覆盖', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    // 本地有一条更新的记录
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local-new'),
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);

    // 远端是更旧但内容不同的一版
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        {
          ...sampleProvider(),
          apiKey: 'sk-remote-old',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    const result = new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].changedFields).toContain('apiKey');

    // 冲突时保留本地版，不静默丢弃
    const local = repos.providers.list()[0];
    expect(secrets.decode(local.apiKey)).toBe('sk-local-new');
  });

  it('远端更新更晚 → 直接应用，不产生冲突', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local-old'),
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-06-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        {
          ...sampleProvider(),
          apiKey: 'sk-remote-new',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    };

    const result = new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    expect(result.conflicts).toHaveLength(0);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-remote-new');
  });

  it('时间更晚但内容相同 → 不算冲突（改完又改回来）', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-same'),
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        { ...sampleProvider(), apiKey: 'sk-same', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };

    // 只比时间戳会误判成冲突；内容相同说明没有分歧
    const result = new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    expect(result.conflicts).toHaveLength(0);
  });

  it('冲突文件里不含明文 Key', () => {
    const { repos, secrets, instanceId, dataDir } = makeTenant('k1');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-LOCAL-SECRET-VALUE'),
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        { ...sampleProvider(), apiKey: 'sk-REMOTE-SECRET', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);

    const raw = fs.readFileSync(
      path.join(dataDir, 'tenants', 't_default', 'sync-conflicts.json'),
      'utf8',
    );
    // 冲突文件是给人看的，不该把凭据写进去
    expect(raw).not.toContain('sk-LOCAL-SECRET-VALUE');
    expect(raw).not.toContain('sk-REMOTE-SECRET');
    expect(raw).toContain('apiKeyMasked');
  });

  it('远端没有的供应商不会被删除（可能是本机自己加的）', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([
      sampleProvider({ id: 'p_keep', providerKey: 'keep', apiKey: secrets.encode('sk-keep') }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [],
    };
    new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    expect(repos.providers.list()).toHaveLength(1);
  });

  it('不覆盖本机的网关令牌', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    const settings = repos.settings.read();
    repos.settings.write({
      ...settings,
      gatewayToken: {
        tokenHash: 'local-hash',
        tokenCipher: secrets.encode('lam_local'),
        prefix: 'lam_local',
        tail: 'loc1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tenantId: 't_default',
        createdBy: 'u_1',
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-06-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['settings'],
      settings: {
        defaultProviderId: 'p_1',
        defaultModel: 'gpt-6-luna',
        approvalReviewModel: null,
        protocolConversion: true,
        disableCodexWebSearch: true,
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    };
    new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);

    const after = repos.settings.read();
    expect(after.defaultModel).toBe('gpt-6-luna');
    expect(after.protocolConversion).toBe(true);
    // 令牌必须还是本机那一份
    expect(after.gatewayToken?.tokenHash).toBe('local-hash');
  });
});

describe('同步：冲突仲裁', () => {
  it('选 remote 时用远端版覆盖并移除冲突', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local'),
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        { ...sampleProvider(), apiKey: 'sk-remote', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const service = new SyncService(repos, secrets, instanceId);
    const { conflicts } = service.applySnapshot(snapshot);
    expect(conflicts).toHaveLength(1);

    const ok = service.resolveConflict(conflicts[0].id, 'remote');
    expect(ok).toBe(true);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-remote');
    expect(repos.syncConflicts.list()).toHaveLength(0);
  });

  it('选 local 时保持本地值并移除冲突', () => {
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local'),
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        { ...sampleProvider(), apiKey: 'sk-remote', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const service = new SyncService(repos, secrets, instanceId);
    const { conflicts } = service.applySnapshot(snapshot);

    service.resolveConflict(conflicts[0].id, 'local');
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-local');
    expect(repos.syncConflicts.list()).toHaveLength(0);
  });
});

describe('同步：安全边界（回归）', () => {
  it('未配置加密密钥时不封存远端完整值（否则明文会落进冲突文件）', () => {
    // 真实漏洞：`secrets.encode()` 在无 DATA_ENCRYPTION_KEY 时是恒等函数，
    // 于是 remoteValueSealed 里就是明文 JSON，而那个文件会经
    // GET /api/sync/conflicts 返回给任何有 settings:read 的人。
    const { repos, secrets, instanceId } = makeTenant(undefined); // 无密钥
    expect(secrets.encrypted).toBe(false);

    repos.providers.saveAll([
      sampleProvider({
        apiKey: 'sk-local',
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        { ...sampleProvider(), apiKey: 'sk-remote', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const { conflicts } = new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    expect(conflicts).toHaveLength(1);
    // 关键断言：没有可用的封存值，而不是存了明文
    expect(conflicts[0].remoteValueSealed).toBeNull();
  });

  it('有加密密钥时封存值不可直接读出明文', () => {
    const { repos, secrets, instanceId } = makeTenant('real-key');
    expect(secrets.encrypted).toBe(true);

    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-local'), updatedAt: '2026-06-01T00:00:00.000Z' }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        { ...sampleProvider(), apiKey: 'sk-remote-secret', updatedAt: '2026-01-01T00:00:00.000Z' },
      ],
    };
    const { conflicts } = new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    const sealed = conflicts[0].remoteValueSealed;
    expect(sealed).toBeTruthy();
    // 封存的是密文，不是能被直接读走的明文
    expect(sealed).not.toContain('sk-remote-secret');
    expect(sealed!.startsWith('enc:v1:')).toBe(true);
  });

  it('时区偏移的 ISO 字符串不会误判冲突（按时间数值比较）', () => {
    // 真实缺陷：直接比较字符串时 '2026-05-05T10:00:00+08:00'（=02:00Z）
    // 会被判成比 '2026-05-05T05:00:00.000Z' 更晚，于是误产生冲突、
    // 并保留了本该被覆盖的本地值。
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local'),
        // 真实时间 02:00Z，比远端的 05:00Z 更早
        updatedAt: '2026-05-05T10:00:00+08:00',
      }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-05-05T05:00:00.000Z',
      masterId: 'other',
      scopes: ['providers'],
      providers: [
        { ...sampleProvider(), apiKey: 'sk-remote-newer', updatedAt: '2026-05-05T05:00:00.000Z' },
      ],
    };
    const { conflicts } = new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    // 远端确实更新，不该判成冲突
    expect(conflicts).toHaveLength(0);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-remote-newer');
  });
});

describe('同步：时间比较与冲突判据', () => {
  it('时间戳相同但内容不同也判为冲突（不让远端静默覆盖）', () => {
    // 原实现走 else 分支让远端覆盖，等于丢掉本地改动——
    // 正是这个功能声称要避免的情况。
    const { repos, secrets, instanceId } = makeTenant('k1');
    const sameTime = '2026-05-05T00:00:00.000Z';
    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-local'), updatedAt: sameTime }),
    ]);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: sameTime,
      masterId: 'other',
      scopes: ['providers'],
      providers: [{ ...sampleProvider(), apiKey: 'sk-remote', updatedAt: sameTime }],
    };
    const result = new SyncService(repos, secrets, instanceId).applySnapshot(snapshot);
    expect(result.conflicts).toHaveLength(1);
    // 本地值不被覆盖
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-local');
  });
});

describe('同步：范围的空值语义', () => {
  it('exportSnapshot 收到空范围时不导出任何内容', () => {
    // 空范围必须是"什么都不同步"，不能是"全部同步"。
    // 后者等于"用户没勾选任何项，系统却擅自把全部上游 Key 导出"。
    const { repos, secrets, instanceId } = makeTenant('k1');
    repos.providers.saveAll([sampleProvider()]);
    const snapshot = new SyncService(repos, secrets, instanceId).exportSnapshot([]);

    expect(snapshot.providers).toBeUndefined();
    expect(snapshot.settings).toBeUndefined();
    expect(snapshot.agentTargets).toBeUndefined();
    expect(snapshot.scopes).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 界面语言：报错文案跟随 i18n
// ══════════════════════════════════════════════════════════════════

describe('同步接口的错误文案走 i18n', () => {
  /**
   * 这一组是合并 `main` 的 i18n 之后补的。
   *
   * 原先 `routes/sync.ts` 把中文成品文案直接传给 `badRequest()`，
   * 而 `MessageKey` 是 `string`，**类型检查抓不到**：英文界面下会原样输出中文。
   * 只能靠断言 `messageKey` 来锁住。
   */

  it('sync 字典在中英文里都有翻译（不是回落到键名）', () => {
    // 回落到键名是 `translate` 查不到键时的行为（`missing()` 返回 key 本身），
    // 那样界面会显示 "sync.scopes.mustBeArray" 这种字符串。
    for (const key of [
      'sync.scopes.mustBeArray',
      'sync.masterUrl.invalid',
      'sync.pull.tokenRequired',
      'sync.conflict.unknown',
      'sync.snapshot.mustUseHttps',
    ]) {
      for (const language of ['zh', 'en'] as const) {
        const text = translate(language, key as never, { value: 'X', id: 'Y' });
        expect(text, `${language} 缺 ${key}`).not.toBe(key);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it('中英文文案确实不同（避免只写了中文）', () => {
    // 两个字典都填了同一句中文是最常见的半成品状态，这条能抓出来
    const zh = translate('zh', 'sync.scopes.mustBeArray' as never);
    const en = translate('en', 'sync.scopes.mustBeArray' as never);
    expect(zh).not.toBe(en);
    expect(/[\u4e00-\u9fff]/.test(zh)).toBe(true);
    expect(/[\u4e00-\u9fff]/.test(en)).toBe(false);
  });

  it('插值参数会真的被替换', () => {
    const text = translate('en', 'sync.pull.badStatus' as never, {
      status: 502,
      reason: 'bad gateway',
    });
    expect(text).toContain('502');
    expect(text).toContain('bad gateway');
    expect(text).not.toContain('{{');
  });
});

// ══════════════════════════════════════════════════════════════════
// Phase 1：双向同步（peer 场景、sync-state 三方合并、冲突收敛）
// ══════════════════════════════════════════════════════════════════

/** 一份合法的远端供应商条目。 */
function remoteProvider(
  overrides: Partial<NonNullable<SyncSnapshot['providers']>[number]> = {},
): NonNullable<SyncSnapshot['providers']>[number] {
  return {
    id: 'p_1',
    name: 'wllapi',
    providerKey: 'wllapi',
    apiType: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-remote',
    models: ['gpt-6-luna'],
    enabled: true,
    priority: 1,
    createdBy: 'u_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function providersSnapshot(
  providers: Array<NonNullable<SyncSnapshot['providers']>[number]>,
  overrides: Partial<SyncSnapshot> = {},
): SyncSnapshot {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    masterId: 'peer_b',
    scopes: ['providers'],
    providers,
    ...overrides,
  };
}

function remoteSettings(
  overrides: Partial<NonNullable<SyncSnapshot['settings']>> = {},
): NonNullable<SyncSnapshot['settings']> {
  return {
    defaultProviderId: 'p_1',
    defaultModel: 'gpt-6-luna',
    approvalReviewModel: null,
    protocolConversion: false,
    disableCodexWebSearch: true,
    codexStreamMaxRetries: 10,
    codexStreamIdleTimeoutMs: 600_000,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 读某条基线，供断言"有没有推进"；同步文件不暴露 API，只能从仓储看。 */
function baseHash(
  repos: TenantRepos,
  scope: 'providers' | 'settings' | 'agentTargets',
  targetId: string,
): string | undefined {
  return repos.syncState
    .read()
    .entries.find((entry) => entry.scope === scope && entry.targetId === targetId)?.hash;
}

describe('同步：快照导出补齐 Phase 1 字段', () => {
  it('供应商带 imageModels / modelCapabilities / notes / websiteUrl', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-x'),
        imageModels: ['gpt-image-2'],
        modelCapabilities: {
          'gpt-6-luna': {
            contextWindow: 128_000,
            maxOutputTokens: 4_096,
            supportsReasoning: true,
            reasoningEfforts: ['high', 'low'],
            inputModalities: ['text', 'image'],
          },
        },
        notes: '主线路',
        websiteUrl: 'https://example.com',
      }),
    ]);

    const snapshot = new SyncService(repos, secrets, instanceId).exportSnapshot(['providers']);
    expect(snapshot.providers?.[0].imageModels).toEqual(['gpt-image-2']);
    expect(snapshot.providers?.[0].modelCapabilities?.['gpt-6-luna']).toMatchObject({
      contextWindow: 128_000,
      reasoningEfforts: ['high', 'low'],
    });
    expect(snapshot.providers?.[0].notes).toBe('主线路');
    expect(snapshot.providers?.[0].websiteUrl).toBe('https://example.com');
  });

  it('设置带两个 Codex 流式字段，agentTargets 带 updatedAt', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const settings = repos.settings.read();
    repos.settings.write({
      ...settings,
      codexStreamMaxRetries: 7,
      codexStreamIdleTimeoutMs: 123_456,
      agentTargets: {
        codex: {
          mode: 'direct',
          directProviderId: 'p_1',
          directModel: 'gpt-6-luna',
          updatedAt: '2026-03-03T00:00:00.000Z',
        },
      },
    });

    const snapshot = new SyncService(repos, secrets, instanceId).exportSnapshot([
      'settings',
      'agentTargets',
    ]);
    expect(snapshot.settings?.codexStreamMaxRetries).toBe(7);
    expect(snapshot.settings?.codexStreamIdleTimeoutMs).toBe(123_456);
    expect(snapshot.agentTargets?.codex.updatedAt).toBe('2026-03-03T00:00:00.000Z');
  });
});

describe('同步：三方合并（sync-state 基线）', () => {
  it('建立基线后仅本地变：保留本地且不推进基线', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const service = new SyncService(repos, secrets, instanceId);
    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-a'), updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    // 第一次拉取内容一致 → 建立基线
    const initial = service.applySnapshot(
      providersSnapshot([remoteProvider({ apiKey: 'sk-a' })]),
    );
    expect(initial.conflicts).toHaveLength(0);
    const firstBase = baseHash(repos, 'providers', 'p_1');
    expect(firstBase).toMatch(/^[0-9a-f]{64}$/);

    // 只有本地改
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local-new'),
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
    ]);
    const result = service.applySnapshot(providersSnapshot([remoteProvider({ apiKey: 'sk-a' })]));

    expect(result.conflicts).toHaveLength(0);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-local-new');
    // 关键：基线不能推进，否则下次拉取会把这次本地改动当成"已同步"而覆盖掉
    expect(baseHash(repos, 'providers', 'p_1')).toBe(firstBase);
  });

  it('建立基线后仅远端变：应用远端并推进基线', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const service = new SyncService(repos, secrets, instanceId);
    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-a'), updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    service.applySnapshot(providersSnapshot([remoteProvider({ apiKey: 'sk-a' })]));

    const result = service.applySnapshot(
      providersSnapshot([
        remoteProvider({
          apiKey: 'sk-b',
          updatedAt: '2026-03-01T00:00:00.000Z',
        }),
      ]),
    );

    expect(result.applied).toBe(1);
    expect(result.conflicts).toHaveLength(0);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-b');
    // 应用远端保留远端 updatedAt（不是本机 now）
    expect(repos.providers.list()[0].updatedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(baseHash(repos, 'providers', 'p_1')).not.toBeUndefined();
  });

  it('两侧都改成同一内容：收敛并计数', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const service = new SyncService(repos, secrets, instanceId);
    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-a'), updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    service.applySnapshot(providersSnapshot([remoteProvider({ apiKey: 'sk-a' })]));

    // 两边各自改成了同样的内容（时间不同也无所谓，内容哈希一致）
    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-same'), updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const result = service.applySnapshot(
      providersSnapshot([
        remoteProvider({ apiKey: 'sk-same', updatedAt: '2026-03-01T00:00:00.000Z' }),
      ]),
    );

    expect(result.applied).toBe(1);
    expect(result.conflicts).toHaveLength(0);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-same');
    expect(baseHash(repos, 'providers', 'p_1')).not.toBeUndefined();
  });

  it('两侧都改且内容不同：冲突、保留本地、不推进基线', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const service = new SyncService(repos, secrets, instanceId);
    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-a'), updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    service.applySnapshot(providersSnapshot([remoteProvider({ apiKey: 'sk-a' })]));
    const baseBefore = baseHash(repos, 'providers', 'p_1');

    repos.providers.saveAll([
      sampleProvider({ apiKey: secrets.encode('sk-local'), updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    const result = service.applySnapshot(
      providersSnapshot([
        remoteProvider({ apiKey: 'sk-remote-new', updatedAt: '2026-03-01T00:00:00.000Z' }),
      ]),
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].scope).toBe('providers');
    expect(result.conflicts[0].changedFields).toContain('apiKey');
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-local');
    expect(baseHash(repos, 'providers', 'p_1')).toBe(baseBefore);
  });

  it('没有基线的首次同步仍按 updatedAt：本地更新且不同 → 冲突', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local'),
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);

    const result = new SyncService(repos, secrets, instanceId).applySnapshot(
      providersSnapshot([remoteProvider({ apiKey: 'sk-remote' })]),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-local');
  });
});

describe('同步：冲突 upsert 与收敛清理', () => {
  function seedConflict(): {
    repos: TenantRepos;
    secrets: ReturnType<typeof createSecretCodec>;
    service: SyncService;
  } {
    const { repos, secrets, instanceId } = makeTenant('k');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-local'),
        updatedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    return { repos, secrets, service: new SyncService(repos, secrets, instanceId) };
  }

  it('重复拉取同一目标只保留一条冲突，但会更新远端值', () => {
    const { repos, service } = seedConflict();
    const first = service.applySnapshot(
      providersSnapshot([remoteProvider({ name: '远端一', apiKey: 'sk-r1' })]),
    );
    expect(first.conflicts).toHaveLength(1);
    const id = first.conflicts[0].id;

    const second = service.applySnapshot(
      providersSnapshot([remoteProvider({ name: '远端二', apiKey: 'sk-r2' })]),
    );

    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0].id).toBe(id);
    expect(second.conflicts[0].remoteValue).toMatchObject({ name: '远端二' });
    // 落盘也只有一条，不是累积成两条
    expect(repos.syncConflicts.list()).toHaveLength(1);
  });

  it('本地内容追上远端后，下一次拉取删除已有冲突', () => {
    const { repos, secrets, service } = seedConflict();
    const first = service.applySnapshot(
      providersSnapshot([remoteProvider({ apiKey: 'sk-remote' })]),
    );
    expect(first.conflicts).toHaveLength(1);
    expect(repos.syncConflicts.list()).toHaveLength(1);

    // 用户手工把本地改成与远端一致（等价于"选远端"之外的另一条收敛路径）
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-remote'),
        updatedAt: '2026-07-01T00:00:00.000Z',
      }),
    ]);
    const second = service.applySnapshot(
      providersSnapshot([remoteProvider({ apiKey: 'sk-remote' })]),
    );

    expect(second.conflicts).toHaveLength(0);
    expect(repos.syncConflicts.list()).toHaveLength(0);
  });

  it('选 local 后把基线推进到远端哈希：再拉同一份远端不会重复报冲突', () => {
    const { repos, secrets, service } = seedConflict();
    const snapshot = providersSnapshot([remoteProvider({ apiKey: 'sk-remote' })]);
    const first = service.applySnapshot(snapshot);
    expect(first.conflicts).toHaveLength(1);

    expect(service.resolveConflict(first.conflicts[0].id, 'local')).toBe(true);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-local');

    const second = service.applySnapshot(snapshot);
    expect(second.conflicts).toHaveLength(0);
    expect(second.applied).toBe(0);
    expect(secrets.decode(repos.providers.list()[0].apiKey)).toBe('sk-local');
    expect(baseHash(repos, 'providers', 'p_1')).not.toBeUndefined();
  });

  it('选 remote 后应用远端内容与 updatedAt，并推进基线', () => {
    const { repos, secrets, service } = seedConflict();
    const snapshot = providersSnapshot([
      remoteProvider({ apiKey: 'sk-remote', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    const first = service.applySnapshot(snapshot);

    expect(service.resolveConflict(first.conflicts[0].id, 'remote')).toBe(true);
    const record = repos.providers.list()[0];
    expect(secrets.decode(record.apiKey)).toBe('sk-remote');
    expect(record.updatedAt).toBe('2026-03-01T00:00:00.000Z');

    const second = service.applySnapshot(snapshot);
    expect(second.conflicts).toHaveLength(0);
    expect(second.applied).toBe(0);
  });

  it('对外冲突形态剔除 remoteValueSealed 与 remoteHash', () => {
    const { service } = seedConflict();
    const { conflicts } = service.applySnapshot(
      providersSnapshot([remoteProvider({ apiKey: 'sk-remote' })]),
    );
    const publicConflict = toPublicSyncConflict(conflicts[0]);
    expect(publicConflict).not.toHaveProperty('remoteValueSealed');
    expect(publicConflict).not.toHaveProperty('remoteHash');
  });
});

describe('同步：settings 与 agentTargets 的三方合并', () => {
  it('设置仅远端变：覆盖并保留远端 updatedAt，网关令牌不动', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const service = new SyncService(repos, secrets, instanceId);
    repos.settings.write({ ...repos.settings.read(), ...remoteSettings() });
    service.applySnapshot({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'peer_b',
      scopes: ['settings'],
      settings: remoteSettings(),
    });

    const result = service.applySnapshot({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'peer_b',
      scopes: ['settings'],
      settings: remoteSettings({
        defaultModel: 'gpt-6-nova',
        codexStreamMaxRetries: 3,
        updatedAt: '2026-05-01T00:00:00.000Z',
      }),
    });

    expect(result.applied).toBe(1);
    const after = repos.settings.read();
    expect(after.defaultModel).toBe('gpt-6-nova');
    expect(after.codexStreamMaxRetries).toBe(3);
    expect(after.updatedAt).toBe('2026-05-01T00:00:00.000Z');
  });

  it('旧快照缺流式字段时按默认值处理，不把本机设成 null', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const service = new SyncService(repos, secrets, instanceId);
    const legacy = remoteSettings();
    delete (legacy as { codexStreamMaxRetries?: number | null }).codexStreamMaxRetries;
    delete (legacy as { codexStreamIdleTimeoutMs?: number | null }).codexStreamIdleTimeoutMs;

    service.applySnapshot({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'peer_old',
      scopes: ['settings'],
      settings: legacy,
    });

    const after = repos.settings.read();
    expect(after.codexStreamMaxRetries).toBe(10);
    expect(after.codexStreamIdleTimeoutMs).toBe(600_000);
  });

  it('agentTargets 应用远端时保留远端 updatedAt，且不推进 settings.updatedAt', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const settings = repos.settings.read();
    repos.settings.write({ ...settings, updatedAt: '2026-01-01T00:00:00.000Z' });
    const service = new SyncService(repos, secrets, instanceId);

    const result = service.applySnapshot({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'peer_b',
      scopes: ['agentTargets'],
      agentTargets: {
        codex: {
          mode: 'direct',
          directProviderId: 'p_1',
          directModel: 'gpt-6-luna',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    });

    expect(result.applied).toBe(1);
    const after = repos.settings.read();
    expect(after.agentTargets.codex).toMatchObject({
      mode: 'direct',
      directProviderId: 'p_1',
      directModel: 'gpt-6-luna',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    // AgentTarget 是设置的一部分，但不该让"整份设置"看起来变过
    expect(after.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(baseHash(repos, 'agentTargets', 'codex')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('agentTargets 也会产生冲突，并能用远端版解决', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const settings = repos.settings.read();
    repos.settings.write({
      ...settings,
      agentTargets: {
        codex: {
          mode: 'gateway',
          directProviderId: null,
          directModel: null,
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const service = new SyncService(repos, secrets, instanceId);
    const snapshot: SyncSnapshot = {
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      masterId: 'peer_b',
      scopes: ['agentTargets'],
      agentTargets: {
        codex: {
          mode: 'direct',
          directProviderId: 'p_1',
          directModel: 'gpt-6-luna',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };

    const result = service.applySnapshot(snapshot);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].scope).toBe('agentTargets');
    expect(result.conflicts[0].targetId).toBe('codex');
    // 冲突期间保留本地
    expect(repos.settings.read().agentTargets.codex?.mode).toBe('gateway');

    expect(service.resolveConflict(result.conflicts[0].id, 'remote')).toBe(true);
    expect(repos.settings.read().agentTargets.codex).toMatchObject({
      mode: 'direct',
      directProviderId: 'p_1',
      directModel: 'gpt-6-luna',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const again = service.applySnapshot(snapshot);
    expect(again.conflicts).toHaveLength(0);
  });
});

describe('同步：lastMasterChanged 不误报', () => {
  it('首次拉取（lastMasterId 为 null）不算换机', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const service = new SyncService(repos, secrets, instanceId);
    service.applySnapshot(providersSnapshot([], { masterId: 'peer_first' }));
    expect(service.takeMasterChanged()).toBe(false);
  });

  it('确实换了实例标识才提示', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const settings = repos.settings.read();
    repos.settings.write({
      ...settings,
      sync: { ...settings.sync, lastMasterId: 'peer_old' },
    });
    const service = new SyncService(repos, secrets, instanceId);
    service.applySnapshot(providersSnapshot([], { masterId: 'peer_new' }));
    expect(service.takeMasterChanged()).toBe(true);
  });

  it('同一实例标识不提示', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    const settings = repos.settings.read();
    repos.settings.write({
      ...settings,
      sync: { ...settings.sync, lastMasterId: 'peer_same' },
    });
    const service = new SyncService(repos, secrets, instanceId);
    service.applySnapshot(providersSnapshot([], { masterId: 'peer_same' }));
    expect(service.takeMasterChanged()).toBe(false);
  });
});

describe('同步：快照校验', () => {
  it('本机导出的快照能通过校验（往返一致）', () => {
    const { repos, secrets, instanceId } = makeTenant('k');
    repos.providers.saveAll([
      sampleProvider({
        apiKey: secrets.encode('sk-x'),
        imageModels: ['gpt-image-2'],
        modelCapabilities: { 'gpt-6-luna': { contextWindow: 1_000_000 } },
      }),
    ]);
    const exported = new SyncService(repos, secrets, instanceId).exportSnapshot([
      'providers',
      'settings',
      'agentTargets',
    ]);
    const result = validateSyncSnapshot(exported);
    expect(result.ok).toBe(true);
  });

  it('未来 schemaVersion 明确拒绝，而不是按当前结构硬解读', () => {
    const raw: unknown = { ...providersSnapshot([remoteProvider()]), schemaVersion: 2 };
    const result = validateSyncSnapshot(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messageKey).toBe('sync.snapshot.futureSchema');
      expect(result.params).toMatchObject({ remote: 2, local: 1 });
    }
  });

  it('结构不合法统一返回 sync.snapshot.malformed', () => {
    const cases: unknown[] = [
      null,
      'not-a-snapshot',
      {},
      { schemaVersion: 1 },
      { schemaVersion: 1, exportedAt: 'x', masterId: '', scopes: [] },
      { schemaVersion: 1, exportedAt: 'x', masterId: 'm', scopes: ['nope'] },
      { schemaVersion: 1, exportedAt: 'x', masterId: 'm', scopes: ['settings'], settings: {} },
      {
        schemaVersion: 1,
        exportedAt: 'x',
        masterId: 'm',
        scopes: ['agentTargets'],
        agentTargets: { codex: { mode: 'sideways', directProviderId: null, directModel: null } },
      },
      providersSnapshot([remoteProvider({ apiType: 'grpc' })]),
    ];
    for (const raw of cases) {
      const result = validateSyncSnapshot(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) expect(result.messageKey).toBe('sync.snapshot.malformed');
    }
  });

  it('provider id 重复被拒绝（否则会静默相互覆盖）', () => {
    const result = validateSyncSnapshot(
      providersSnapshot([remoteProvider({ id: 'p_dup' }), remoteProvider({ id: 'p_dup' })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messageKey).toBe('sync.snapshot.malformed');
      expect(String(result.params.reason)).toContain('duplicate');
    }
  });
});
