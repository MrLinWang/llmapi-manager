import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { ProviderService } from '../services/providers';
import { AgentService } from '../agents/service';

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  const providerService = new ProviderService(repos, ctx.secrets);
  const agentService = new AgentService(ctx, repos, providerService);

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/agents', access: 'agents:read' },
    async () => ({ agents: agentService.list() }),
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/agents/:id/preview', access: 'agents:read' },
    async (request) => {
      const principal = getPrincipal(request);
      const { id } = request.params as { id: string };
      return agentService.preview(principal, id);
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/agents/:id/apply', access: 'agents:apply' },
    async (request) => {
      const principal = getPrincipal(request);
      const { id } = request.params as { id: string };
      return { binding: agentService.apply(principal, id) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/agents/:id/revert', access: 'agents:apply' },
    async (request) => {
      const { id } = request.params as { id: string };
      return agentService.revert(id);
    },
  );
}
