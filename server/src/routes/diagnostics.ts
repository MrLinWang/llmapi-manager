import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { badRequest, notFound } from '../http/errors';
import { translate } from '../i18n';
import { resolveRequestLanguage } from '../i18n/language';
import { ProviderService } from '../services/providers';
import { listAliases } from '../domain/aliases';
import {
  GATEWAY_PATHS,
  requiredApiType,
  upstreamPathFor,
  upstreamUrl,
  buildUpstreamHeaders,
  type GatewayPath,
} from '../gateway/forward';
import {
  isApprovalReviewRequest,
  selectCandidates,
  wouldAutoEnableConversion,
} from '../gateway/selection';
import { responsesToChatRequest, ConversionError } from '../gateway/convert/responsesToChat';
import { chatToResponsesResponse } from '../gateway/convert/chatToResponses';
import { AGENT_DEFINITIONS, AgentPathResolver } from '../agents/registry';
import { DEFAULT_TENANT_ID } from '../domain/identity';
import fs from 'node:fs';
import { NetworkingRuntime, type NativeLayerCheck } from '../networking/runtime';

/**
 * 读磁盘上真实的 Codex 目录文件，返回其中的 slug 列表。
 * 文件不存在或解析失败返回 null —— 调用方据此区分"没 apply 过"与"目录为空"。
 */
function readCatalogSlugs(filePath: string): string[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      models?: Array<{ slug?: unknown }>;
    };
    if (!Array.isArray(parsed.models)) return null;
    return parsed.models
      .map((item) => item.slug)
      .filter((slug): slug is string => typeof slug === 'string');
  } catch {
    return null;
  }
}

/**
 * 诊断接口：回答"某个功能到底有没有生效"。
 *
 * 存在的理由：这个仓库的行为横跨「设置项 → 选路 → 协议转换 → 上游 → 回转」四层，
 * 中间任何一层判断错，症状都是"上游不报错、客户端也不报错，只是结果不对"
 * （工具调用执行不了、思考区一直转圈、模型列表里少一家）。靠读日志很难定位。
 *
 * 因此这里把每一层的中间结果都摊开返回，让调用方（人或代理）能直接对比
 * "我以为会发生什么"与"实际会发生什么"。
 *
 * 两个设计约束：
 * 1. **必须复用网关自己的逻辑**（selection.ts / convert/），不能各算一遍。
 *    否则诊断说会转换、实际没转换，比没有诊断更糟。
 * 2. **默认关闭**（ENABLE_DIAGNOSTICS=1），因为它会回显 prompt 片段并真的打上游。
 */

/**
 * 诊断接口统一先过这道门：未开启时返回 404。
 *
 * 注意 404 **并不能**真正隐藏"这里有个功能"：返回体里的 message 会写明
 * "诊断接口未启用，请设置 ENABLE_DIAGNOSTICS=1 后重启"，探测者照样能知道开关存在。
 * 用 404 而不是 403 的实际收益只是"未启用"不该算权限问题——未登录/无权限才该 403，
 * 这里拒绝的理由是功能没开，与调用者身份无关。
 */
function assertEnabled(ctx: AppContext): void {
  if (!ctx.config.enableDiagnostics) {
    throw notFound('diagnostics.disabled');
  }
}

function parsePath(raw: unknown): GatewayPath {
  if (typeof raw !== 'string') throw badRequest('diagnostics.pathNotString');
  const normalized = raw.startsWith('/v1') ? raw.slice(3) : raw;
  if (!(GATEWAY_PATHS as readonly string[]).includes(normalized)) {
    throw badRequest('diagnostics.pathNotSupported', { paths: GATEWAY_PATHS.join(' / ') });
  }
  return normalized as GatewayPath;
}

