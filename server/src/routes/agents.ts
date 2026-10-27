import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { ProviderService } from '../services/providers';
import { AgentService } from '../agents/service';
import { translate } from '../i18n';
import { resolveRequestLanguage } from '../i18n/language';

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
    async (request) => {
      // 描述是静态数据里的**文案键**（registry 构造时没有请求语言），
      // 在这里按请求语言渲染。响应字段名保持 `description`：前端一直在用它，
      // 改名的收益只是"服务端更自洽"，代价是让所有调用方跟着改。
      const language = resolveRequestLanguage(request, ctx);
      return {
        // 逐字段列出而不是展开后覆盖：保持字段顺序与改造前一致
        // （id / name / description / applied…），接口 diff 里就只剩内容变化。
        agents: agentService.list().map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: translate(language, agent.descriptionKey),
          applied: agent.applied,
          appliedAt: agent.appliedAt,
          appliedBy: agent.appliedBy,
        })),
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/agents/:id/preview', access: 'agents:read' },
    async (request) => {
      const principal = getPrincipal(request);
      const { id } = request.params as { id: string };
      return agentService.preview(principal, id, resolveRequestLanguage(request, ctx));
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/agents/:id/apply', access: 'agents:apply' },
    async (request) => {
      const principal = getPrincipal(request);
      const { id } = request.params as { id: string };
      return {
        binding: agentService.apply(principal, id, resolveRequestLanguage(request, ctx)),
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/agents/:id/revert', access: 'agents:apply' },
    async (request) => {
      const { id } = request.params as { id: string };
      return agentService.revert(id, resolveRequestLanguage(request, ctx));
    },
  );

  // 结束本机正在运行的 Agent 进程。Codex 只在启动时读配置与模型目录，
  // 改完配置不重启会让用户以为没生效——这个接口把"重启"这一步变成一次点击。
  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/agents/:id/stop-processes', access: 'agents:apply' },
    async (request) => {
      const principal = getPrincipal(request);
      const { id } = request.params as { id: string };
      return agentService.stopProcesses(principal, id, resolveRequestLanguage(request, ctx));
    },
  );
}
