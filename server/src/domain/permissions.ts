import type { Role } from './identity';

export const PERMISSIONS = [
  'providers:read',
  'providers:write',
  'gateway:read',
  'gateway:write',
  'agents:read',
  'agents:apply',
  'logs:read',
  'settings:read',
  'settings:write',
  /**
   * 同步快照的读写。
   *
   * 刻意与 settings:* 分开：`sync:read` 能把**全部上游 API Key 明文**导出去，
   * 是这套权限里最敏感的一项。分开才能"授予某人改设置、但不许他导出凭据"。
   * 默认不给任何角色——需要显式创建含该 scope 的 API 令牌。
   */
  'sync:read',
  'sync:write',
  'users:manage',
  'tenants:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * 角色 → 权限。集中在一处，方便将来做角色自定义与审计。
 * member 只有网关消费能力，不允许访问管理接口。
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    'providers:read',
    'providers:write',
    'gateway:read',
    'agents:read',
    'agents:apply',
    'logs:read',
    'settings:read',
    'settings:write',
    // admin **有** sync:write（拉取与仲裁），但**没有** sync:read。
    //
    // 这个不对称是刻意的：sync:write 只是"把 master 的配置拉到本地"，
    // 风险与改设置同级；而 sync:read 能把全部上游 API Key 明文导出去，
    // 那是另一回事，必须由 owner 显式授予。
    'sync:write',
  ],
  member: ['gateway:read'],
};
