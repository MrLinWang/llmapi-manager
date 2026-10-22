import fs from 'node:fs';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import type { Principal } from '../domain/identity';
import type {
  AgentBindingState,
  AgentFileRole,
  AgentId,
  AgentPreview,
  AgentFilePreview,
  WrittenFileSnapshot,
} from '../domain/agent';
import { AGENT_DEFINITIONS, getAgentDefinition } from './registry';
import { AgentPathResolver } from './registry';
import {
  applyAgentWrites,
  buildPreviewEntries,
  readFileSafe,
  revertAgentWrites,
  type DesiredWrites,
} from './patch';
import { apiTypeLabel, type ProviderRecord } from '../domain/provider';
import { badRequest, notFound } from '../http/errors';
import { revealGatewayToken } from '../gateway/token';
import type { TenantSettings } from '../domain/settings';
import type { ProviderService } from '../services/providers';

export interface AgentPlan {
  agentId: AgentId;
  provider: ProviderRecord;
  /** 写入客户端的模型标识（聚合别名） */
  clientModel: string;
  upstreamModel: string;
  gatewayBaseUrl: string;
  token: string;
  writes: Partial<Record<AgentFileRole, DesiredWrites[]>>;
  paths: Record<AgentFileRole, string | undefined>;
}

export class AgentService {
  private readonly resolver: AgentPathResolver;

  constructor(
    private readonly ctx: AppContext,
    private readonly repos: TenantRepos,
    private readonly providerService: ProviderService,
    resolver?: AgentPathResolver,
  ) {
    this.resolver = resolver ?? new AgentPathResolver(this.ctx.config.agentHomeDir);
  }

  list(): Array<{
    id: AgentId;
    name: string;
    description: string;
    applied: boolean;
    appliedAt?: string;
    appliedBy?: string;
  }> {
    const agents = this.repos.agents.read();
    return Object.values(AGENT_DEFINITIONS).map((definition) => {
      const binding = agents.bindings[definition.id];
      return {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        applied: Boolean(binding),
        appliedAt: binding?.appliedAt,
        appliedBy: binding?.appliedBy,
      };
    });
  }

  preview(principal: Principal, agentId: string): AgentPreview {
    const definition = getAgentDefinition(agentId);
    if (!definition) throw notFound(`未知 Agent: ${agentId}`);

    const plan = this.buildPlan(principal, definition.id as AgentId);
    const binding = this.repos.agents.getBinding(plan.agentId);

    const files: AgentFilePreview[] = definition.files.map((spec) => {
      const filePath = plan.paths[spec.role] ?? '';
      const content = readFileSafe(filePath);
      const writes = plan.writes[spec.role] ?? [];
      return {
        role: spec.role,
        path: filePath,
        exists: content !== null,
        entries: buildPreviewEntries(definition, spec.role, content, writes),
      };
    });

    return {
      agentId: plan.agentId,
      name: definition.name,
      applied: Boolean(binding),
      appliedAt: binding?.appliedAt,
      gatewayBaseUrl: plan.gatewayBaseUrl,
      files,
    };
  }

  apply(principal: Principal, agentId: string): AgentBindingState {
    const definition = getAgentDefinition(agentId);
    if (!definition) throw notFound(`未知 Agent: ${agentId}`);

    const plan = this.buildPlan(principal, definition.id as AgentId);
    const results = applyAgentWrites({
      agentId: plan.agentId,
      definition,
      paths: plan.paths,
      writes: plan.writes,
      backupsDir: this.ctx.paths.backupsDir(principal.tenantId, plan.agentId),
    });

    const files: WrittenFileSnapshot[] = results.map((item) => ({
      role: item.role,
      path: item.filePath,
      values: item.values,
      created: item.created,
    }));

    const binding: AgentBindingState = {
      agentId: plan.agentId,
      appliedAt: new Date().toISOString(),
      appliedBy: principal.userId,
      files,
    };
    this.repos.agents.setBinding(binding);
    return binding;
  }

  revert(agentId: string): {
    restored: string[];
    conflicts: Array<{ key: string; expected: string; current: string | null }>;
  } {
    const definition = getAgentDefinition(agentId);
    if (!definition) throw notFound(`未知 Agent: ${agentId}`);

    const binding = this.repos.agents.getBinding(definition.id as AgentId);
    if (!binding) throw badRequest(`Agent ${definition.name} 当前没有被接管，无需还原`);

    const result = revertAgentWrites(definition, binding.files);
    this.repos.agents.clearBinding(definition.id as AgentId);
    return result;
  }

