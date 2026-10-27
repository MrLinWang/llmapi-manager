import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import type { IdentityRepo } from '../store/identityRepo';
import type { SetupRepo } from '../store/setupRepo';
import type { StorePaths } from '../store/paths';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_NAME,
  OWNER_USER_ID,
  type User,
} from '../domain/identity';
import {
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  validateAdminPassword,
  validateAdminUsername,
} from '../domain/setup';
import { hashPassword } from '../auth/password';
import { badRequest, conflict, forbidden } from '../http/errors';
import {
  ensureTenantFiles,
  isInitialized,
  verifySetupToken,
} from '../bootstrap';

export interface SetupStatus {
  /** 是否还需要初始化（没有管理员账号） */
  needsSetup: boolean;
  /** 待初始化时，前端用来提示"用户名可以自定义" */
  defaultUsername: string;
  /** 口令与用户名的校验规则，前端据此做即时提示，避免规则两处维护 */
  rules: {
    minUsernameLength: number;
    maxUsernameLength: number;
    minPasswordLength: number;
  };
  /** 连续输错 token 的次数（便于运维发现有人试探） */
  failedAttempts?: number;
}

export interface CompleteSetupInput {
  token: string;
  username: string;
  password: string;
}

export class SetupService {
  constructor(
    private readonly config: AppConfig,
    private readonly paths: StorePaths,
    private readonly identity: IdentityRepo,
    private readonly setup: SetupRepo,
    private readonly logger: Logger,
  ) {}

  status(): SetupStatus {
    const needsSetup = !isInitialized(this.identity);
    const state = this.setup.read();
    return {
      needsSetup,
      defaultUsername: this.config.adminUsername,
      rules: {
        minUsernameLength: MIN_USERNAME_LENGTH,
        maxUsernameLength: MAX_USERNAME_LENGTH,
        minPasswordLength: MIN_PASSWORD_LENGTH,
      },
      ...(needsSetup ? { failedAttempts: state.failedAttempts } : {}),
    };
  }

  /**
   * 完成首次初始化。
   * 安全约束：
   * - 必须持有启动时打印的一次性 token（能读控制台 = 部署者本人）；
   * - 已初始化时直接拒绝，绝不覆盖已有管理员；
   * - token 校验失败计数，便于发现试探，但不在响应里泄露任何预期值。
   */
  async complete(input: CompleteSetupInput): Promise<{ user: User }> {
    const state = this.setup.read();

    if (isInitialized(this.identity)) {
      throw conflict('auth.setup.alreadyCompleted');
    }

    if (!verifySetupToken(input.token, state.tokenHash)) {
      this.setup.write({ ...state, failedAttempts: state.failedAttempts + 1 });
      this.logger.warn('初始化令牌校验失败', {
        failedAttempts: state.failedAttempts + 1,
      });
      // 不回显令牌，也不透露 state 里的任何值：报错本身就是攻击面的探针
      throw forbidden('auth.setup.invalidToken');
    }

    const username = input.username.trim();
    const usernameError = validateAdminUsername(username);
    // 领域层只给"键 + 参数"，这里在边界上交给 AppError 统一按请求语言渲染
    if (usernameError) throw badRequest(usernameError.key, usernameError.params);
    const passwordError = validateAdminPassword(input.password);
    if (passwordError) throw badRequest(passwordError.key, passwordError.params);

    const data = this.identity.read();
    // 双检：读身份的间隙里可能已被另一个请求完成初始化
    if (data.users.some((item) => item.tenantId === DEFAULT_TENANT_ID)) {
      throw conflict('auth.setup.alreadyCompleted');
    }
    if (data.users.some((item) => item.username === username)) {
      throw conflict('auth.setup.usernameTaken', { username });
    }

    const now = new Date().toISOString();
    const tenant = data.tenants.find((item) => item.id === DEFAULT_TENANT_ID);
    if (!tenant) {
      data.tenants.push({
        id: DEFAULT_TENANT_ID,
        name: DEFAULT_TENANT_NAME,
        status: 'active',
        createdAt: now,
      });
    }

    const user: User = {
      id: OWNER_USER_ID,
      tenantId: DEFAULT_TENANT_ID,
      username,
      role: 'owner',
      passwordHash: await hashPassword(input.password),
      authVersion: 1,
      status: 'active',
      createdAt: now,
    };
    data.users.push(user);
    this.identity.write(data);

    // 初始化完成即作废 token：不允许二次认领
    this.setup.write({
      completed: true,
      tokenHash: null,
      failedAttempts: 0,
      createdAt: state.createdAt,
      completedAt: now,
    });
    ensureTenantFiles(this.paths);

    this.logger.info('已完成首次初始化', {
      username: user.username,
      tenantId: user.tenantId,
      role: user.role,
    });
    return { user };
  }
}
