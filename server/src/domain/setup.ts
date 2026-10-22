/**
 * 首次初始化（first-run setup）。
 *
 * 设计目标：不让用户去控制台抄一个随机口令，而是自己在浏览器里设管理员账号。
 * 代价是"服务已启动、账号还没建"这段时间是一扇开着的门，因此需要一次性 token 把门看住：
 * 启动时生成 setup token 并打印到控制台，只有能读到控制台的人（= 部署者本人）才能完成初始化。
 */
export interface SetupState {
  /**
   * 是否已完成初始化。以"管理员账号是否存在"为准（由 identity.json 推导），
   * 这里只额外记录一次性 token 的状态。
   */
  completed: boolean;
  /** sha256(token)，校验用；初始化完成后清空 */
  tokenHash: string | null;
  /** 用于提示"输错了几次"，便于运维判断是否有人在试探 */
  failedAttempts: number;
  createdAt: string | null;
  completedAt: string | null;
}

export interface SetupData {
  setup: SetupState;
}

export const SETUP_TOKEN_PREFIX = 'setup_';
/** 最少 8 位，与 /api/auth/password 的规则保持一致 */
export const MIN_PASSWORD_LENGTH = 8;
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 32;

export function defaultSetupState(): SetupState {
  return {
    completed: false,
    tokenHash: null,
    failedAttempts: 0,
    createdAt: null,
    completedAt: null,
  };
}

/** 用户名规则：字母数字与 . _ -，避免与将来的路由/日志格式冲突。 */
const USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateAdminUsername(username: string): string | null {
  const value = username.trim();
  if (value.length < MIN_USERNAME_LENGTH) {
    return `用户名至少 ${MIN_USERNAME_LENGTH} 个字符`;
  }
  if (value.length > MAX_USERNAME_LENGTH) {
    return `用户名最多 ${MAX_USERNAME_LENGTH} 个字符`;
  }
  if (!USERNAME_PATTERN.test(value)) {
    return '用户名只能包含字母、数字、点、下划线与连字符';
  }
  return null;
}

export function validateAdminPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `口令至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  // 不强制复杂度：这类自托管场景里，长度比"必须含大写+符号"更有效，
  // 且强制复杂度的规则反而会诱导用户写 Password1! 这种可猜的口令。
  return null;
}
