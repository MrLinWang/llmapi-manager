import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { ProviderService } from '../services/providers';
import { ALIAS_PREFIX, listAliases } from '../domain/aliases';
import { createGatewayTokenMeta, viewTokenMeta } from '../gateway/token';
import { badRequest } from '../http/errors';
import type { TenantSettings } from '../domain/settings';

export function registerModelRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  const providers = new ProviderService(repos, ctx.secrets);

  const readSettings = (): { settings: TenantSettings; providers: ReturnType<ProviderService['listRecords']> } => ({
    settings: repos.settings.read(),
    providers: providers.listRecords(),
  });

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/models', access: 'providers:read' },
    async () => {
      const { settings, providers: records } = readSettings();
      const aliases = listAliases(records);
      const defaultProvider = records.find((item) => item.id === settings.defaultProviderId);
      return {
        prefix: ALIAS_PREFIX,
        aliases,
        default: {
          providerId: settings.defaultProviderId,
          providerName: defaultProvider?.name ?? null,
          model: settings.defaultModel,
        },
        gateway: {
          baseUrl: `${ctx.config.publicBaseUrl}/v1`,
          token: viewTokenMeta(settings),
        },
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/settings', access: 'settings:read' },
    async () => {
      const { settings } = readSettings();
      return {
        defaultProviderId: settings.defaultProviderId,
        defaultModel: settings.defaultModel,
        gatewayBaseUrl: `${ctx.config.publicBaseUrl}/v1`,
        token: viewTokenMeta(settings),
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/gateway/token', access: 'gateway:write' },
    async (request) => {
      const principal = getPrincipal(request);
      const settings = repos.settings.read();
      const { token, meta } = createGatewayTokenMeta(
        principal.tenantId,
        principal.userId,
        ctx.secrets,
      );
      repos.settings.write({
        ...settings,
        gatewayToken: meta,
        updatedAt: new Date().toISOString(),
      });
      // 明文只在这一次响应里出现，之后只能看到脱敏形式
      return {
        token,
        masked: `${meta.prefix}${'*'.repeat(12)}${meta.tail}`,
        createdAt: meta.createdAt,
        note: '这是唯一一次显示完整令牌，请立即复制并更新已下发的 Agent 配置。',
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'PUT', url: '/api/settings/default', access: 'settings:write' },
    async (request) => {
      const body = (request.body ?? {}) as { providerId?: unknown; model?: unknown };
      const settings = repos.settings.read();
      const providerId = typeof body.providerId === 'string' ? body.providerId : null;
      const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;

      if (providerId === null) {
        repos.settings.write({
          ...settings,
          defaultProviderId: null,
          defaultModel: null,
          updatedAt: new Date().toISOString(),
        });
        return { defaultProviderId: null, defaultModel: null };
      }

      const record = providers.get(providerId);
      if (model && record.models.length > 0 && !record.models.includes(model)) {
        throw badRequest(`模型 ${model} 不在供应商 ${record.name} 的模型列表中`);
      }
      const next: TenantSettings = {
        ...settings,
        defaultProviderId: providerId,
        defaultModel: model ?? record.models[0] ?? null,
        updatedAt: new Date().toISOString(),
      };
      repos.settings.write(next);
      return { defaultProviderId: next.defaultProviderId, defaultModel: next.defaultModel };
    },
  );
}
