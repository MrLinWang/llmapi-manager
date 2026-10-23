import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { AppError, forbidden, unauthorized } from '../http/errors';
import { resolvePrincipalFromSession } from '../auth/principal';
import { resolvePrincipalFromApiToken } from '../auth/apiTokenPrincipal';
import { assertCan } from '../auth/policy';
import type { Permission } from '../domain/permissions';
import type { Principal } from '../domain/identity';
import type { RouteAccess, RouteRegistry } from './routeRegistry';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export function getPrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

export function getOptionalPrincipal(request: FastifyRequest): Principal | undefined {
  return request.principal;
}

export interface RouteOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  access: RouteAccess;
}

export function registerApiGuard(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
): void {
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;

    const routeUrl = request.routeOptions?.url ?? '';
    // 没有匹配到路由（routeUrl 为空）时交给 404 处理器，不要当成漏声明权限
    if (routeUrl === '') return;
    const access = registry.find(request.method, routeUrl);

    if (!access) {
      // 走到这里说明有路由没登记，宁可拒绝也不默认放行
      throw new AppError(
        'internal_error',
        `路由 ${request.method} ${routeUrl} 未在访问登记簿中声明`,
      );
    }
    if (access === 'public') return;

    // 会话优先于令牌：同一请求两者都带时行为必须确定，且会话是"真人正在操作"
    // 的更强信号，不该被一个附带的 Authorization 头改变语义。
    const principal =
      resolvePrincipalFromSession(request, ctx.config.sessionSecret, ctx.identity) ??
      resolvePrincipalFromApiToken(request, ctx.store, ctx.logger);
    if (!principal) throw unauthorized();

    if (access === 'authenticated') {
      // `authenticated` 级接口（改口令、读自己的会话）假设的是"真人会话"。
      // 令牌不该能改口令——那等于凭据泄露后可以永久接管账号，
      // 而吊销令牌反而救不回来（口令已被改）。
      if (principal.via === 'api-token') {
        throw forbidden('该接口需要登录会话，API 令牌不能调用');
      }
    } else {
      assertCan(principal, access as Permission);
    }

    request.principal = principal;
  });
}

/** 包装注册，保证"注册路由"与"登记访问权限"这两件事永远一起发生。 */
export function defineRoute(
  app: FastifyInstance,
  registry: RouteRegistry,
  options: RouteOptions,
  handler: Parameters<FastifyInstance['route']>[0]['handler'],
): void {
  registry.register({ method: options.method, url: options.url, access: options.access });
  app.route({
    method: options.method,
    url: options.url,
    handler,
  });
}
