import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { ProviderService } from '../services/providers';
import { ALIAS_PREFIX, listAliases } from '../domain/aliases';
import { createGatewayTokenMeta, viewTokenMeta } from '../gateway/token';
import { badRequest } from '../http/errors';
import {
  AGENT_CONNECTION_MODES,
  CODEX_STREAM_IDLE_TIMEOUT_RANGE,
  CODEX_STREAM_MAX_RETRIES_RANGE,
  type AgentConnectionMode,
  type TenantSettings,
} from '../domain/settings';
import { getAgentDefinition } from '../agents/registry';
import { notFound } from '../http/errors';

/**
 * 解析「可空整数 + 范围」类型的设置项。
 *
 * 有三条刻意的严格性，都是为了避免"保存成功但实际没按预期生效"：
 * 1. **不接受字符串**：`"10"` 看着能用，但环境变量/表单都容易把它变成字符串，
 *    静默转换会让前端与后端对"是否合法"的判断不一致。
 * 2. **必须是整数**：`10.5` 次重试没有意义，而 Math.floor 会掩盖输入错误。
 * 3. **越界直接报错**：Codex 对 `stream_max_retries` 超过上限是静默截断，
 *    放过去会让用户以为设置生效了。
 *
 * null 表示"不写该键，用 Codex 默认值"，是合法输入。
 */
