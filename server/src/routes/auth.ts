import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { verifyPassword, hashPassword } from '../auth/password';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  issueSession,
} from '../auth/session';
import { badRequest, unauthorized } from '../http/errors';
import { PERMISSIONS } from '../domain/permissions';
import { ROLE_PERMISSIONS } from '../domain/permissions';
import { SetupService } from '../services/setup';

interface LoginBody {
  username?: string;
  password?: string;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
): void {
  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/auth/login', access: 'public' },
    async (request, reply) => {
      const body = (request.body ?? {}) as LoginBody;
      const username = body.username?.trim();
      const password = body.password ?? '';
      if (!username || !password) throw badRequest('用户名与口令不能为空');

      const identity = ctx.identity.read();
      const user = identity.users.find(
        (item) => item.username.toLowerCase() === username.toLowerCase(),
      );
      // 统一的失败信息，不区分"用户不存在"与"口令错误"
      if (!user || user.status !== 'active') {
        await new Promise((resolve) => setTimeout(resolve, 120));
        throw unauthorized('用户名或口令不正确');
      }
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        throw unauthorized('用户名或口令不正确');
      }
      const tenant = identity.tenants.find((item) => item.id === user.tenantId);
      if (!tenant || tenant.status !== 'active') throw unauthorized('租户已被停用');

      const { token } = issueSession(ctx.config.sessionSecret, {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
        authVersion: user.authVersion,
      });
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
        secure: ctx.config.publicBaseUrl.startsWith('https://'),
      });
      return {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          tenantId: user.tenantId,
        },
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/auth/logout', access: 'public' },
    async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/auth/me', access: 'authenticated' },
    async (request) => {
      const principal = getPrincipal(request);
      const user = ctx.identity
        .read()
        .users.find((item) => item.id === principal.userId);
      return {
        user: {
          id: principal.userId,
          tenantId: principal.tenantId,
          role: principal.role,
          username: user?.username ?? '',
        },
        permissions: ROLE_PERMISSIONS[principal.role],
        allPermissions: PERMISSIONS,
        // 界面语言随身份一起返回，前端不用额外发一次请求。
        // 放这里而不是只在 /api/settings：member 角色没有 settings:read，
        // 但同样要看到正确语言的界面。
        language: ctx.store.forTenant(principal.tenantId).settings.read().language,
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/auth/password', access: 'authenticated' },
    async (request) => {
      const principal = getPrincipal(request);
      const body = (request.body ?? {}) as { oldPassword?: string; newPassword?: string };
      if (!body.oldPassword || !body.newPassword) {
        throw badRequest('旧口令与新口令都必须填写');
      }
      if (body.newPassword.length < 8) throw badRequest('新口令至少 8 位');

      const identity = ctx.identity.read();
      const user = identity.users.find((item) => item.id === principal.userId);
      if (!user) throw unauthorized();
      const ok = await verifyPassword(body.oldPassword, user.passwordHash);
      if (!ok) throw badRequest('旧口令不正确');

      user.passwordHash = await hashPassword(body.newPassword);
      // authVersion 递增让所有既有会话立即失效（含当前这条）
      user.authVersion += 1;
      ctx.identity.write(identity);
      return { ok: true, message: '口令已更新，请重新登录' };
    },
  );

  /**
   * 首次初始化的两个接口都是 public：
   * 此时还没有任何账号，无法用会话鉴权；真正的门禁是启动时打印的一次性 setup token。
   */
  const setupService = new SetupService(
    ctx.config,
    ctx.paths,
    ctx.identity,
    ctx.setup,
    ctx.logger,
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/setup/status', access: 'public' },
    async () => setupService.status(),
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/setup', access: 'public' },
    async (request, reply) => {
      const body = (request.body ?? {}) as {
        token?: unknown;
        username?: unknown;
        password?: unknown;
      };
      if (typeof body.token !== 'string' || body.token.trim() === '') {
        throw badRequest('初始化令牌不能为空');
      }
      if (typeof body.username !== 'string') throw badRequest('用户名必须是字符串');
      if (typeof body.password !== 'string') throw badRequest('口令必须是字符串');

      const { user } = await setupService.complete({
        token: body.token.trim(),
        username: body.username,
        password: body.password,
      });
      reply.code(201);
      return {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          tenantId: user.tenantId,
        },
      };
    },
  );
}
