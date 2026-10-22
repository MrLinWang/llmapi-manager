import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { RequestLogService } from '../services/requestLog';

export function registerLogRoutes(
  app: FastifyInstance,
  _ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  const service = new RequestLogService(repos.requestLog, repos.tenantId);

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/logs', access: 'logs:read' },
    async (request) => {
      const query = request.query as { limit?: string; providerId?: string };
      const parsed = Number.parseInt(query.limit ?? '50', 10);
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
      return { logs: service.recent(limit, query.providerId) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/stats', access: 'logs:read' },
    async () => service.stats(),
  );
}
