import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config';
import type { Logger } from './logger';
import { hashPassword, generatePassword } from './auth/password';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_NAME,
  OWNER_USER_ID,
  type IdentityData,
  type User,
} from './domain/identity';
import type { IdentityRepo } from './store/identityRepo';
import type { StorePaths } from './store/paths';
import { addWarning } from './resilience';

export interface BootstrapResult {
  /** 仅首次创建账号时有值，需在控制台打印一次 */
  initialPassword?: string;
  createdOwner: boolean;
}

/**
 * 幂等初始化：创建默认租户与管理员账号。
 * 用户名取 ADMIN_USERNAME（默认 admin），角色固定为 owner —— 两者是不同概念，别混淆。
 * 已存在时完全不动 —— 尤其不能覆盖用户已改过的口令。
 */
export async function bootstrapIdentity(
  config: AppConfig,
  paths: StorePaths,
  identity: IdentityRepo,
  logger: Logger,
): Promise<BootstrapResult> {
  fs.mkdirSync(paths.tenantDir(DEFAULT_TENANT_ID), { recursive: true });

  const data: IdentityData = identity.read();
  const tenant = data.tenants.find((item) => item.id === DEFAULT_TENANT_ID);
  const owner = data.users.find(
    (item) => item.tenantId === DEFAULT_TENANT_ID && item.username === config.adminUsername,
  );

  if (tenant && owner) {
    ensureTenantFiles(paths);
    return { createdOwner: false };
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

  let initialPassword: string | undefined;
  if (!owner) {
    initialPassword = config.adminPassword ?? generatePassword();
    const user: User = {
      id: DEFAULT_TENANT_ID === 't_default' ? OWNER_USER_ID : randomUUID(),
      tenantId: DEFAULT_TENANT_ID,
      username: config.adminUsername,
      role: 'owner',
      passwordHash: await hashPassword(initialPassword),
      authVersion: 1,
      status: 'active',
      createdAt: now,
    };
    data.users.push(user);
    logger.info('已创建初始管理员账号', {
      username: user.username,
      tenantId: user.tenantId,
      role: user.role,
    });
    if (!config.adminPassword) {
      addWarning(
        'initial_password_printed',
        '初始管理员口令为随机生成，只在首次启动时打印；如已遗失请在 data 目录删除 identity.json 后重启（会清空账号）。',
      );
    }
  }

  identity.write(data);
  ensureTenantFiles(paths);
  return { initialPassword, createdOwner: !owner };
}

/** 确保租户数据目录与空文件存在，让首次打开页面不是"什么都没有"。 */
function ensureTenantFiles(paths: StorePaths): void {
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
