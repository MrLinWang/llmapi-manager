import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { listAliases } from '../domain/aliases';
import { AGENT_DEFINITIONS } from '../agents/registry';
import { RequestLogService } from '../services/requestLog';
import { ProviderService } from '../services/providers';

/**
 * 面向程序化调用的补充接口。
 *
 * 与 `/api/health` 的分工：health 是探活（含启动告警），本文件是"把散落在多个
 * 接口的信息一次取全"，避免脚本为了拿一个总览发七八个请求。
 */
export function registerApiInfoRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  const startedAt = Date.now();

  defineRoute(
    app,
    registry,
    // public：程序需要在登录前就确认"这是不是我要连的那个实例、版本对不对"。
    // 因此这里**不能**返回任何环境细节（数据目录、内部地址、凭据）。
    { method: 'GET', url: '/api/info', access: 'public' },
    async () => ({
      name: 'llmapi-manager',
      version: readVersion(),
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      gatewayBaseUrl: `${ctx.config.publicBaseUrl}/v1`,
      // 这里刻意不含 dataDir：那是本机绝对路径，属于部署细节
    }),
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/overview', access: 'providers:read' },
    async () => {
      const providerService = new ProviderService(repos, ctx.secrets);
      const records = providerService.listRecords();
      const aliases = listAliases(records);
      const settings = repos.settings.read();

      return {
        providers: {
          total: records.length,
          enabled: records.filter((item) => item.enabled).length,
          // 按协议分布：排查"为什么 Codex 没有可用模型"时最直接的信息
          byApiType: {
            openai: records.filter((item) => item.apiType === 'openai').length,
            anthropic: records.filter((item) => item.apiType === 'anthropic').length,
            responses: records.filter((item) => item.apiType === 'responses').length,
          },
        },
        aliases: { total: aliases.length },
        settings: {
          defaultProviderId: settings.defaultProviderId,
          defaultModel: settings.defaultModel,
          protocolConversion: settings.protocolConversion,
          approvalReviewModel: settings.approvalReviewModel,
          disableCodexWebSearch: settings.disableCodexWebSearch,
          codexStreamMaxRetries: settings.codexStreamMaxRetries,
          codexStreamIdleTimeoutMs: settings.codexStreamIdleTimeoutMs,
          agentTargets: settings.agentTargets,
        },
        agents: Object.keys(AGENT_DEFINITIONS).map((id) => {
          const binding = repos.agents.getBinding(id as keyof typeof AGENT_DEFINITIONS);
          return {
            id,
            applied: binding !== undefined,
            appliedAt: binding?.appliedAt ?? null,
            runningProcesses: binding?.runningProcesses ?? 0,
          };
        }),
        todayStats: new RequestLogService(repos.requestLog, repos.tenantId).stats(),
      };
    },
  );
}

/** 版本号从 `server/package.json` 读，避免手写常量与包版本漂移。 */
function readVersion(): string {
  try {
    const { createRequire } = require('node:module') as typeof import('node:module');
    const pkg = createRequire(__filename)('../../package.json') as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