  /** 构造某个 Agent 的目标写入内容。供应商与令牌缺失时给出可读错误。 */
  private buildPlan(principal: Principal, agentId: AgentId): AgentPlan {
    const settings = this.repos.settings.read();
    const providers = this.providerService.listRecords();
    // Codex 两种协议都能说：优先原生 Responses 上游，没有才回落 openai（此时 wire_api 必须写
    // chat，见下方 wire_api 的注释）。顺序不能反——先挑 openai 会把本可原生走的 Responses
    // 降级成 Chat 兼容形态。
    const provider =
      agentId === 'claude-code'
        ? pickProvider(providers, settings, ['anthropic'])
        : pickProvider(providers, settings, ['responses', 'openai']);
    const token = revealGatewayToken(settings.gatewayToken, this.ctx.secrets);
    if (!token) {
      throw badRequest('尚未生成网关令牌，请先在"模型聚合"页生成');
    }
    if (provider.models.length === 0) {
      throw badRequest(`供应商 ${provider.name} 未声明任何模型，请先在供应商页补充模型`);
    }

    const preferredModel =
      settings.defaultProviderId === provider.id && settings.defaultModel
        ? settings.defaultModel
        : provider.models[0];
    const upstreamModel = provider.models.includes(preferredModel)
      ? preferredModel
      : provider.models[0];
    const clientModel = `lmm-${provider.providerKey}/${upstreamModel}`;
    const gatewayBaseUrl = this.ctx.config.publicBaseUrl;
    const resolveInput = { tenantId: principal.tenantId, userId: principal.userId };
    const definition = AGENT_DEFINITIONS[agentId];

    const paths: Record<AgentFileRole, string | undefined> = {
      config: this.resolver.resolve(agentId, resolveInput, 'config'),
      auth: definition.files.some((item) => item.role === 'auth')
        ? this.resolver.resolve(agentId, resolveInput, 'auth')
        : undefined,
    };

    const writes: Partial<Record<AgentFileRole, DesiredWrites[]>> =
      agentId === 'codex'
        ? {
            config: [
              { path: 'model_provider', value: 'llmapi' },
              { path: 'model', value: clientModel },
              { path: 'name', value: 'LLM API Manager', table: 'model_providers.llmapi' },
              { path: 'base_url', value: `${gatewayBaseUrl}/v1`, table: 'model_providers.llmapi' },
              // wire_api 必须与所选供应商的 apiType 一致：Codex 按它决定打 /v1/responses 还是
              // /v1/chat/completions，两条路径都严格匹配协议。写成 responses 却选中 openai 供应商
              // （或反之）时，请求会被网关卡在 501，而 Codex 侧只表现为"模型不可用"。
              // openai 上游写 chat：省掉该键 Codex 也默认 chat，但显式写出来便于排查配置。
              {
                path: 'wire_api',
                value: provider.apiType === 'responses' ? 'responses' : 'chat',
                table: 'model_providers.llmapi',
              },
              {
                path: 'requires_openai_auth',
                value: 'true',
                table: 'model_providers.llmapi',
              },
            ],
            auth: [{ path: 'OPENAI_API_KEY', value: token }],
          }
        : {
            config: [
              { path: 'env.ANTHROPIC_BASE_URL', value: gatewayBaseUrl },
              { path: 'env.ANTHROPIC_AUTH_TOKEN', value: token },
              { path: 'env.ANTHROPIC_MODEL', value: clientModel },
            ],
          };

    return {
      agentId,
      provider,
      clientModel,
      upstreamModel,
      gatewayBaseUrl,
      token,
      writes,
      paths,
    };
  }
}

/**
 * 为 Agent 选择供应商。`apiTypes` 是有序的"可接受协议链"，靠前优先：
 * 1. 默认供应商协议在链里则优先命中；
 * 2. 否则按链的顺序，取每种协议里第一个启用的供应商（按 priority）；
 * 3. 链上一种都找不到就报错。
 *
 * 宁可报错也不要硬塞一个协议不匹配的供应商：Agent 会按供应商协议写 wire_api，
 * 塞错的直接后果是客户端发出的请求被网关 501，而用户只看到"模型不可用"。
 */
function pickProvider(
  providers: readonly ProviderRecord[],
  settings: TenantSettings,
  apiTypes: readonly ProviderRecord['apiType'][],
): ProviderRecord {
  // 外层按协议顺序、内层才看 priority：协议优先级高于优先级排序，
  // 否则一家 openai 供应商 priority 更小就能把 responses 供应商顶掉。
  for (const apiType of apiTypes) {
    const defaultProvider = providers.find((item) => item.id === settings.defaultProviderId);
    if (defaultProvider && defaultProvider.enabled && defaultProvider.apiType === apiType) {
      return defaultProvider;
    }
    const candidate = providers
      .filter((item) => item.enabled && item.apiType === apiType)
      .sort((a, b) => a.priority - b.priority)[0];
    if (candidate) return candidate;
  }
  const labels = apiTypes.map((item) => apiTypeLabel(item)).join(' 或 ');
  throw badRequest(`没有可用的 ${labels} 供应商，请先添加并启用`);
}

/** 供路由层展示备份目录，便于用户自己找历史文件。 */
export function backupsDirFor(ctx: AppContext, tenantId: string, agentId: AgentId): string {
  const dir = ctx.paths.backupsDir(tenantId, agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
