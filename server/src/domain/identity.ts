export type Role = 'owner' | 'admin' | 'member';

export interface Tenant {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  username: string;
  role: Role;
  passwordHash: string;
  /** 口令变更时递增，用于让旧会话失效 */
  authVersion: number;
  status: 'active' | 'disabled';
  createdAt: string;
}

/** 一次请求的身份载体。会话与网关令牌都解析成它。 */
export interface Principal {
  userId: string;
  tenantId: string;
  role: Role;
  /** 认证方式，便于日志与审计 */
  via: 'session' | 'gateway-token' | 'api-token';
  /**
   * 令牌认证时的权限子集。
   *
   * 有值时**按它判定、不再走角色映射**——这正是"令牌只能收窄权限"的实现方式。
   * session 认证时为 undefined（走角色）。
   */
  scopes?: readonly import('./permissions').Permission[];
}

export interface IdentityData {
  tenants: Tenant[];
  users: User[];
}

export const DEFAULT_TENANT_ID = 't_default';
export const DEFAULT_TENANT_NAME = 'Default';
export const OWNER_USER_ID = 'u_owner';
