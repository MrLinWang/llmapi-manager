import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { badRequest, forbidden, notFound } from '../http/errors';
import { PERMISSIONS, type Permission } from '../domain/permissions';
import { createApiTokenRecord, toApiTokenView } from '../auth/apiToken';
import { can } from '../auth/policy';

/** 这两项当前没有任何接口使用，给令牌开放只增加风险面，没有收益。 */
const UNGRANTABLE: readonly Permission[] = ['users:manage', 'tenants:manage'];

function parseScopes(raw: unknown, principal: ReturnType<typeof getPrincipal>): Permission[] {
  if (!Array.isArray(raw)) throw badRequest('tokens.scopes.mustBeArray');

  const scopes: Permission[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !PERMISSIONS.includes(item as Permission)) {
      throw badRequest('tokens.scopes.unknown', {
        scope: String(item),
        available: PERMISSIONS.join(', '),
      });
    }
    const permission = item as Permission;

    if (UNGRANTABLE.includes(permission)) {
      throw badRequest('tokens.scopes.ungrantable', { permission });
    }
    // 只收窄、不提权：否则一个只有只读权限的人可以通过创建令牌绕过自己的限制
    if (!can(principal, permission)) {
      throw forbidden('tokens.scopes.cannotGrantSelf', { permission });
    }
    if (!scopes.includes(permission)) scopes.push(permission);
  }

  if (scopes.length === 0) throw badRequest('tokens.scopes.empty');
  return scopes;
}

function parseExpiresAt(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw badRequest('tokens.expiresAt.mustBeString');
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw badRequest('tokens.expiresAt.invalid', { value: raw });
  }
  if (parsed <= Date.now()) throw badRequest('tokens.expiresAt.mustBeFuture');
  return new Date(parsed).toISOString();
}

export function registerApiTokenRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/tokens', access: 'settings:read' },
    async () => ({
      // 列表绝不含 tokenHash 与明文；prefix+tail 够用户认出是哪一个
      tokens: repos.apiTokens.list().map(toApiTokenView),
      /** 前端据此渲染权限多选，避免在前端复刻一份权限清单 */
      availableScopes: PERMISSIONS.filter((item) => !UNGRANTABLE.includes(item)),
    }),
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/tokens', access: 'settings:write' },
    async (request) => {
      const principal = getPrincipal(request);

      // 令牌不能再创建令牌：否则一个即将被吊销的令牌可以先给自己留一个后门。
      // 创建必须由真人会话完成。
      if (principal.via === 'api-token') {
        throw forbidden('tokens.sessionRequired.create');
      }

      const body = (request.body ?? {}) as {
        name?: unknown;
        scopes?: unknown;
        expiresAt?: unknown;
      };

      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') throw badRequest('tokens.name.required');
      if (name.length > 64) throw badRequest('tokens.name.tooLong', { max: 64 });

      const scopes = parseScopes(body.scopes, principal);
      const expiresAt = parseExpiresAt(body.expiresAt);

      const { token, record } = createApiTokenRecord({
        tenantId: repos.tenantId,
        name,
        scopes,
        createdBy: principal.userId,
        expiresAt,
      });
      repos.apiTokens.saveAll([...repos.apiTokens.list(), record]);

      // 明文只在这一次响应里出现，之后任何接口都只能拿到 prefix/tail
      return { token, tokenView: toApiTokenView(record) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'DELETE', url: '/api/tokens/:id', access: 'settings:write' },
    async (request) => {
      const principal = getPrincipal(request);
      if (principal.via === 'api-token') {
        throw forbidden('tokens.sessionRequired.revoke');
      }

      const { id } = request.params as { id: string };
      const record = repos.apiTokens.get(id);
      if (!record) throw notFound('tokens.notFound', { id });
      if (record.revokedAt !== null) {
        // 幂等：重复吊销返回当前状态而不是报错
        return { tokenView: toApiTokenView(record) };
      }

      // 吊销而非删除：保留记录才能解释"某个令牌曾经存在过"，
      // 也避免 id 被复用后与新令牌混淆。
      const revoked = { ...record, revokedAt: new Date().toISOString() };
      repos.apiTokens.saveAll(
        repos.apiTokens.list().map((item) => (item.id === id ? revoked : item)),
      );
      return { tokenView: toApiTokenView(revoked) };
    },
  );
}
