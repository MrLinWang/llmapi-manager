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
  /**
   * 本机的组网身份（EasyTier 的 peer_id 与 Noise 静态私钥）。
   *
   * **必须跨重启保持稳定**：对端按 `noise_static_pubkey` 钉扎本机身份，
   * 重启后换密钥会被当成"另一个节点"。放在这里是因为它是**本机级**数据
   * （与租户无关），和租户体系同一个文件可以省一次落盘路径的维护。
   *
   * 私钥是 `ctx.secrets.encode()` 的密文（`enc:v1:` 前缀），不是明文。
   * 缺失时为 undefined——首次启动会生成并写回（向后兼容旧数据文件）。
   */
  networkingIdentity?: {
    peerId: number;
    /** Noise 静态私钥的密文 */
    staticPrivateKeyEnc: string;
  };
}

export const DEFAULT_TENANT_ID = 't_default';
export const DEFAULT_TENANT_NAME = 'Default';
export const OWNER_USER_ID = 'u_owner';
