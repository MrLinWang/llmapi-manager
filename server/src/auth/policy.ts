import { ROLE_PERMISSIONS, type Permission } from '../domain/permissions';
import type { Principal } from '../domain/identity';
import { forbidden } from '../http/errors';

export function can(principal: Principal, permission: Permission): boolean {
  return ROLE_PERMISSIONS[principal.role]?.includes(permission) ?? false;
}

/** 单一裁决入口：所有写操作前必须经过这里，避免权限判断散落各路由。 */
export function assertCan(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) {
    throw forbidden(`角色 ${principal.role} 缺少权限 ${permission}`);
  }
}
