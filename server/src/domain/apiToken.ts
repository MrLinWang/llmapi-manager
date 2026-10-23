import type { Permission } from './permissions';

/**
 * 程序化访问用的 API 令牌。
 *
 * 与网关令牌（`lam_`，给 Codex/Claude Code 调 `/v1/*`）是**两套东西**，不要合并：
 * 网关令牌只能转发推理请求，API 令牌用来调 `/api/*` 管理面。前缀分开正是为了
 * 在日志与用户心智里都能一眼区分——混用会让"这个令牌能干什么"变得说不清。
 */
export interface ApiTokenRecord {
  id: string;
  tenantId: string;
  /** 用户可读的用途说明，例如「CI 部署脚本」。列表里靠它区分多个令牌 */
  name: string;
  /**
   * 校验用，只存 sha256。
   *
   * 不能存明文：数据文件虽然是 0600，但备份、误提交、读日志都可能把文件带出去。
   * 令牌本身是凭据，存储策略与上游 API Key 同级。
   */
  tokenHash: string;
  /** 展示用前缀（含 `api_`），便于用户在列表里认出是哪个令牌 */
  prefix: string;
  /** 展示用后 4 位，配合 prefix 足够区分 */
  tail: string;
  /**
   * 权限子集。**只收窄、不提权**：创建时要求是创建者权限的子集。
   * 空数组视为不可用（拒绝认证），避免"创建了但什么都不能干"的困惑令牌。
   */
  scopes: Permission[];
  createdBy: string;
  createdAt: string;
  /** 上次使用时间；按需节流更新，见 auth/apiToken.ts */
  lastUsedAt: string | null;
  /** null 表示不过期。有条件时建议设，泄露窗口可控 */
  expiresAt: string | null;
  /** 吊销而非物理删除：保留记录才能解释"某个令牌曾经存在过" */
  revokedAt: string | null;
}

/** 对外视图：绝不包含 tokenHash */
export interface ApiTokenView {
  id: string;
  name: string;
  prefix: string;
  tail: string;
  scopes: Permission[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}
