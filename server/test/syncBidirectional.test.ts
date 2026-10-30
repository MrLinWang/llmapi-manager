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
import type { SyncScope } from '../src/domain/sync';
import type { ProviderRecord } from '../src/domain/provider';

/**
 * 双向同步的端到端（两台机器）测试。
 *
 * 这里刻意**不测 HTTP**：路由层的权限/校验在 `smoke.test.ts` 覆盖，
 * 本文件只验证"两台机器各自有 sync-state 时，来回拉取会收敛还是会冲突"。
 * 这正是只测单向（sync.test.ts）看不出来的部分——很多缺陷只在第二次
 * 反向拉取时才出现（例如基线没推进、冲突反复重生、远端 updatedAt 被改写）。
 */

let dirs: string[] = [];

interface Peer {
  name: string;
  dataDir: string;
  repos: TenantRepos;
  secrets: ReturnType<typeof createSecretCodec>;
  service: SyncService;
}

function makePeer(name: string): Peer {
  resetWarnings();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sync-pair-${name}-`));
  dirs.push(dataDir);
  const paths = new StorePaths(dataDir);
  const logger = createLogger('error');
  const identity = createIdentityRepo(paths, logger);
  const store = createStore(paths, identity, logger);
  const repos = store.forTenant('t_default');
  const secrets = createSecretCodec(`${name}-encryption-key`);
  return {
    name,
    dataDir,
    repos,
    secrets,
    service: new SyncService(repos, secrets, `inst_${name}`),
  };
}

function provider(
  peer: Peer,
  overrides: Partial<ProviderRecord> = {},
): ProviderRecord {
  return {
    id: 'p_1',
    tenantId: 't_default',
    name: 'wllapi',
    providerKey: 'wllapi',
    apiType: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: peer.secrets.encode('sk-shared'),
    models: ['gpt-6-luna'],
    enabled: true,
    priority: 1,
    notes: 'origin',
    createdBy: 'u_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 模拟"to 从 from 拉一次"。 */
function pull(
  from: Peer,
  to: Peer,
  scopes: SyncScope[] = ['providers', 'settings', 'agentTargets'],
): ReturnType<SyncService['applySnapshot']> {
  return to.service.applySnapshot(from.service.exportSnapshot(scopes));
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('双向同步：peer 角色', () => {
  it('peer 既能提供快照也能拉取', () => {
    const peer = makePeer('peer');
    const settings = peer.repos.settings.read();
    peer.repos.settings.write({
      ...settings,
      sync: { ...settings.sync, role: 'peer', masterUrl: 'https://other.example.com' },
    });
    expect(peer.service.canServe()).toBe(true);
    expect(peer.service.canPull()).toBe(true);
  });

  it('standalone / master / follower 的能力边界', () => {
    const peer = makePeer('roles');
    const settings = peer.repos.settings.read();
    const setRole = (role: 'standalone' | 'master' | 'follower'): void => {
      const current = peer.repos.settings.read();
      peer.repos.settings.write({
        ...current,
        sync: { ...current.sync, role, masterUrl: 'https://other.example.com' },
      });
    };

    setRole('standalone');
    expect(peer.service.canServe()).toBe(false);
    expect(peer.service.canPull()).toBe(false);
    setRole('master');
    expect(peer.service.canServe()).toBe(true);
    expect(peer.service.canPull()).toBe(false);
    setRole('follower');
    expect(peer.service.canServe()).toBe(false);
    expect(peer.service.canPull()).toBe(true);
  });
});

describe('双向同步：两端来回拉取', () => {
  it('A 改 → B 拉 → B 改 → A 拉：两端收敛，无冲突', () => {
    const a = makePeer('a');
    const b = makePeer('b');
    a.repos.providers.saveAll([provider(a, { notes: 'from-a' })]);

    // B 第一次从 A 拉：本地没有 → 新建
    const first = pull(a, b, ['providers']);
    expect(first.conflicts).toHaveLength(0);
    expect(b.secrets.decode(b.repos.providers.list()[0].apiKey)).toBe('sk-shared');

    // B 改了一个字段
    b.repos.providers.saveAll([
      provider(b, { notes: 'from-b', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);

    // A 反向拉 B：A 没有基线，但远端更新 → 应用
    const second = pull(b, a, ['providers']);
    expect(second.conflicts).toHaveLength(0);
    expect(a.repos.providers.list()[0].notes).toBe('from-b');

    // B 再拉 A：两端内容一致 → 收敛，不应产生冲突
    const third = pull(a, b, ['providers']);
    expect(third.conflicts).toHaveLength(0);
    expect(third.applied).toBeGreaterThanOrEqual(0);
    expect(b.repos.providers.list()[0].notes).toBe('from-b');
  });

  it('双方各改一处且不同：冲突保留本地，选远端后反向拉取收敛', () => {
    const a = makePeer('a');
    const b = makePeer('b');
    a.repos.providers.saveAll([provider(a)]);
    // 先让两端都建立基线：B 拉 A，然后 A 拉 B（内容相同）
    expect(pull(a, b, ['providers']).conflicts).toHaveLength(0);
    expect(pull(b, a, ['providers']).conflicts).toHaveLength(0);

    // A 改名，B 改地址——两边都基于同一份基线
    a.repos.providers.saveAll([
      provider(a, { name: 'A-side', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    b.repos.providers.saveAll([
      provider(b, {
        baseUrl: 'https://b.example.com/v1',
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    ]);

    const conflicted = pull(b, a, ['providers']);
    expect(conflicted.conflicts).toHaveLength(1);
    // 冲突期间保留本地版（A 的名字还在）
    expect(a.repos.providers.list()[0].name).toBe('A-side');

    // A 选远端：拿到 B 的整份供应商内容
    expect(a.service.resolveConflict(conflicted.conflicts[0].id, 'remote')).toBe(true);
    const afterResolve = a.repos.providers.list()[0];
    expect(afterResolve.baseUrl).toBe('https://b.example.com/v1');
    expect(afterResolve.name).toBe('wllapi');
    expect(afterResolve.updatedAt).toBe('2026-03-01T00:00:00.000Z');

    // B 反向拉 A：内容已一致 → 收敛，不再报冲突
    const converged = pull(a, b, ['providers']);
    expect(converged.conflicts).toHaveLength(0);
    expect(b.repos.providers.list()[0].baseUrl).toBe('https://b.example.com/v1');
  });

  it('选 local 后，同一份远端再拉不会重复产生冲突', () => {
    const a = makePeer('a');
    const b = makePeer('b');
    a.repos.providers.saveAll([provider(a)]);
    pull(a, b, ['providers']);
    pull(b, a, ['providers']);

    a.repos.providers.saveAll([
      provider(a, { name: 'keep-me', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    b.repos.providers.saveAll([
      provider(b, { name: 'remote-name', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]);

    const conflicted = pull(b, a, ['providers']);
    expect(conflicted.conflicts).toHaveLength(1);
    expect(a.service.resolveConflict(conflicted.conflicts[0].id, 'local')).toBe(true);
    expect(a.repos.providers.list()[0].name).toBe('keep-me');

    // 原始缺陷：基线没推进时，每次拉取都会重新报同一条冲突
    const again = pull(b, a, ['providers']);
    expect(again.conflicts).toHaveLength(0);
    expect(a.repos.providers.list()[0].name).toBe('keep-me');
    expect(a.repos.syncConflicts.list()).toHaveLength(0);
  });

  it('冲突后远端改成本地版本：下一次拉取自动清除冲突（收敛）', () => {
    const a = makePeer('a');
    const b = makePeer('b');
    a.repos.providers.saveAll([provider(a)]);
    pull(a, b, ['providers']);
    pull(b, a, ['providers']);

    a.repos.providers.saveAll([
      provider(a, { notes: 'A-edited', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]);
    b.repos.providers.saveAll([
      provider(b, { notes: 'B-edited', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ]);
    const conflicted = pull(b, a, ['providers']);
    expect(conflicted.conflicts).toHaveLength(1);
    expect(a.repos.syncConflicts.list()).toHaveLength(1);

    // 用户在对端把配置改回 A 的版本（等价于"双方最终选了同一个值"）
    b.repos.providers.saveAll([
      provider(b, { notes: 'A-edited', updatedAt: '2026-04-01T00:00:00.000Z' }),
    ]);

    const result = pull(b, a, ['providers']);
    expect(result.conflicts).toHaveLength(0);
    expect(a.repos.syncConflicts.list()).toHaveLength(0);
    expect(a.repos.providers.list()[0].notes).toBe('A-edited');
  });
});

describe('双向同步：settings 与 agentTargets', () => {
  it('设置与 Agent 偏好双向流动，并保留远端 updatedAt', () => {
    const a = makePeer('a');
    const b = makePeer('b');
    const settings = a.repos.settings.read();
    a.repos.settings.write({
      ...settings,
      defaultProviderId: 'p_1',
      defaultModel: 'gpt-6-luna',
      codexStreamMaxRetries: 4,
      codexStreamIdleTimeoutMs: 120_000,
      agentTargets: {
        codex: {
          mode: 'direct',
          directProviderId: 'p_1',
          directModel: 'gpt-6-luna',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    // B 是一台早就装好、但没配过这些内容的机器：把它的设置时间调旧，
    // 否则"刚初始化的默认设置"会以 now 被当成比 A 更新，首次拉取就报假冲突。
    const bBootstrap = b.repos.settings.read();
    b.repos.settings.write({ ...bBootstrap, updatedAt: '2025-01-01T00:00:00.000Z' });

    // B 拉 A
    expect(pull(a, b).conflicts).toHaveLength(0);
    expect(b.repos.settings.read().defaultModel).toBe('gpt-6-luna');
    expect(b.repos.settings.read().agentTargets.codex?.mode).toBe('direct');

    // A 反向拉一次建立自己的基线（内容相同）
    expect(pull(b, a).conflicts).toHaveLength(0);

    // B 改设置与 AgentTarget
    const bSettings = b.repos.settings.read();
    b.repos.settings.write({
      ...bSettings,
      codexStreamMaxRetries: 9,
      agentTargets: {
        codex: {
          mode: 'gateway',
          directProviderId: null,
          directModel: null,
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-05-01T00:00:00.000Z',
    });

    // A 拉 B：只有远端变 → 应用，并保留远端时间
    const result = pull(b, a);
    expect(result.conflicts).toHaveLength(0);
    const after = a.repos.settings.read();
    expect(after.codexStreamMaxRetries).toBe(9);
    expect(after.updatedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(after.agentTargets.codex?.mode).toBe('gateway');
    expect(after.agentTargets.codex?.updatedAt).toBe('2026-05-01T00:00:00.000Z');

    // B 再拉 A：两端一致，收敛且不产生冲突
    expect(pull(a, b).conflicts).toHaveLength(0);
  });

  it('两端各自改不同的 AgentTarget：产生冲突并可各自选择', () => {
    const a = makePeer('a');
    const b = makePeer('b');
    const initialTarget = {
      mode: 'gateway' as const,
      directProviderId: null,
      directModel: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const aSettings = a.repos.settings.read();
    a.repos.settings.write({
      ...aSettings,
      agentTargets: { codex: initialTarget },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    pull(a, b);
    pull(b, a);

    a.repos.settings.write({
      ...a.repos.settings.read(),
      agentTargets: {
        codex: {
          mode: 'direct',
          directProviderId: 'p_1',
          directModel: 'gpt-6-luna',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      },
    });
    b.repos.settings.write({
      ...b.repos.settings.read(),
      agentTargets: {
        codex: {
          mode: 'direct',
          directProviderId: 'p_other',
          directModel: 'another-model',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      },
    });

    const conflicted = pull(b, a);
    const agentConflict = conflicted.conflicts.find((item) => item.scope === 'agentTargets');
    expect(agentConflict).toBeDefined();
    expect(agentConflict?.targetId).toBe('codex');
    // 冲突期间保留本地
    expect(a.repos.settings.read().agentTargets.codex?.directProviderId).toBe('p_1');

    expect(a.service.resolveConflict(agentConflict!.id, 'remote')).toBe(true);
    expect(a.repos.settings.read().agentTargets.codex).toMatchObject({
      directProviderId: 'p_other',
      directModel: 'another-model',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });

    // 反向拉取不再冲突
    expect(pull(a, b).conflicts).toHaveLength(0);
  });
});
