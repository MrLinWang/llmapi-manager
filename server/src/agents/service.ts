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
import { buildModelCatalog } from '../domain/modelCatalog';
import { stopCodexProcesses } from './processes';
import { listAliases } from '../domain/aliases';
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
  /**
   * 需要整份生成的模型目录文件内容（仅 Codex）。undefined 表示该 Agent 不需要。
   * 与 writes 分开：writes 是"按键打补丁"，目录是"整体覆盖"，语义不同。
   */
  catalogContent?: string;
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

      // 生成类文件（Codex 模型目录）没有"按键写入"，内容整体由我们产出。
      // 不单独给出一条预览的话，面板会显示"该文件无需写入"，看起来像什么都没做。
      if (spec.generated) {
        const modelCount = plan.catalogContent
          ? (JSON.parse(plan.catalogContent) as { models: unknown[] }).models.length
          : 0;
        return {
          role: spec.role,
          path: filePath,
          exists: content !== null,
          entries:
            plan.catalogContent === undefined
              ? []
              : [
                  {
                    key: '（整份生成）',
                    current: content !== null ? '（将被覆盖，已自动备份）' : null,
                    next: `包含 ${modelCount} 个模型别名`,
                    differs: content !== plan.catalogContent,
                  },
                ],
        };
      }

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
      generatedFiles:
        plan.catalogContent && plan.paths.catalog
          ? [{ role: 'catalog' as AgentFileRole, path: plan.paths.catalog, content: plan.catalogContent }]
          : [],
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

  /**
   * 结束本机正在运行的该 Agent 进程，让它在下次启动时重新读取配置。
   *
   * Codex 只在启动时加载配置与模型目录，改完配置不重启会让用户看到旧的 `/model` 列表。
   */
  async stopProcesses(
    // 结束的是本机进程：它不属于某个登录用户，所有管理员共享同一台机器，
    // 因此 principal 只用于统一的鉴权签名，不参与判断。
    _principal: Principal,
    agentId: string,
  ): Promise<{ actions: string[]; killed: number; warnings: string[]; supported: boolean }> {
    const definition = getAgentDefinition(agentId);
    if (!definition) throw notFound(`未知 Agent: ${agentId}`);

    // Claude Code 没有常驻守护进程，也不缓存模型列表，不做进程操作。
    if (definition.id !== 'codex') {
      return {
        actions: [],
        killed: 0,
        warnings: [`${definition.name} 没有需要结束的常驻进程`],
        supported: false,
      };
    }

    const result = await stopCodexProcesses(this.ctx.config.agentHomeDir);
    const actions = [...result.actions];
    // 一个进程都没探测到也要说清楚，否则前端只能靠 actions 是否为空去推断，
    // 用户看到"什么都没发生"会怀疑按钮坏了。
    if (result.found.length === 0 && result.killed.length === 0 && actions.length === 0) {
      actions.push('本机没有正在运行的 Codex 进程');
    }
    return {
      actions,
      killed: result.killed.length,
      warnings: result.warnings,
      supported: true,
    };
  }

  /** 构造某个 Agent 的目标写入内容。供应商与令牌缺失时给出可读错误。 */
  private buildPlan(principal: Principal, agentId: AgentId): AgentPlan {
    const settings = this.repos.settings.read();
    const providers = this.providerService.listRecords();
    // Codex CLI 新版只支持 Responses 协议：wire_api = "chat" 已被移除
    // （见 openai/codex discussion #7782），因此只能选 responses 供应商。
    // 不能回落到 openai 供应商：那样会写出 responses 配置、却被网关的严格协议匹配 501。
    const provider =
      agentId === 'claude-code'
        ? pickProvider(providers, settings, ['anthropic'])
        : pickProvider(providers, settings, ['responses']);
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
    const clientModel = `lam-${provider.providerKey}/${upstreamModel}`;
    const gatewayBaseUrl = this.ctx.config.publicBaseUrl;
    const resolveInput = { tenantId: principal.tenantId, userId: principal.userId };
    const definition = AGENT_DEFINITIONS[agentId];

    const hasRole = (role: AgentFileRole): boolean =>
      definition.files.some((item) => item.role === role);

    const paths: Record<AgentFileRole, string | undefined> = {
      config: this.resolver.resolve(agentId, resolveInput, 'config'),
      auth: hasRole('auth') ? this.resolver.resolve(agentId, resolveInput, 'auth') : undefined,
      catalog: hasRole('catalog')
        ? this.resolver.resolve(agentId, resolveInput, 'catalog')
        : undefined,
    };

    // 模型切换列表来自 model_catalog_json 指向的本地静态目录（格式见 domain/modelCatalog）。
    // 内容 = 网关当前发布的全部别名，当前选中的默认模型排在最前面。
    const catalogPath = paths.catalog;
    const catalogContent =
      agentId === 'codex' && catalogPath
        ? buildModelCatalog(listAliases(providers), { preferredClientModel: clientModel })
        : undefined;

    const writes: Partial<Record<AgentFileRole, DesiredWrites[]>> =
      agentId === 'codex'
        ? {
            config: [
              { path: 'model_provider', value: 'llmapi' },
              { path: 'model', value: clientModel },
              // model_catalog_json 是 ConfigToml 的**顶层**键，不能放进 [model_providers.llmapi]：
              // 它不在 ModelProviderInfo 的字段里，放进 provider 段会被 serde 当未知字段丢弃，
              // Codex 只会打一条 "`model_providers.llmapi.model_catalog_json` is ignored" 告警。
              // 它指向我们生成的本地目录，有了它 Codex 就直接用静态目录、不再拉远程列表。
              ...(paths.catalog
                ? [{ path: 'model_catalog_json', value: paths.catalog }]
                : []),
              // web_search 是否关闭由设置项决定。
              //
              // 它属于 Responses 协议的"托管工具"，多数聚合上游把 Responses 请求转成
              // Chat 线路时不支持，会直接 400：
              //   [code=unsupported_tool] unsupported Responses tool type "web_search"
              // 表现为"换了个模型就报错"，而根因是工具而非模型。
              //
              // 但直连官方、支持托管工具的供应商希望保留联网搜索，所以做成开关。
              //
              // 关闭时写 `web_search = "disabled"`；开启时发出**删除**指令：上一版可能
              // 已经写过这一行，不删就会残留，用户会以为开关没生效。删除只在当前值
              // 仍是 "disabled" 时执行，被用户改过的值保留。
              settings.disableCodexWebSearch
                ? { path: 'web_search', value: 'disabled' }
                : { path: 'web_search', value: 'disabled', remove: true },
              { path: 'name', value: 'LLM API Manager', table: 'model_providers.llmapi' },
              { path: 'base_url', value: `${gatewayBaseUrl}/v1`, table: 'model_providers.llmapi' },
              // model_catalog_url 是 ModelProviderInfo 的 provider 级字段，指向网关的
              // /v1/models。注意它只在没有 model_catalog_json 时才生效——顶层静态目录
              // 优先级更高。两者都写是为了让"配置文件读起来能看出网关地址"，
              // 实际生效的是上面那份 model_catalog_json。
              { path: 'model_catalog_url', value: `${gatewayBaseUrl}/v1/models`,
                table: 'model_providers.llmapi' },
              // Codex 只接受 wire_api = "responses"（"chat" 已在其新版本中被移除）。
              // 不再按供应商协议二选一：选路阶段已保证供应商是 responses 类型。
              { path: 'wire_api', value: 'responses', table: 'model_providers.llmapi' },
              // 布尔 true 必须原样写入：写成字符串 "true" 在 TOML 里不是布尔，Codex 会判类型不符。
              {
                path: 'requires_openai_auth',
                value: 'true',
                raw: true,
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
      catalogContent,
    };
  }
}

/**
 * 为 Agent 选择供应商。`apiTypes` 是有序的"可接受协议链"，靠前优先：
 * 1. 默认供应商协议在链里则优先命中；
 * 2. 否则按链的顺序，取每种协议里第一个启用的供应商（按 priority）；
 * 3. 链上一种都找不到就报错。
 *
 * 宁可报错也不要硬塞一个协议不匹配的供应商。协议不再体现为可变配置：Codex 恒写
 * `wire_api = "responses"`、Claude Code 恒写 Anthropic env 段，所以在 buildPlan 里
 * 选错协议的后果不是"配置写错"，而是配置看起来完全正常、请求却打到与供应商协议
 * 不匹配的网关路径被 501，用户只看得到"模型不可用"。
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
  const hint =
    apiTypes.length === 1 && apiTypes[0] === 'responses'
      ? '。Codex CLI 只支持 Responses 协议：请把某个供应商的协议类型改为「OpenAI 兼容（Responses）」，或新增一个 responses 供应商'
      : '';
  throw badRequest(`没有可用的 ${labels} 供应商，请先添加并启用${hint}`);
}

/** 供路由层展示备份目录，便于用户自己找历史文件。 */
export function backupsDirFor(ctx: AppContext, tenantId: string, agentId: AgentId): string {
  const dir = ctx.paths.backupsDir(tenantId, agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
