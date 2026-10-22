import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { resolveGatewayPrincipal } from '../gateway/auth';
import { ProviderService } from '../services/providers';
import { listAliases, resolveModel } from '../domain/aliases';
import { badRequest, unauthorized } from '../http/errors';
import {
  GATEWAY_PATHS as GATEWAY_PATHS_ALL,
  assertApiTypeMatch,
  forwardOnce,
  requiredApiType,
  writeDeferredError,
  type ForwardOutcome,
  type GatewayPath,
} from '../gateway/forward';
import { RequestLogService } from '../services/requestLog';
import type { ProviderRecord } from '../domain/provider';
import type { Principal } from '../domain/identity';
import type { TenantSettings } from '../domain/settings';

// 只在这里展开一份拷贝供注册路由使用，来源必须是 gateway/forward.ts 的清单：
// 本地再硬编码一份路径+协议的副本，加 /v1/responses 时就出现了"路由已注册、
// 协议要求没跟上"的直通漏洞。
const GATEWAY_PATHS: GatewayPath[] = [...GATEWAY_PATHS_ALL];

interface Candidate {
  provider: ProviderRecord;
  upstreamModel: string;
  modelRewritten: boolean;
}

type Selection =
  | { mode: 'alias' | 'default'; primary: Candidate; fallbacks: Candidate[] }
  | { mode: 'invalid'; reason: string };

function selectCandidates(
  requested: string,
  providers: ProviderRecord[],
  settings: TenantSettings,
  path: GatewayPath,
): Selection {
  const resolution = resolveModel(requested, providers);
  if (resolution.kind === 'invalid') return { mode: 'invalid', reason: resolution.reason };

  if (resolution.kind === 'alias') {
    const provider = providers.find((item) => item.id === resolution.alias.providerId);
    if (!provider) return { mode: 'invalid', reason: '别名指向的供应商已不存在' };
    return {
      mode: 'alias',
      primary: {
        provider,
        upstreamModel: resolution.alias.upstreamModel,
        modelRewritten: true,
      },
      // 别名是明确指向，不做故障转移
      fallbacks: [],
    };
  }

  // 候选池在选路阶段就按协议过滤，而不是等到发送前才拦：
  // 否则回退列表里会混进别的协议，主供应商失败后换一家必然 501，白白多打一次上游。
  const required = requiredApiType(path);
  const usable = providers
    .filter((item) => item.enabled && (required === null || item.apiType === required))
    .sort((a, b) => a.priority - b.priority);

  if (usable.length === 0) {
    return {
      mode: 'invalid',
      reason: required
        ? `没有启用的 ${required} 供应商，请先在控制台添加并启用`
        : '没有启用的供应商，请先在控制台添加并启用',
    };
  }

  const defaultProvider = usable.find((item) => item.id === settings.defaultProviderId);
  const primaryProvider = defaultProvider ?? usable[0];
  const useDefaultModel =
    defaultProvider !== undefined && Boolean(settings.defaultModel);

  return {
    mode: 'default',
    primary: {
      provider: primaryProvider,
      upstreamModel: useDefaultModel ? (settings.defaultModel as string) : resolution.upstreamModel,
      modelRewritten: useDefaultModel,
    },
    fallbacks: [
      ...usable.filter((item) => item.id !== primaryProvider.id),
      ...usable.filter(
        (item) =>
          item.id === primaryProvider.id &&
          item.baseUrl !== primaryProvider.baseUrl,
      ),
    ].map((item) => ({
      provider: item,
      upstreamModel: resolution.upstreamModel,
      modelRewritten: false,
    })),
  };
}

