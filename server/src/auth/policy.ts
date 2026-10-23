import { ROLE_PERMISSIONS, type Permission } from '../domain/permissions';
import type { Principal } from '../domain/identity';
import { forbidden } from '../http/errors';

/**
 * 权限判定。
 *
 * 有 `scopes` 时只看 scopes、**完全忽略角色**：令牌是"按需授权"的凭据，
 * 若还叠加角色权限，那么创一个只读令牌反而会拿到创建者的全部权限，
 * 收窄就形同虚设。
 */
export function can(principal: Principal, permission: Permission): boolean {
  if (principal.scopes) return principal.scopes.includes(permission);
  return ROLE_PERMISSIONS[principal.role]?.includes(permission) ?? false;
}

/** 单一裁决入口：所有写操作前必须经过这里，避免权限判断散落各路由。 */
export function assertCan(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) {
    // 令牌场景下不要回显角色：它没有角色语义，说"角色 member 缺少权限"会误导排查方向
    throw forbidden(
      principal.scopes
        ? `该 API 令牌缺少权限 ${permission}`
        : `角色 ${principal.role} 缺少权限 ${permission}`,
    );
  }
}
