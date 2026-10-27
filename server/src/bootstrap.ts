import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config';
import type { Logger } from './logger';
import { hashPassword } from './auth/password';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_NAME,
  OWNER_USER_ID,
  type IdentityData,
  type User,
} from './domain/identity';
import { defaultSetupState, type SetupState } from './domain/setup';
import type { IdentityRepo } from './store/identityRepo';
import type { SetupRepo } from './store/setupRepo';
import type { StorePaths } from './store/paths';
import { addWarning } from './resilience';

export interface BootstrapResult {
  /**
   * 本次启动是否处于"待初始化"状态。
   * 为 true 时需要把 setupToken 打印到控制台 —— 那是认领管理员的唯一凭据。
   */
  needsSetup: boolean;
  /** 仅首次生成时返回；后续启动不再打印 */
  setupToken?: string;
  /** 是否由本次启动创建了管理员账号（ADMIN_PASSWORD 应急通道） */
  createdOwner: boolean;
}

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSetupToken(): { token: string; hash: string } {
  const token = `setup_${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashSetupToken(token) };
}

/** 常量时间比对，避免用响应时间试探 token。 */
export function verifySetupToken(input: string, expectedHash: string | null): boolean {
  if (!expectedHash || !input) return false;
  const actual = Buffer.from(hashSetupToken(input), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** 管理员账号是否已存在（用于 ADMIN_PASSWORD 应急通道的幂等判断）。 */
export function findAdminUser(config: AppConfig, data: IdentityData): User | undefined {
  return data.users.find(
    (item) => item.tenantId === DEFAULT_TENANT_ID && item.username === config.adminUsername,
  );
}

/**
 * 是否已完成初始化 —— 只看"默认租户里有没有账号"。
 *
 * 不能拿用户名去比对 ADMIN_USERNAME：首次初始化时用户名由用户自己填，
 * 可能完全不等于默认值。曾经按用户名判断，导致用自定义用户名初始化后
 * 重启会被误判为"未初始化"，重新发一次令牌（等于开了后门）。
 */
export function isInitialized(identity: IdentityRepo): boolean {
  return hasAnyUser(identity.read());
}

/** 默认租户是否已有账号（供 bootstrap 内部使用，避免重复读文件）。 */
function hasAnyUser(data: IdentityData): boolean {
  return data.users.some((item) => item.tenantId === DEFAULT_TENANT_ID);
}

/**
 * 幂等初始化，两条路径：
 *
 * 1. **默认**：不创建账号，生成一次性 setup token 打印到控制台，
 *    由用户在浏览器设置页自己填用户名与口令。
 * 2. **应急**：显式配置了 `ADMIN_PASSWORD` 时直接建号，适合 Docker/systemd 这类无交互部署。
 *
 * 已初始化时完全不动 —— 尤其不能覆盖用户已改过的口令。
 */
export async function bootstrapIdentity(
  config: AppConfig,
  paths: StorePaths,
  identity: IdentityRepo,
  logger: Logger,
  setup: SetupRepo,
): Promise<BootstrapResult> {
  fs.mkdirSync(paths.tenantDir(DEFAULT_TENANT_ID), { recursive: true });

  const data: IdentityData = identity.read();
  const tenant = data.tenants.find((item) => item.id === DEFAULT_TENANT_ID);

  // 判据是"默认租户里有没有账号"，而不是"有没有叫 ADMIN_USERNAME 的账号"：
  // 首次初始化时用户名由用户自填，可能不等于默认值。
  if (tenant && hasAnyUser(data)) {
    // 已初始化：清掉可能残留的 token，别留下"看起来还能认领"的状态
    markCompleted(setup, setup.read());
    ensureTenantFiles(paths);
    return { needsSetup: false, createdOwner: false };
  }

  const now = new Date().toISOString();
  if (!tenant) {
    data.tenants.push({
      id: DEFAULT_TENANT_ID,
      name: DEFAULT_TENANT_NAME,
      status: 'active',
      createdAt: now,
    });
  }

  if (config.adminPassword) {
    const user: User = {
      id: OWNER_USER_ID,
      tenantId: DEFAULT_TENANT_ID,
      username: config.adminUsername,
      role: 'owner',
      passwordHash: await hashPassword(config.adminPassword),
      authVersion: 1,
      status: 'active',
      createdAt: now,
    };
    data.users.push(user);
    identity.write(data);
    markCompleted(setup, setup.read(), now);
    ensureTenantFiles(paths);
    logger.info('logs.startup.adminCreated', {
      username: user.username,
      tenantId: user.tenantId,
      role: user.role,
    });
    return { needsSetup: false, createdOwner: true };
  }

  identity.write(data);
  const state = setup.read();
  if (state.tokenHash) {
    // 已经生成过 token（例如重启但还没完成设置）：沿用旧的，不重复打印
    ensureTenantFiles(paths);
    return { needsSetup: true, createdOwner: false };
  }

  const { token, hash } = createSetupToken();
  setup.write({ ...defaultSetupState(), tokenHash: hash, createdAt: now });
  ensureTenantFiles(paths);
  addWarning('setup_pending', 'warnings.setupPending');
  return { needsSetup: true, setupToken: token, createdOwner: false };
}

function markCompleted(setup: SetupRepo, state: SetupState, at?: string): void {
  if (state.completed && !state.tokenHash) return;
  setup.write({
    ...state,
    completed: true,
    tokenHash: null,
    failedAttempts: 0,
    completedAt: state.completedAt ?? at ?? new Date().toISOString(),
  });
}

/** 确保租户数据目录与空文件存在，让首次打开页面不是"什么都没有"。 */
export function ensureTenantFiles(paths: StorePaths): void {
  const dir = paths.tenantDir(DEFAULT_TENANT_ID);
  fs.mkdirSync(dir, { recursive: true });
  const seeds: Array<[string, unknown]> = [
    [paths.providersFile(DEFAULT_TENANT_ID), { providers: [] }],
    [paths.agentsFile(DEFAULT_TENANT_ID), { bindings: {} }],
    [
      paths.settingsFile(DEFAULT_TENANT_ID),
      {
        defaultProviderId: null,
        defaultModel: null,
        gatewayToken: null,
        updatedAt: new Date().toISOString(),
      },
    ],
  ];
  for (const [file, payload] of seeds) {
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(
      file,
      `${JSON.stringify({ schemaVersion: 1, data: payload }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}
