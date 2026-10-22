import type { Permission } from '../domain/permissions';

/** public：免鉴权；authenticated：要登录但不需要特定权限；Permission：需该权限。 */
export type RouteAccess = 'public' | 'authenticated' | Permission;

export interface RouteRegistration {
  method: string;
  url: string;
  access: RouteAccess;
}

/**
 * 路由访问声明的登记簿。
 * 所有 /api 路由都必须经由 defineRoute 注册，以便启动自检发现"漏声明权限"的新路由。
 */
export class RouteRegistry {
  private readonly entries: RouteRegistration[] = [];

  register(entry: RouteRegistration): void {
    this.entries.push(entry);
  }

  all(): readonly RouteRegistration[] {
    return this.entries;
  }

  /** 启动自检：任何 /api 路由都不得缺少访问声明。 */
  assertAllDeclared(): void {
    const missing = this.entries.filter(
      (item) => !item.access || item.access === ('' as RouteAccess),
    );
    if (missing.length > 0) {
      const list = missing.map((item) => `${item.method} ${item.url}`).join(', ');
      throw new Error(`以下路由未声明访问权限：${list}`);
    }
  }

  find(method: string, url: string): RouteAccess | undefined {
    const target = this.entries.find(
      (item) => item.method === method.toUpperCase() && item.url === url,
    );
    return target?.access;
  }
}