function parseBoundedInteger(
  raw: unknown,
  field: string,
  range: { min: number; max: number },
  suffix: string,
): number | null {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw badRequest(`${field} 必须是数字或 null`);
  }
  if (!Number.isInteger(raw)) {
    throw badRequest(`${field} 必须是整数`);
  }
  if (raw < range.min || raw > range.max) {
    throw badRequest(
      `${field} 必须是 ${range.min}–${range.max} 的整数${suffix}`,
    );
  }
  return raw;
}

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
        disableCodexWebSearch: settings.disableCodexWebSearch,
        approvalReviewModel: settings.approvalReviewModel,
        protocolConversion: settings.protocolConversion,
        codexStreamMaxRetries: settings.codexStreamMaxRetries,
        codexStreamIdleTimeoutMs: settings.codexStreamIdleTimeoutMs,
        agentTargets: settings.agentTargets,
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

  // Codex 配置里的行为开关与模型映射。放在这里而不是新建一个 routes 文件：
  // 它们和默认模型一样是租户级设置，共用同一份 settings.json。
  //
  // 三项的生效路径不同，但都返回 requiresReapply 让前端统一提示"重新应用配置"：
  // - disableCodexWebSearch：写进 config.toml，必须重新 apply 才落到文件里；
  // - protocolConversion：网关侧即时生效，但也会改变模型目录条目，需要重新 apply 才同步；
  // - approvalReviewModel：只在网关改写请求体时读取（routes/gateway.ts），本身不写文件。
  // 统一提示而不是逐项区分，是因为用户改完设置后大概率还要重新下发一次。
  // 别在这里顺手替用户触发 apply，那会在用户还没选择供应商时写坏配置。
  defineRoute(
    app,
    registry,
    { method: 'PATCH', url: '/api/settings/codex', access: 'settings:write' },
    async (request) => {
      const body = (request.body ?? {}) as {
        disableCodexWebSearch?: unknown;
        approvalReviewModel?: unknown;
        protocolConversion?: unknown;
        codexStreamMaxRetries?: unknown;
        codexStreamIdleTimeoutMs?: unknown;
      };
      const settings = repos.settings.read();

      const next: TenantSettings = { ...settings };
      if (body.disableCodexWebSearch !== undefined) {
        if (typeof body.disableCodexWebSearch !== 'boolean') {
          throw badRequest('disableCodexWebSearch 必须是布尔值');
        }
        next.disableCodexWebSearch = body.disableCodexWebSearch;
      }
      if (body.protocolConversion !== undefined) {
        if (typeof body.protocolConversion !== 'boolean') {
          throw badRequest('protocolConversion 必须是布尔值');
        }
        next.protocolConversion = body.protocolConversion;
      }
      if (body.approvalReviewModel !== undefined) {
        if (body.approvalReviewModel !== null && typeof body.approvalReviewModel !== 'string') {
          throw badRequest('approvalReviewModel 必须是字符串或 null');
        }
        const model = body.approvalReviewModel as string | null;
        next.approvalReviewModel = model === '' ? null : model;
      }
      // 流式参数：null = 不写该键（用 Codex 默认），数字 = 写进 provider 段。
      // 必须在这里就挡住越界值：Codex 对 stream_max_retries 超过 100 是**静默截断**，
      // 用户填 200 却以为生效，排查时会怀疑"设置没保存"。
      if (body.codexStreamMaxRetries !== undefined) {
        next.codexStreamMaxRetries = parseBoundedInteger(
          body.codexStreamMaxRetries,
          'codexStreamMaxRetries',
          CODEX_STREAM_MAX_RETRIES_RANGE,
          '（Codex 对超过上限的值会静默截断，所以在这里直接拒绝）',
        );
      }
      if (body.codexStreamIdleTimeoutMs !== undefined) {
        next.codexStreamIdleTimeoutMs = parseBoundedInteger(
          body.codexStreamIdleTimeoutMs,
          'codexStreamIdleTimeoutMs',
          CODEX_STREAM_IDLE_TIMEOUT_RANGE,
          '',
        );
      }
      next.updatedAt = new Date().toISOString();
      repos.settings.write(next);

      return {
        disableCodexWebSearch: next.disableCodexWebSearch,
        approvalReviewModel: next.approvalReviewModel,
        protocolConversion: next.protocolConversion,
        codexStreamMaxRetries: next.codexStreamMaxRetries,
        codexStreamIdleTimeoutMs: next.codexStreamIdleTimeoutMs,
        // 提示调用方：这项改动要重新"应用配置"才会写进 Agent 的文件
        requiresReapply: true,
      };
    },
  );

  // 按 Agent 分别设置下发偏好：Codex 与 Claude Code 协议不同、用途也可能不同，
  // 用一个全局开关会强迫两者同步切换。
  defineRoute(
    app,
    registry,
    { method: 'PATCH', url: '/api/agents/:id/target', access: 'agents:apply' },
    async (request) => {
      const { id } = request.params as { id: string };
      const definition = getAgentDefinition(id);
      if (!definition) throw notFound(`未知 Agent: ${id}`);
      const agentId = definition.id;

      const body = (request.body ?? {}) as {
        mode?: unknown;
        directProviderId?: unknown;
        directModel?: unknown;
      };
      const settings = repos.settings.read();
      const current = settings.agentTargets?.[agentId] ?? {
        mode: 'gateway' as AgentConnectionMode,
        directProviderId: null,
        directModel: null,
      };

      const nextPreference = { ...current };

      if (body.mode !== undefined) {
        if (
          typeof body.mode !== 'string' ||
          !AGENT_CONNECTION_MODES.includes(body.mode as AgentConnectionMode)
        ) {
          throw badRequest(`mode 只能是 ${AGENT_CONNECTION_MODES.join(' 或 ')}`);
        }
        nextPreference.mode = body.mode as AgentConnectionMode;
      }

      if (body.directProviderId !== undefined) {
        if (body.directProviderId !== null && typeof body.directProviderId !== 'string') {
          throw badRequest('directProviderId 必须是字符串或 null');
        }
        const providerId = body.directProviderId as string | null;
        if (providerId === '') {
          nextPreference.directProviderId = null;
        } else if (providerId !== null) {
          // 存之前就校验，避免设置了不存在的供应商、直到点"应用"才报错。
          // 协议与启用状态必须在保存时卡住：直连会把这家供应商的地址与真实 Key
          // 直接写进用户家目录的配置，选错协议的后果不是 501 而是"配了一个永远不通的 Agent"。
          const provider = providers.get(providerId);
          // 只放行该 Agent 能用的协议：Codex 恒写 wire_api="responses"、Claude Code
          // 走 Anthropic env 段。协议不对的话，配置写出来完全正常却永远打不通。
          const needed = agentId === 'claude-code' ? 'anthropic' : 'responses';
          if (!provider.enabled) {
            throw badRequest(`供应商「${provider.name}」已被停用，不能用于直连`);
          }
          if (provider.apiType !== needed) {
            throw badRequest(
              `供应商「${provider.name}」的协议类型不适用于 ${definition.name}，需要 ${needed}`,
            );
          }
          nextPreference.directProviderId = providerId;
          // 换了供应商，之前指定的模型多半不再存在，一并清掉由后端回落
          if (body.directModel === undefined) nextPreference.directModel = null;
        }
      }

      if (body.directModel !== undefined) {
        if (body.directModel !== null && typeof body.directModel !== 'string') {
          throw badRequest('directModel 必须是字符串或 null');
        }
        const model = body.directModel as string | null;
        nextPreference.directModel = model === '' ? null : model;
      }

      // 切到网关模式时清掉直连专属字段，避免下次切回来时用了过期的供应商。
      // 不清的话，用户切回 direct 会看到一份"上次的选择"并以为是当前的——
      // 而用户可能早就删掉了那家供应商。
      if (nextPreference.mode === 'gateway') {
        nextPreference.directProviderId = null;
        nextPreference.directModel = null;
      }

      const next: TenantSettings = {
        ...settings,
        agentTargets: { ...settings.agentTargets, [agentId]: nextPreference },
        updatedAt: new Date().toISOString(),
      };
      repos.settings.write(next);

      return {
        agentTargets: next.agentTargets,
        // 提示调用方：这项改动要重新"应用配置"才会写进 Agent 的文件
        requiresReapply: true,
      };
    },
  );
}