export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  /**
   * 路由预演：不发送任何请求，只回答"这次会走哪里、要不要转换、会不会 501"。
   *
   * 这是最常用的诊断：用户说"我在 Codex 里选不到某个模型"，用它就能看出
   * 是协议没匹配、还是目录没生成。
   */
  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/diagnostics/route', access: 'settings:write' },
    async (request) => {
      assertEnabled(ctx);
      // 诊断输出是给人读的解释，必须跟随请求语言（租户设置 → Accept-Language）
      const language = resolveRequestLanguage(request, ctx);
      const body = (request.body ?? {}) as { model?: unknown; path?: unknown };
      const path = parsePath(body.path ?? '/responses');
      if (typeof body.model !== 'string' || body.model.trim() === '') {
        throw badRequest('diagnostics.modelEmpty');
      }

      const providerService = new ProviderService(repos, ctx.secrets);
      const records = providerService.listRecords();
      let settings = repos.settings.read();

      // 用与网关完全相同的函数，保证诊断结果与实际行为一致
      let selection = selectCandidates(
        body.model,
        records,
        settings,
        path,
        isApprovalReviewRequest(request.headers),
      );

      // 必须模拟网关的"自动开启跨协议转发"。
      //
      // 真实网关在选路之后会判断是否该自动开启，开了再**重选一次**。
      // 诊断若漏掉这段，就会在"只有 openai 供应商 + 开关关闭"时回答
      // "直发 /responses、不需要转换"，而实际网关已经自动开了开关并改走
      // /chat/completions —— 结论方向完全相反，比没有诊断更误导。
      const wouldAutoEnable = wouldAutoEnableConversion(records, settings, path);
      if (wouldAutoEnable) {
        // 注意：诊断**不写设置**。它只回答"如果我发这个请求会发生什么"，
        // 真正改设置的是真实请求。这里用内存副本模拟开启后的状态。
        settings = { ...settings, protocolConversion: true };
        selection = selectCandidates(
          body.model,
          records,
          settings,
          path,
          isApprovalReviewRequest(request.headers),
        );
      }

      const required = requiredApiType(path);
      const describe = (item: { provider: typeof records[number]; upstreamModel: string; modelRewritten: boolean; convertResponsesToChat: boolean; reason?: string }) => ({
        providerId: item.provider.id,
        providerName: item.provider.name,
        providerKey: item.provider.providerKey,
        apiType: item.provider.apiType,
        enabled: item.provider.enabled,
        // 用真实的路径改写逻辑：转换时上游收到的其实是 /chat/completions
        wouldUseUpstreamUrl: upstreamUrl(item.provider, upstreamPathFor(item, path)),
        upstreamModel: item.upstreamModel,
        modelRewritten: item.modelRewritten,
        reason: item.reason ?? null,
        convertResponsesToChat: item.convertResponsesToChat,
        authHeaderKind:
          item.provider.apiType === 'anthropic' ? 'x-api-key' : 'authorization: Bearer',
        // 让调用方能直接看出"这次请求会不会因为协议不匹配被拒"
        apiTypeMatchesPath:
          required === null || item.provider.apiType === required,
      });

      if (selection.mode === 'invalid') {
        return {
          ok: false,
          path,
          requiredApiType: required,
          protocolConversion: settings.protocolConversion,
          reason: selection.reason,
          // 被排除的供应商：这是"明明有几家供应商却说没有"的唯一解释来源
          excluded: selection.excluded ?? [],
          // 明确告诉调用方"改哪个设置可能解决"，避免只报错不给出路
          hint:
            required === 'responses' && !settings.protocolConversion
              ? translate(language, 'diagnostics.route.conversionHint')
              : null,
        };
      }

      // 真实网关会在发请求前再做一次协议兜底校验，不匹配就 501。
      // 诊断必须复现这个结论，否则用户会以为"诊断说能走"就一定能走。
      const primaryMatches = required === null || selection.primary.provider.apiType === required;
      const allowedByConversion =
        selection.primary.convertResponsesToChat ||
        // 自动开启后网关会按"开关已打开"重新校验，这里用同一个口径
        false;

      return {
        ok: primaryMatches || allowedByConversion,
        path,
        requiredApiType: required,
        protocolConversion: settings.protocolConversion,
        // 让调用方知道"这次请求会改动你的设置"
        wouldAutoEnableConversion: wouldAutoEnable,
        wouldBeRejected:
          !primaryMatches && !allowedByConversion
            ? translate(language, 'diagnostics.route.wouldReject', {
                required,
                apiType: selection.primary.provider.apiType,
              })
            : null,
        mode: selection.mode,
        primary: describe(selection.primary),
        fallbacks: selection.fallbacks.map(describe),
        // 被排除的供应商：解释"为什么不是它"，这是排查"模型不在列表里"的关键
        excluded: selection.excluded ?? [],
      };
    },
  );

  /**
   * 全链路诊断：真的打一次上游，把每一层的中间结果都返回。
   *
   * 用于回答"转换到底对不对"——这是读代码和看日志都很难判断的：
   * 转换错误时上游往往返回 200，只是内容不对。
   */
  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/diagnostics/forward', access: 'settings:write' },
    async (request) => {
      assertEnabled(ctx);
      const language = resolveRequestLanguage(request, ctx);
      const body = (request.body ?? {}) as {
        model?: unknown;
        path?: unknown;
        body?: unknown;
      };
      const path = parsePath(body.path ?? '/responses');
      if (typeof body.model !== 'string' || body.model.trim() === '') {
        throw badRequest('diagnostics.modelEmpty');
      }
      // 校验 body 必须是对象：数组或字符串会让下面的展开静默丢掉所有字段，
      // 接口照样 200 并继续打上游——用户以为自己传了 prompt，其实传的是空请求。
      const rawBody = body.body ?? { model: body.model };
      if (typeof rawBody !== 'object' || rawBody === null || Array.isArray(rawBody)) {
        throw badRequest('diagnostics.bodyNotObject');
      }
      const requestBody = rawBody as Record<string, unknown>;

      const providerService = new ProviderService(repos, ctx.secrets);
      const records = providerService.listRecords();
      let settings = repos.settings.read();
      const approvalReview = isApprovalReviewRequest(request.headers);

      // 与真实网关一致：自动开启后按"开关已打开"重新选路
      const wouldAutoEnable = wouldAutoEnableConversion(records, settings, path);
      if (wouldAutoEnable) settings = { ...settings, protocolConversion: true };

      const selection = selectCandidates(
        body.model,
        records,
        settings,
        path,
        approvalReview,
      );
      if (selection.mode === 'invalid') {
        throw badRequest('diagnostics.selectionFailed', { reason: selection.reason });
      }

      const candidate = selection.primary;
      const provider = candidate.provider;
      const steps: Array<Record<string, unknown>> = [];

      // ── 第 1 层：选路
      steps.push({
        step: 'select',
        ok: true,
        providerId: provider.id,
        providerName: provider.name,
        apiType: provider.apiType,
        upstreamModel: candidate.upstreamModel,
        modelRewritten: candidate.modelRewritten,
        reason: candidate.reason ?? null,
      });

      // 与真实转发一致地收集 custom 工具名：响应方向要靠它把 function_call 还原成
      // custom_tool_call。漏了它，Codex 会按 function 语义构造历史，调用链断掉，
      // 而诊断会显示"转换正常"——正是最该被诊断抓出来的假阴性。
      const customToolNames = new Set<string>();
      const declaredTools = (requestBody as { tools?: unknown }).tools;
      if (Array.isArray(declaredTools)) {
        for (const tool of declaredTools) {
          if (
            tool !== null &&
            typeof tool === 'object' &&
            (tool as { type?: unknown }).type === 'custom' &&
            typeof (tool as { name?: unknown }).name === 'string'
          ) {
            customToolNames.add((tool as { name: string }).name);
          }
        }
      }

      // ── 第 2 层：请求转换（仅在需要时）
      let upstreamBody: Record<string, unknown> = {
        ...requestBody,
        model: candidate.upstreamModel,
      };
      if (candidate.convertResponsesToChat) {
        try {
          const converted = responsesToChatRequest(upstreamBody, candidate.upstreamModel);
          upstreamBody = converted.body as unknown as Record<string, unknown>;
          steps.push({
            step: 'convert-request',
            ok: true,
            // 转换后的完整请求体：这是"上游到底收到了什么"的唯一可靠答案
            body: upstreamBody,
            // 被丢弃的字段要显式列出——转换是有损的，用户有权知道丢了什么
            dropped: converted.meta.dropped,
          });
        } catch (cause) {
          steps.push({
            step: 'convert-request',
            ok: false,
            error:
              cause instanceof ConversionError
                ? translate(language, cause.key, cause.params)
                : translate(language, 'diagnostics.chain.convertFailed'),
          });
          return {
            ok: false,
            path,
            upstreamPath: upstreamUrl(provider, path),
            steps,
            summary: translate(language, 'diagnostics.chain.convertFailedSummary'),
          };
        }
      } else {
        steps.push({
          step: 'convert-request',
          ok: true,
          skipped: true,
          reason: candidate.convertResponsesToChat
            ? translate(language, 'diagnostics.chain.convertNotTriggered')
            : translate(language, 'diagnostics.chain.convertSkipped', {
                required: requiredApiType(path),
                apiType: provider.apiType,
              }),
          body: upstreamBody,
        });
      }

      // ── 第 3 层：真实上游调用
      const url = upstreamUrl(provider, upstreamPathFor(candidate, path));
      const apiKey = providerService.plainApiKey(provider);
      const headers = buildUpstreamHeaders(provider, apiKey, request.headers);
      const startedAt = Date.now();
      let upstreamStatus = 0;
      let upstreamText = '';
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(upstreamBody),
          signal: AbortSignal.timeout(60_000),
        });
        upstreamStatus = response.status;
        upstreamText = await response.text();
        // 诊断会真打上游、真烧额度，必须留痕：出现"谁在反复调诊断"时
        // 要能从日志查到。正常转发每笔都写日志，诊断不该是盲区。
        ctx.logger.info('logs.gateway.diagnosticsForward', {
          name: provider.name,
          id: provider.id,
          status: upstreamStatus,
          latency: Date.now() - startedAt,
          user: request.principal?.userId ?? 'unknown',
        });
        steps.push({
          step: 'upstream',
          ok: response.ok,
          url,
          status: upstreamStatus,
          latencyMs: Date.now() - startedAt,
          // 截断避免超大响应把接口本身也拖垮；诊断只需要看形状
          bodyPreview: upstreamText.slice(0, 4000),
          truncated: upstreamText.length > 4000,
        });
      } catch (cause) {
        steps.push({
          step: 'upstream',
          ok: false,
          url,
          error:
            cause instanceof Error ? cause.message : translate(language, 'diagnostics.chain.upstreamFailed'),
          latencyMs: Date.now() - startedAt,
        });
        return {
          ok: false,
          path,
          steps,
          summary: translate(language, 'diagnostics.chain.upstreamFailedSummary'),
        };
      }

      if (!upstreamText) {
        return {
          ok: false,
          path,
          steps,
          summary: translate(language, 'diagnostics.chain.upstreamEmptySummary'),
        };
      }

      // ── 第 4 层：响应转换
      //
      // 流式响应（SSE）这里**不解析**：它是一行行 `data: {...}`，JSON.parse 必然失败，
      // 而真实链路是好的——那样诊断就会在功能正常时报错（Codex 永远发 stream:true，
      // 所以这个假错必然撞上）。正确处理是明确跳过并说清原因，让用户改用非流式 body
      // 验证转换；流式那条路由 sweep 由 convert.test.ts 覆盖。
      const wantsStream = (requestBody as { stream?: unknown }).stream === true;
      if (candidate.convertResponsesToChat && wantsStream) {
        steps.push({
          step: 'convert-response',
          ok: true,
          skipped: true,
          reason: translate(language, 'diagnostics.chain.streamSkipped'),
          // 仍给出 SSE 原文，肉眼可确认事件序列是否合理
          ssePreview: upstreamText.slice(0, 2000),
        });
      } else if (candidate.convertResponsesToChat) {
        try {
          const chat = JSON.parse(upstreamText) as Record<string, unknown>;
          const back = chatToResponsesResponse({
            model: candidate.upstreamModel,
            chat: chat as never,
            customToolNames,
            responseId: 'resp_diagnostics',
            createdAt: Math.floor(Date.now() / 1000),
          });
          steps.push({
            step: 'convert-response',
            ok: true,
            // 转回 Responses 形状后的结果：Codex 实际会收到什么
            body: back,
          });
        } catch (cause) {
          steps.push({
            step: 'convert-response',
            ok: false,
            error:
              cause instanceof Error
                ? cause.message
                : translate(language, 'diagnostics.chain.responseConvertFailed'),
            // 最常见原因：上游没按 Chat 格式返回（例如它其实是 Responses 协议）
            hint: translate(language, 'diagnostics.chain.responseConvertHint'),
          });
        }
      } else {
        steps.push({ step: 'convert-response', ok: true, skipped: true });
      }

      const allOk = steps.every((item) => item.ok !== false);
      return {
        ok: allOk,
        path,
        protocolConversion: settings.protocolConversion,
        steps,
        summary: allOk
          ? translate(language, 'diagnostics.chain.allOkSummary')
          : translate(language, 'diagnostics.chain.partialFailSummary'),
      };
    },
  );

  /**
   * 自检清单：把"应该一致"的几处放在一起比对。
   *
   * 这类问题最难发现：设置开着但目录没跟、目录有但协议不对、
   * Agent 配置指向的模式与设置不一致。单看任何一处都正常。
   */
  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/diagnostics/check', access: 'settings:write' },
    async (request) => {
      assertEnabled(ctx);
      const language = resolveRequestLanguage(request, ctx);
      const providerService = new ProviderService(repos, ctx.secrets);
      const records = providerService.listRecords();
      const settings = repos.settings.read();
      const aliases = listAliases(records);
      const checks: Array<{
        name: string;
        ok: boolean;
        detail: string;
        fix?: string;
      }> = [];

      // 1. Codex 必须能拿到 responses 协议（或能转换）
      const enabledResponses = records.filter((i) => i.enabled && i.apiType === 'responses');
      const enabledOpenai = records.filter((i) => i.enabled && i.apiType === 'openai');
      const codexUsable = enabledResponses.length > 0 ||
        (settings.protocolConversion && enabledOpenai.length > 0);
      checks.push({
        name: translate(language, 'diagnostics.check.codexProtocolName'),
        ok: codexUsable,
        detail: codexUsable
          ? settings.protocolConversion
            ? translate(language, 'diagnostics.check.codexProtocolOkWithConversion', {
                responses: enabledResponses.length,
                openai: enabledOpenai.length,
              })
            : translate(language, 'diagnostics.check.codexProtocolOk', {
                responses: enabledResponses.length,
              })
          : translate(language, 'diagnostics.check.codexProtocolFail'),
        fix: codexUsable ? undefined : translate(language, 'diagnostics.check.codexProtocolFix'),
      });

      // 2. 磁盘上真实的 Codex 目录里，不能有当前用不了的协议
      //
      // 必须读**磁盘上真正写进 Codex 的那份文件**，不能用 buildModelCatalog 现场重建：
      // 重建时若不带 `agents/service.ts` 那套协议过滤，就会把 openai 别名也算进来，
      // 于是在"responses + openai 并存、开关关闭"这个最常见的配置下**稳定误报**，
      // 并建议用户"重新 apply"——而 apply 之后目录本来就对，用户会陷入反复空转。
      //
      // 读文件还有个额外好处：它反映的是"Codex 现在实际看到的"，而不是"如果现在
      // 重新 apply 会生成什么"。这两者在用户改过设置却没 apply 时并不相同。
      const resolver = new AgentPathResolver(ctx.config.agentHomeDir);
      const catalogPath = resolver.resolve(
        'codex',
        { tenantId: DEFAULT_TENANT_ID, userId: '' },
        'catalog',
      );
      const onDisk = readCatalogSlugs(catalogPath);
      const unusable = onDisk === null
        ? []
        : onDisk.filter((slug) => {
            const alias = aliases.find((a) => a.alias === slug);
            // 目录里可能含直连模式的裸模型名（没有对应别名），那些不算问题
            if (!alias) return false;
            return (
              alias.apiType !== 'responses' &&
              !(settings.protocolConversion && alias.apiType === 'openai')
            );
          });
      checks.push({
        name: translate(language, 'diagnostics.check.catalogName'),
        ok: unusable.length === 0,
        detail:
          onDisk === null
            ? translate(language, 'diagnostics.check.catalogMissing')
            : unusable.length === 0
              ? translate(language, 'diagnostics.check.catalogAllUsable', { count: onDisk.length })
              : translate(language, 'diagnostics.check.catalogUnusable', {
                  count: unusable.length,
                  names: unusable.slice(0, 3).join(' / '),
                }),
        fix:
          unusable.length > 0
            ? translate(language, 'diagnostics.check.catalogFix')
            : undefined,
      });

      // 3. 审批模型映射只在网关模式有意义
      const codexTarget = settings.agentTargets?.codex;
      const approvalConfigured = settings.approvalReviewModel !== null;
      if (approvalConfigured && codexTarget?.mode === 'direct') {
        checks.push({
          name: translate(language, 'diagnostics.check.approvalDirectName'),
          ok: false,
          detail: translate(language, 'diagnostics.check.approvalDirectDetail'),
          fix: translate(language, 'diagnostics.check.approvalDirectFix'),
        });
      } else {
        checks.push({
          name: translate(language, 'diagnostics.check.approvalOkName'),
          ok: true,
          detail: approvalConfigured
            ? translate(language, 'diagnostics.check.approvalConfigured', {
                model: settings.approvalReviewModel,
              })
            : translate(language, 'diagnostics.check.approvalNotConfigured'),
        });
      }

      // 4. 别名与供应商一致性
      const staleAliases = aliases.filter(
        (alias) => !records.some((i) => i.id === alias.providerId),
      );
      checks.push({
        name: translate(language, 'diagnostics.check.aliasName'),
        ok: staleAliases.length === 0,
        detail:
          staleAliases.length === 0
            ? translate(language, 'diagnostics.check.aliasOk', { count: aliases.length })
            : translate(language, 'diagnostics.check.aliasStale', { count: staleAliases.length }),
      });

      return {
        ok: checks.every((item) => item.ok),
        checks,
        snapshot: {
          providers: {
            total: records.length,
            enabled: records.filter((i) => i.enabled).length,
            byApiType: {
              openai: records.filter((i) => i.apiType === 'openai').length,
              anthropic: records.filter((i) => i.apiType === 'anthropic').length,
              responses: records.filter((i) => i.apiType === 'responses').length,
            },
          },
          aliases: aliases.length,
          settings: {
            protocolConversion: settings.protocolConversion,
            approvalReviewModel: settings.approvalReviewModel,
            defaultProviderId: settings.defaultProviderId,
            defaultModel: settings.defaultModel,
            agentTargets: settings.agentTargets,
          },
          agents: Object.keys(AGENT_DEFINITIONS),
        },
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/diagnostics/networking', access: 'settings:write' },
    async () => {
      assertEnabled(ctx);

      // 设备互联的协议级自检。
      //
      // 这一项回答的是"原生模块编出来的字节对不对"，而不是"组网成不成功"。
      // 后者是不可靠的信号：协议字段错了可能被对端宽容忽略，某个能力没生效
      // （比如 liveness feature 字符串写错）完全看不出来，且没有任何日志。
      //
      // 自检是纯计算：不启动实例、不联网，所以随时可以跑，也不会有副作用。
      const runtime = new NetworkingRuntime(ctx.logger);
      const report = runtime.protocolSelfCheck();

      if (report === null) {
        return {
          available: false,
          ok: false,
          reason:
            '原生模块未编译或加载失败，无法做协议自检。' +
            '这**不代表协议有问题**——只是没有可检查的对象。' +
            '需要在 native/easytier-node 下编译（需 Rust 工具链）。',
          checks: [],
        };
      }

      return {
        available: true,
        ok: report.ok,
        version: report.version,
        checks: report.checks.map((check: NativeLayerCheck) => ({
          name: check.layer,
          ok: check.ok,
          detail: check.detail,
        })),
        summary: report.ok
          ? `协议自检全部通过（${report.checks.length} 层）`
          : `有 ${report.checks.filter((c: NativeLayerCheck) => !c.ok).length} 层未通过，详见 checks`,
      };
    },
  );

  /** 转换器本身的自检：不依赖任何供应商，纯函数层面验证映射是否正常 */
  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/diagnostics/converter', access: 'settings:write' },
    async (request) => {
      assertEnabled(ctx);
      const language = resolveRequestLanguage(request, ctx);
      const cases: Array<{ name: string; ok: boolean; detail: string }> = [];

      // 文本
      try {
        const result = responsesToChatRequest(
          { model: 'm', input: 'hello' },
          'm',
        );
        const messages = (result.body as { messages?: unknown[] }).messages ?? [];
        cases.push({
          name: translate(language, 'diagnostics.converter.textName'),
          ok: messages.length === 1,
          detail: JSON.stringify(messages),
        });
      } catch (cause) {
        cases.push({ name: translate(language, 'diagnostics.converter.textFailName'), ok: false, detail: String(cause) });
      }

      // 工具调用
      try {
        const result = responsesToChatRequest(
          {
            model: 'm',
            input: 'hi',
            tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
          },
          'm',
        );
        const tools = (result.body as { tools?: unknown[] }).tools ?? [];
        cases.push({
          name: translate(language, 'diagnostics.converter.toolsName'),
          ok: tools.length === 1,
          detail: JSON.stringify(tools),
        });
      } catch (cause) {
        cases.push({ name: translate(language, 'diagnostics.converter.toolsFailName'), ok: false, detail: String(cause) });
      }

      // custom 工具
      try {
        const result = responsesToChatRequest(
          {
            model: 'm',
            input: 'hi',
            tools: [{ type: 'custom', name: 'apply_patch', description: 'patch' }],
          },
          'm',
        );
        const tools = (result.body as { tools?: Array<{ function?: { parameters?: unknown } }> })
          .tools ?? [];
        const params = JSON.stringify(tools[0]?.function?.parameters ?? {});
        cases.push({
          name: translate(language, 'diagnostics.converter.customName'),
          ok: params.includes('input'),
          detail: params,
        });
      } catch (cause) {
        cases.push({ name: translate(language, 'diagnostics.converter.customFailName'), ok: false, detail: String(cause) });
      }

      // 无法转换的特性必须明确报错，而不是静默生成错误请求
      try {
        responsesToChatRequest(
          { model: 'm', input: 'hi', previous_response_id: 'resp_1' },
          'm',
        );
        cases.push({
          name: translate(language, 'diagnostics.converter.statefulName'),
          ok: false,
          detail: translate(language, 'diagnostics.converter.statefulNotRejected'),
        });
      } catch (cause) {
        cases.push({
          name: translate(language, 'diagnostics.converter.statefulName'),
          ok: cause instanceof ConversionError,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }

      // 响应方向
      try {
        const back = chatToResponsesResponse({
          model: 'm',
          chat: {
            choices: [
              { message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
            ],
          } as never,
          customToolNames: new Set<string>(),
          responseId: 'r',
          createdAt: 0,
        });
        cases.push({
          name: translate(language, 'diagnostics.converter.responseName'),
          ok: Array.isArray(back.output),
          detail: JSON.stringify(back.output).slice(0, 200),
        });
      } catch (cause) {
        cases.push({ name: translate(language, 'diagnostics.converter.responseFailName'), ok: false, detail: String(cause) });
      }

      return {
        ok: cases.every((item) => item.ok),
        cases,
        note: translate(language, 'diagnostics.converter.note'),
      };
    },
  );
}