export function registerGatewayRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  providerService: ProviderService,
): void {
  const authGateway = (request: FastifyRequest): Principal => {
    const principal = resolveGatewayPrincipal(request, ctx);
    if (!principal) throw unauthorized('网关令牌缺失或无效');
    return principal;
  };

  app.get('/v1/models', async (request) => {
    const principal = authGateway(request);
    const repos = ctx.store.forTenant(principal.tenantId);
    const records = new ProviderService(repos, ctx.secrets).listRecords();
    const settings = repos.settings.read();
    const aliases = listAliases(records).map((alias) => ({
      id: alias.alias,
      object: 'model',
      owned_by: alias.providerName,
      created: 0,
    }));
    const defaultProvider = records.find((item) => item.id === settings.defaultProviderId);
    if (defaultProvider && settings.defaultModel) {
      aliases.push({
        id: settings.defaultModel,
        object: 'model',
        owned_by: defaultProvider.name,
        created: 0,
      });
    }
    return { object: 'list', data: aliases };
  });

  const makeHandler = (path: GatewayPath) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const principal = authGateway(request);
      const repos = ctx.store.forTenant(principal.tenantId);
      const logService = new RequestLogService(repos.requestLog, repos.tenantId);
      const settings = repos.settings.read();
      const records = new ProviderService(repos, ctx.secrets).listRecords();

      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.model !== 'string' || body.model.trim() === '') {
        throw badRequest('请求体必须包含 model 字段');
      }
      const requestedModel = body.model;
      const stream = body.stream === true;
      const startedAt = Date.now();

      const selection = selectCandidates(requestedModel, records, settings, path);
      if (selection.mode === 'invalid') {
        logService.append(
          {
            path: `/v1${path}`,
            requestedModel,
            upstreamModel: requestedModel,
            providerId: null,
            providerName: null,
            mode: 'invalid',
            stream,
            status: 400,
            latencyMs: Date.now() - startedAt,
            fallback: false,
            error: selection.reason,
          },
          (error) => ctx.logger.warn('写入请求日志失败', error),
        );
        throw badRequest(selection.reason);
      }

      // 兜底再校验一次：别名模式是直接按 providerId 取供应商，不走上面的协议过滤，
      // 所以必须在发请求前拒绝，否则 Responses 请求会被发到 Chat 上游。
      assertApiTypeMatch(selection.primary.provider, path);

      const attempt = async (
        candidate: Candidate,
        fallback: boolean,
        deferError: boolean,
      ): Promise<ForwardOutcome> =>
        forwardOnce({
          target: {
            provider: candidate.provider,
            apiKey: providerService.plainApiKey(candidate.provider),
            upstreamModel: candidate.upstreamModel,
            modelRewritten: candidate.modelRewritten,
          },
          path,
          body,
          incomingHeaders: request.headers as Record<string, string | string[] | undefined>,
          reply: reply.raw,
          tenantId: principal.tenantId,
          requestedModel,
          mode: selection.mode,
          fallback,
          deferErrorWrite: deferError,
          loggerWarn: (message, meta) => ctx.logger.warn(message, meta),
          onLog: (record) =>
            logService.append(record, (error) =>
              ctx.logger.warn('写入请求日志失败', error),
            ),
        });

      // 还有备选可试时先不写错误响应，避免回退前就把错误发给客户端
      const mayFallback = selection.fallbacks.length > 0;
      const primaryResult = await attempt(selection.primary, false, mayFallback);

      // 非 5xx 不换供应商：4xx 是请求本身的问题（模型名、参数、额度），
      // 换一家大概率同样失败，还会掩盖真实原因。
      if (!mayFallback || primaryResult.status < 500) {
        // 主供应商那次是延迟写模式，错误尚未发给客户端，这里必须补写；
        // 否则客户端会收到 200 + 空 body（曾被真实 bug 踩过）。
        writeDeferredError(reply.raw, primaryResult);
        return;
      }

      if (reply.raw.headersSent) return;

      const fallbackCandidate = selection.fallbacks[0];
      ctx.logger.warn('主供应商失败，尝试回退', {
        primary: selection.primary.provider.name,
        fallback: fallbackCandidate.provider.name,
        status: primaryResult.status,
      });
      // 只回退一次：骨架期的策略是"换一家试一下"，不追求多层重试。
      // 这次不再延迟写：回退失败就直接把错误发给客户端。
      await attempt(fallbackCandidate, true, false);
    };

  for (const path of GATEWAY_PATHS) {
    app.post(`/v1${path}`, makeHandler(path));
  }
}
