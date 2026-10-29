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
import { EFFORT_PROBE_CANDIDATES, probeProviderEfforts } from '../services/effortProbe';
import { badRequest } from '../http/errors';
import { resolveRequestLanguage } from '../i18n/language';
import { API_TYPES, type ApiType } from '../domain/provider';

function asProviderInput(body: unknown): ProviderInput {
  const raw = (body ?? {}) as Partial<ProviderInput>;
  if (typeof raw.name !== 'string') throw badRequest('providers.validation.nameType');
  // 用 API_TYPES 而不是逐个字面量比较：加 responses 时这里曾漏改，
  // 表现为前端能选新协议、提交却被自己的路由校验挡回。
  if (!API_TYPES.includes(raw.apiType as ApiType)) {
    throw badRequest('providers.validation.apiTypeInvalid', { types: API_TYPES.join(' / ') });
  }
  if (typeof raw.baseUrl !== 'string') throw badRequest('providers.validation.baseUrlType');
  if (raw.models !== undefined && !Array.isArray(raw.models)) {
    throw badRequest('providers.validation.modelsType');
  }
  if (raw.models && raw.models.some((item) => typeof item !== 'string')) {
    throw badRequest('providers.validation.modelsItems');
  }
  // 生图模型列表与对话模型列表同形，校验也用同一套规则
  if (raw.imageModels !== undefined && !Array.isArray(raw.imageModels)) {
    throw badRequest('providers.validation.imageModelsType');
  }
  if (raw.imageModels && raw.imageModels.some((item) => typeof item !== 'string')) {
    throw badRequest('providers.validation.imageModelsItems');
  }
  // 能力表只做形状校验，取值合法性（正整数、模型仍在列表里）交给
  // ProviderService.normalizeCapabilities —— 一条规则一处实现，避免两套标准。
  if (
    raw.modelCapabilities !== undefined &&
    (typeof raw.modelCapabilities !== 'object' || raw.modelCapabilities === null)
  ) {
    throw badRequest('providers.validation.modelCapabilitiesType');
  }
  return {
    name: raw.name,
    apiType: raw.apiType as ApiType,
    baseUrl: raw.baseUrl,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : undefined,
    models: raw.models as string[] | undefined,
    imageModels: raw.imageModels as string[] | undefined,
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
        throw badRequest('providers.validation.idsType');
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
      if (typeof body.enabled !== 'boolean') throw badRequest('providers.validation.enabledType');
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
      const result = await testProviderConnectivity(
        record,
        apiKey,
        resolveRequestLanguage(request, ctx),
      );
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
   * 逐档实测供应商的 reasoning effort 档位，并把探测结果写回模型能力。
   *
   * 为什么要真的发请求：模型目录里的 supported_reasoning_levels 只能来自
   * `modelCapabilities[model].reasoningEfforts`，而上游 `/models` 不提供档位，
   * modelinfo/models.dev 又经常缺数据。见 services/effortProbe.ts 文件头。
   *
   * 失败语义：上游拒绝某个档位不是接口错误（结果里返回 accepted/rejected）；
   * 只有供应商不存在（404）、没有模型、协议不支持（400）才是请求本身的错误。
   * 探测全失败的模型保持原能力配置不动，避免一次网络抖动被写成"不支持推理"。
   */
  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/providers/:id/probe-efforts', access: 'providers:write' },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const record = service.get(id);
      if (record.models.length === 0) throw badRequest('providers.probe.noModels');
      // anthropic Messages 用 thinking.budget_tokens 表达思考预算，没有 effort 档位；
      // 强行探测只会把每个请求都打成 400，让用户误以为"这个模型不支持思考"。
      if (record.apiType === 'anthropic') {
        throw badRequest('providers.probe.unsupportedProtocol', { apiType: record.apiType });
      }

      const language = resolveRequestLanguage(request, ctx);
      const candidates = EFFORT_PROBE_CANDIDATES;
      const total = record.models.length * candidates.length;

      // 直接写 reply.raw：这是流式响应，不能走 Fastify 的 JSON 序列化。
      // 用 NDJSON（每行一个事件）而不是 SSE：客户端只需 reader + split('\n')，
      // 不用实现 SSE 的 event/data 解析；而 4xx/404 仍走普通 JSON 错误体。
      //
      // `x-accel-buffering: no` / `no-transform` 是给 nginx 之类中间层看的：
      // 默认它们会缓冲整个响应，进度事件会攒到结束才一起到——进度条就等于没有。
      reply.raw.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      const send = (event: unknown): void => {
        // 客户端可能中途断开（关页面 / 切路由）：往已关闭的流写会抛错，直接跳过。
        if (reply.raw.writableEnded || reply.raw.destroyed) return;
        reply.raw.write(`${JSON.stringify(event)}\n`);
      };

      send({ type: 'start', total, candidates, models: record.models });
      try {
        const outcome = await probeProviderEfforts(record, service.plainApiKey(record), {
          language,
          onProgress: (progress) => send({ type: 'progress', ...progress }),
        });

        // 只合并探测出档位的模型；没探测到档位的模型保留原记录（含上下文/模态等字段）。
        const nextCapabilities = { ...(record.modelCapabilities ?? {}), ...outcome.capabilities };
        const provider =
          Object.keys(outcome.capabilities).length > 0
            ? service.update(record.id, {
                // update() 是**全量更新**：notes / websiteUrl / enabled / priority
                // 传掉就会按缺省值覆盖，所以这里逐项带上原值，只替换能力表。
                //
                // `imageModels` 必须一起带上：漏掉它会让用户配好的生图模型
                // 在点一次「逐档实测」后凭空消失（真实踩过）。
                // 服务层也有兜底（不传=沿用），但这里显式传是为了让"这个接口改了什么"
                // 在代码里一眼可读，而不是依赖别处的默认行为。
                name: record.name,
                apiType: record.apiType,
                baseUrl: record.baseUrl,
                models: record.models,
                imageModels: record.imageModels,
                modelCapabilities: nextCapabilities,
                enabled: record.enabled,
                priority: record.priority,
                notes: record.notes,
                websiteUrl: record.websiteUrl,
              })
            : service.toView(record);

        send({
          type: 'result',
          provider,
          candidates: outcome.candidates,
          models: outcome.models,
        });
      } catch (error) {
        // 响应头已经发出去了，改不了状态码。用 error 事件把原因交给前端，
        // 而不是让连接静默断掉、界面以为"卡住了"。
        ctx.logger.error('logs.providers.probeFailed', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
        send({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        reply.raw.end();
      }
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
        throw badRequest('providers.validation.apiTypeInvalid', { types: API_TYPES.join(' / ') });
      }
      if (typeof body.baseUrl !== 'string' || body.baseUrl.trim() === '') {
        throw badRequest('providers.validation.baseUrlBlank');
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
          throw badRequest('providers.models.apiKeyRequired');
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
        // 失败说明会原样显示在界面上，按请求语言渲染
        language: resolveRequestLanguage(request, ctx),
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
