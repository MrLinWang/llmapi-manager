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
  ],
  member: ['gateway:read'],
};
