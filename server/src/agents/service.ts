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
import type { ProviderRecord } from '../domain/provider';
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
    const requiredApiType = agentId === 'claude-code' ? 'anthropic' : 'openai';
    const provider = pickProvider(providers, settings, requiredApiType);
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
              { path: 'wire_api', value: 'responses', table: 'model_providers.llmapi' },
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
 * 为 Agent 选择供应商：
 * 1. 默认供应商协议匹配则优先；
 * 2. 否则取第一个启用且协议匹配的供应商（按优先级）；
 * 3. 都没有时报错，而不是硬塞一个协议不匹配的供应商。
 */
function pickProvider(
  providers: readonly ProviderRecord[],
  settings: TenantSettings,
  apiType: ProviderRecord['apiType'],
): ProviderRecord {
  const defaultProvider = providers.find((item) => item.id === settings.defaultProviderId);
  if (defaultProvider && defaultProvider.enabled && defaultProvider.apiType === apiType) {
    return defaultProvider;
  }
  const candidate = providers
    .filter((item) => item.enabled && item.apiType === apiType)
    .sort((a, b) => a.priority - b.priority)[0];
  if (!candidate) {
    throw badRequest(
      `没有可用的 ${apiType === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'}供应商，请先添加并启用`,
    );
  }
  return candidate;
}

/** 供路由层展示备份目录，便于用户自己找历史文件。 */
export function backupsDirFor(ctx: AppContext, tenantId: string, agentId: AgentId): string {
  const dir = ctx.paths.backupsDir(tenantId, agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
