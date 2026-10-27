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
import { normalizeBaseUrl } from '../services/providers';
import { fetchProviderModels, testProviderConnectivity } from '../services/connectivity';
import { badRequest } from '../http/errors';
import { API_TYPES, type ApiType } from '../domain/provider';

function asProviderInput(body: unknown): ProviderInput {
  const raw = (body ?? {}) as Partial<ProviderInput>;
  if (typeof raw.name !== 'string') throw badRequest('name 必须是字符串');
  // 用 API_TYPES 而不是逐个字面量比较：加 responses 时这里曾漏改，
  // 表现为前端能选新协议、提交却被自己的路由校验挡回。
  if (!API_TYPES.includes(raw.apiType as ApiType)) {
    throw badRequest(`apiType 只能是 ${API_TYPES.join(' / ')}`);
  }
  if (typeof raw.baseUrl !== 'string') throw badRequest('baseUrl 必须是字符串');
  if (raw.models !== undefined && !Array.isArray(raw.models)) {
    throw badRequest('models 必须是字符串数组');
  }
  if (raw.models && raw.models.some((item) => typeof item !== 'string')) {
    throw badRequest('models 只能包含字符串');
  }
  // 能力表只做形状校验，取值合法性（正整数、模型仍在列表里）交给
  // ProviderService.normalizeCapabilities —— 一条规则一处实现，避免两套标准。
  if (
    raw.modelCapabilities !== undefined &&
    (typeof raw.modelCapabilities !== 'object' || raw.modelCapabilities === null)
  ) {
    throw badRequest('modelCapabilities 必须是对象');
  }
  return {
    name: raw.name,
    apiType: raw.apiType as ApiType,
    baseUrl: raw.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    models: raw.models as string[] | undefined,
    modelCapabilities: raw.modelCapabilities as ProviderInput['modelCapabilities'],
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

  /**
   * 按表单里填的临时值拉取上游模型列表。
   *
   * 为什么不复用 /api/providers/:id/test：新增供应商时还没有 id、也还没落盘，
   * 而"先试连再保存"正是这个功能的用途。编辑时若 apiKey 留空，允许传
   * providerId 借用已保存的 Key —— 前端不回显明文，用户也不该为了拉列表重填一次。
   */
  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/providers/models', access: 'providers:write' },
    async (request) => {
      const body = (request.body ?? {}) as {
        apiType?: unknown;
        baseUrl?: unknown;
        apiKey?: unknown;
        providerId?: unknown;
      };
      if (!API_TYPES.includes(body.apiType as ApiType)) {
        throw badRequest(`apiType 只能是 ${API_TYPES.join(' / ')}`);
      }
      if (typeof body.baseUrl !== 'string' || body.baseUrl.trim() === '') {
        throw badRequest('baseUrl 不能为空');
      }

      let apiKey =
        typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (apiKey === '') {
        // 编辑态：借用已保存的 Key，避免前端为了拉列表再要求用户重填
        if (typeof body.providerId === 'string' && body.providerId !== '') {
          const record = service.get(body.providerId);
          apiKey = service.plainApiKey(record);
        }
        if (apiKey === '') {
          throw badRequest('尚未填写 API Key，且没有可沿用的已保存 Key');
        }
      }

      // 这条路由接受"表单里的临时 baseUrl"，且可能在 apiKey 为空时借用已保存的 Key。
      // 不校验 scheme 的话，持有 providers:write 的人可以把已存 Key 以 Bearer 发往
      // 任意地址（含内网、file: 等）。normalizeBaseUrl 只放行 http/https，
      // 与保存供应商时同一套规则，避免两处标准不一致。
      return fetchProviderModels({
        apiType: body.apiType as ApiType,
        baseUrl: normalizeBaseUrl(body.baseUrl),
        apiKey,
      });
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
