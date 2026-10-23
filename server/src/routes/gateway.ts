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
import { APPROVAL_REVIEW_MODEL_NAME, type TenantSettings } from '../domain/settings';

// 只在这里展开一份拷贝供注册路由使用，来源必须是 gateway/forward.ts 的清单：
// 本地再硬编码一份路径+协议的副本，加 /v1/responses 时就出现了"路由已注册、
// 协议要求没跟上"的直通漏洞。
const GATEWAY_PATHS: GatewayPath[] = [...GATEWAY_PATHS_ALL];

interface Candidate {
  provider: ProviderRecord;
  upstreamModel: string;
  modelRewritten: boolean;
  /**
   * 需要把 Responses 请求转成 Chat 发给上游。
   * 只在 protocolConversion 打开、且路径要求 responses 而上游是 openai 时出现。
   */
  convertResponsesToChat: boolean;
}

/**
 * 该候选是否需要做 Responses → Chat 转换。
 *
 * 三个条件缺一不可：开关打开、路径要 responses、供应商是 openai。
 * 少写任何一条都会让"没开开关也转换"或"没有转换器也放行"，前者是静默改变用户语义，
 * 后者是把非法请求交给上游。
 */
function needsConversion(
  provider: ProviderRecord,
  path: GatewayPath,
  settings: TenantSettings,
): boolean {
  return (
    settings.protocolConversion &&
    requiredApiType(path) === 'responses' &&
    provider.apiType === 'openai'
  );
}

type Selection =
  | { mode: 'alias' | 'default'; primary: Candidate; fallbacks: Candidate[] }
  | { mode: 'invalid'; reason: string };

/**
 * 是否是「Approve for me」触发的审批请求。
 *
 * Codex 会给这类请求带上 `x-codex-turn-metadata`，其中 `turn_trigger` 为
 * `guardian_review`（见 ref/codex 的 guardian 测试）。用这个判定比"模型名等于
 * gpt-5.6-luna"可靠 —— 后者会把用户真的把这个模型用于普通对话时也一起改掉。
 *
 * 但它单独也不够：占位名会随 Codex 版本变，只认 turn_trigger 会在改名时改错模型。
 * 所以这里只回答"是不是审批请求"，真正改写还要再叠一个"模型名正是占位名"的条件。
 *
 * 解析失败按 false 处理：请求头是外部可控的，宁可漏改也不能因为畸形 JSON 抛错。
 */
function isApprovalReviewRequest(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  const raw = headers['x-codex-turn-metadata'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return false;
  try {
    const meta = JSON.parse(value) as { turn_trigger?: unknown };
    return meta.turn_trigger === 'guardian_review';
  } catch {
    return false;
  }
}

/**
 * 选出候选供应商（主 + 回退）。
 *
 * `approvalReview` 来自请求头，只决定"是否把 Codex 的审批占位模型换掉"，
 * 与"这次要不要转换"无关——转换由每个候选自己的 needsConversion 判定。
 */
function selectCandidates(
  requested: string,
  providers: ProviderRecord[],
  settings: TenantSettings,
  path: GatewayPath,
  approvalReview: boolean,
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
        convertResponsesToChat: needsConversion(provider, path, settings),
      },
      // 别名是明确指向，不做故障转移
      fallbacks: [],
    };
  }

  // 候选池在选路阶段就按协议过滤，而不是等到发送前才拦：
  // 否则回退列表里会混进别的协议，主供应商失败后换一家必然 501，白白多打一次上游。
  const required = requiredApiType(path);
  // 打开跨协议转发时，responses 路径也接受 openai 供应商（网关负责转换）。
  // 反之不行：`/v1/messages` 没有 Chat 的等价转换，仍然只能 anthropic。
  const convertible = required === 'responses' && settings.protocolConversion;
  const acceptable = (apiType: ProviderRecord['apiType']): boolean =>
    required === null || apiType === required || (convertible && apiType === 'openai');

  const usable = providers
    .filter((item) => item.enabled && acceptable(item.apiType))
    // 协议完全匹配的排前面：能直通就别转换，转换有信息损失
    .sort((a, b) => {
      const aExact = a.apiType === required ? 0 : 1;
      const bExact = b.apiType === required ? 0 : 1;
      return aExact - bExact || a.priority - b.priority;
    });

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

  // 「Approve for me」的模型映射。
  //
  // Codex 用 API Key 认证时把审批模型硬编码成 `gpt-5.6-luna`，且没有任何配置项能改
  // （详见 APPROVAL_REVIEW_MODEL_NAME 的注释）。走网关时这个名字会原样出现在请求体里，
  // 所以可以把它当占位名换掉——前提是用户没把它当成真实模型在别处使用。
  //
  // 只认"裸模型名"形态：`lam-` 别名是用户明确指定的，不该被这段改写。
  const approvalModel = settings.approvalReviewModel;
  // 两个条件都满足才改写：
  // 1) 请求确实来自审批流程（turn_trigger=guardian_review）
  // 2) 模型名就是 Codex 硬编码的占位名
  // 只靠其一会误伤（用户真用这个模型）或漏改（占位名换了）。
  const isApprovalPlaceholder =
    approvalReview &&
    approvalModel !== null &&
    approvalModel !== '' &&
    resolution.upstreamModel === APPROVAL_REVIEW_MODEL_NAME;

  if (isApprovalPlaceholder) {
    return {
      mode: 'default',
      primary: {
        provider: primaryProvider,
        upstreamModel: approvalModel as string,
        modelRewritten: true,
        convertResponsesToChat: needsConversion(primaryProvider, path, settings),
      },
      // 审批请求不做故障转移：换个供应商大概率没有同名模型，白白多打一次上游
      fallbacks: [],
    };
  }

  return {
    mode: 'default',
    primary: {
      provider: primaryProvider,
      upstreamModel: useDefaultModel ? (settings.defaultModel as string) : resolution.upstreamModel,
      modelRewritten: useDefaultModel,
      convertResponsesToChat: needsConversion(primaryProvider, path, settings),
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
      // 回退到不同协议的供应商时同样需要转换；否则请求会以 Responses 形状
      // 打到 Chat 上游，变成上游的参数错误，比直接失败更难排查。
      convertResponsesToChat: needsConversion(item, path, settings),
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

      // 自动开启跨协议转发。
      //
      // 放在这里而不是更早，是因为更早的位置（body 校验之前）会让一个缺 `model`
      // 的畸形请求——哪怕来自扫描器——也永久改掉租户的设置，而那个请求本身还是 400、
      // 走的是错误处理器而非 reply.raw，用户看不到 x-llmapi-auto-conversion 头，
      // 等于悄悄改了全局行为却毫无提示。
      //
      // 触发条件刻意收窄（见下方注释），只有"打开真的能解决问题"才开。
      const autoEnabledConversion =
        !settings.protocolConversion &&
        requiredApiType(path) === 'responses' &&
        !records.some((item) => item.enabled && item.apiType === 'responses') &&
        records.some((item) => item.enabled && item.apiType === 'openai');
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

      // selection 是在自动开启之前算的，里面的 convertResponsesToChat 还是 false。
      // 开启后必须重新选择一次，否则设置改了、本次请求却仍按"不转换"发出去，
      // 用户下次还得再碰一次才生效。
      if (autoEnabledConversion) {
        selection = selectCandidates(
          requestedModel,
          records,
          settings,
          path,
          isApprovalReviewRequest(request.headers),
        );
        if (selection.mode === 'invalid') throw badRequest(selection.reason);
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
