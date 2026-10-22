import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import {
  ProviderService,
  assertNameAvailable,
  type ProviderInput,
} from '../services/providers';
import { testProviderConnectivity } from '../services/connectivity';
import { badRequest } from '../http/errors';
import type { ApiType } from '../domain/provider';

function asProviderInput(body: unknown): ProviderInput {
  const raw = (body ?? {}) as Partial<ProviderInput>;
  if (typeof raw.name !== 'string') throw badRequest('name 必须是字符串');
  if (raw.apiType !== 'openai' && raw.apiType !== 'anthropic') {
    throw badRequest('apiType 只能是 openai 或 anthropic');
  }
  if (typeof raw.baseUrl !== 'string') throw badRequest('baseUrl 必须是字符串');
  if (raw.models !== undefined && !Array.isArray(raw.models)) {
    throw badRequest('models 必须是字符串数组');
  }
  if (raw.models && raw.models.some((item) => typeof item !== 'string')) {
    throw badRequest('models 只能包含字符串');
  }
  return {
    name: raw.name,
    apiType: raw.apiType as ApiType,
    baseUrl: raw.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    models: raw.models as string[] | undefined,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    priority: typeof raw.priority === 'number' ? raw.priority : undefined,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    websiteUrl: typeof raw.websiteUrl === 'string' ? raw.websiteUrl : undefined,
  };
}

export function registerProviderRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  const service = new ProviderService(repos, ctx.secrets);

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/providers', access: 'providers:read' },
    async () => ({ providers: service.list() }),
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/providers', access: 'providers:write' },
    async (request, reply) => {
      const principal = getPrincipal(request);
      const input = asProviderInput(request.body);
      assertNameAvailable(repos.providers.list(), input.name);
      const provider = service.create(input, principal.userId);
      reply.code(201);
      return { provider };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'PUT', url: '/api/providers/order', access: 'providers:write' },
    async (request) => {
      const body = (request.body ?? {}) as { ids?: unknown };
      if (!Array.isArray(body.ids) || body.ids.some((item) => typeof item !== 'string')) {
        throw badRequest('ids 必须是字符串数组');
      }
      return { providers: service.reorder(body.ids as string[]) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'PUT', url: '/api/providers/:id', access: 'providers:write' },
    async (request) => {
      const { id } = request.params as { id: string };
      const input = asProviderInput(request.body);
      assertNameAvailable(repos.providers.list(), input.name, id);
      return { provider: service.update(id, input) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'PATCH', url: '/api/providers/:id/enabled', access: 'providers:write' },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') throw badRequest('enabled 必须是布尔值');
      return { provider: service.setEnabled(id, body.enabled) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'DELETE', url: '/api/providers/:id', access: 'providers:write' },
    async (request) => {
      const { id } = request.params as { id: string };
      return service.remove(id);
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/providers/:id/test', access: 'providers:write' },
    async (request) => {
      const { id } = request.params as { id: string };
      const record = service.get(id);
      const apiKey = service.plainApiKey(record);
      const result = await testProviderConnectivity(record, apiKey);
      service.recordTest(id, {
        at: new Date().toISOString(),
        ok: result.ok,
        latencyMs: result.latencyMs,
        status: result.status,
        models: result.models,
        error: result.error,
      });
      return result;
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/providers/:id/default', access: 'providers:write' },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { model?: string };
      const settings = service.setDefault(id, body.model);
      return {
        defaultProviderId: settings.defaultProviderId,
        defaultModel: settings.defaultModel,
      };
    },
  );
}
