import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import { resolveGatewayPrincipal } from '../gateway/auth';
import { ProviderService } from '../services/providers';
import { listAliases } from '../domain/aliases';
import { badRequest, unauthorized } from '../http/errors';
import {
  GATEWAY_PATHS as GATEWAY_PATHS_ALL,
  assertApiTypeMatch,
  forwardOnce,
  writeDeferredError,
  type ForwardOutcome,
  type GatewayPath,
} from '../gateway/forward';
import { RequestLogService } from '../services/requestLog';
import type { Principal } from '../domain/identity';
import {
  isApprovalReviewRequest,
  selectCandidates,
  wouldAutoEnableConversion,
  type Candidate,
} from '../gateway/selection';

// 只在这里展开一份拷贝供注册路由使用，来源必须是 gateway/forward.ts 的清单：
// 本地再硬编码一份路径+协议的副本，加 /v1/responses 时就出现了"路由已注册、
// 协议要求没跟上"的直通漏洞。
const GATEWAY_PATHS: GatewayPath[] = [...GATEWAY_PATHS_ALL];

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
      let settings = repos.settings.read();
      const records = providerService.listRecords();

      // 协议不匹配时自动开启跨协议转发。
      //
      // 触发条件必须这么窄——四个条件同时成立才算"确实靠转换能解决"：
      // - 路径要求 responses（Codex 的场景，只有它需要转换）
      // - 开关原本关着（已经开着就没什么可开的）
      // - 没有任何启用的 responses 供应商（有的话直接用，不该悄悄改变全局行为）
      // - 确实有启用的 openai 供应商（否则开了也没有可用候选）
      // 放宽任何一条都会误导用户：比如 /v1/messages 命中 openai 时打开开关毫无作用，
      // 用户却会以为"已经处理好了"。
      //
      // 会自动写设置，所以要在响应头里标记出来，让调用方能发现行为被改变了。
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (typeof body.model !== 'string' || body.model.trim() === '') {
        throw badRequest('请求体必须包含 model 字段');
      }
      const requestedModel = body.model;
      const stream = body.stream === true;
      const startedAt = Date.now();

      // 自动开启跨协议转发。
      //
      // 放在这里而不是更早，是因为更早的位置（body 校验之前）会让一个缺 `model`
      // 的畸形请求——哪怕来自扫描器——也永久改掉租户的设置，而那个请求本身还是 400、
      // 走的是错误处理器而非 reply.raw，用户看不到 x-llmapi-auto-conversion 头，
      // 等于悄悄改了全局行为却毫无提示。
      //
      // 触发条件刻意收窄（见下方注释），只有"打开真的能解决问题"才开。
      const autoEnabledConversion = wouldAutoEnableConversion(records, settings, path);
      if (autoEnabledConversion) {
        // 写前重读：上面读 settings 到这里的区间内，用户可能在页面上改了别的开关
        // （例如 web_search）。直接写回旧快照会把这些改动覆盖掉——只改这一个字段。
        const latest = repos.settings.read();
        settings = {
          ...latest,
          protocolConversion: true,
          updatedAt: new Date().toISOString(),
        };
        repos.settings.write(settings);
        ctx.logger.info(
          `已自动开启跨协议转发：${path} 需要 responses 上游，但当前只有 openai 供应商`,
        );
        // 让客户端能看出"这次请求被转换了，且设置被改动"。
        // 必须设在 raw 上：转发是直接写 reply.raw 的，Fastify 层的 header 不会发出去。
        reply.raw.setHeader('x-llmapi-auto-conversion', '1');
      }

      let selection = selectCandidates(
        requestedModel,
        records,
        settings,
        path,
        isApprovalReviewRequest(request.headers),
      );
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
      // 第三个参数传的是用户开关而不是 candidate 的转换标记：这里判断的是"这种组合
      // 是否允许"，转换与否由每个候选自己的 convertResponsesToChat 决定。
      assertApiTypeMatch(selection.primary.provider, path, settings.protocolConversion);

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
            convertResponsesToChat: candidate.convertResponsesToChat,
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
      // 只回退一次：策略是"换一家试一下"，不追求多层重试。
      // 这次不再延迟写：回退失败就直接把错误发给客户端。
      await attempt(fallbackCandidate, true, false);
    };

  for (const path of GATEWAY_PATHS) {
    app.post(`/v1${path}`, makeHandler(path));
  }
}
