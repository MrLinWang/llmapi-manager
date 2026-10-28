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
