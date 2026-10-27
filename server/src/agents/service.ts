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
import { buildDirectModelCatalog, buildModelCatalog } from '../domain/modelCatalog';
import { APPROVAL_REVIEW_MODEL_NAME } from '../domain/settings';
import { findCodexClients, stopCodexProcesses } from './processes';
import { listAliases } from '../domain/aliases';
import { AgentPathResolver } from './registry';
import {
  applyAgentWrites,
  buildPreviewEntries,
  isSensitiveValueKey,
  maskPreviewSecret,
  readFileSafe,
  revertAgentWrites,
  type DesiredWrites,
} from './patch';
import { apiTypeLabel, type ProviderRecord } from '../domain/provider';
import { readTomlScalar } from './toml';
import { badRequest, notFound } from '../http/errors';
import { revealGatewayToken } from '../gateway/token';
import type { AgentConnectionMode, TenantSettings } from '../domain/settings';
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
   * 需要整份生成的模型目录文件内容（仅 Codex）。undefined 表示该 Agent 不产出目录
   * （Claude Code 没有这个文件）。**两种连接模式都生成**，只是条目不同：
   * 网关模式是别名，直连模式是上游裸模型名——直连不生成会被 Codex 回退到内置
   * 官方模型列表，`/model` 里冒出 GPT-6.x（真实踩过）。
   * 与 writes 分开：writes 是"按键打补丁"，目录是"整体覆盖"，语义不同。
   */
  catalogContent?: string;
  /** 本次写入用的是走网关还是直连上游 */
  connectionMode: AgentConnectionMode;
  /** 直连时实际写进 base_url 的上游地址（网关模式为 undefined），便于预览展示 */
  directBaseUrl?: string;
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
            plan.catalogContent !== undefined
              ? [
                  {
                    key: '（整份生成）',
                    current: content !== null ? '（将被覆盖，已自动备份）' : null,
                    next: `包含 ${modelCount} 个模型别名`,
                    differs: content !== plan.catalogContent,
                  },
                ]
              : // 没有 catalogContent 但文件已存在 = 该 Agent 不再需要这份目录
                // （或本模式不产出）。apply 会删掉它，这里必须如实说明，
                // 否则用户会以为它还在生效。
                content !== null
                ? [
                    {
                      key: '（整份生成）',
                      current: '（上一模式留下的目录，将被删除）',
                      next: '（删除）',
                      differs: true,
                    },
                  ]
                : [],
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
      connectionMode: plan.connectionMode,
      directBaseUrl: plan.directBaseUrl,
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
      // catalogContent 存在 → 覆盖写入；不存在但声明了 catalog 路径 → 删除。
      // 删除是必要的：上一模式/上一 Agent 留下的目录若不清理，Codex 会继续拿它
      // 当模型列表，而我们写的 model 名（裸名或新别名）跟它对不上。
      generatedFiles: plan.paths.catalog
        ? [
            {
              role: 'catalog' as AgentFileRole,
              path: plan.paths.catalog,
              content: plan.catalogContent,
            },
          ]
        : [],
    });

    const files: WrittenFileSnapshot[] = results.map((item) => ({
      role: item.role,
      path: item.filePath,
      values: item.values,
      created: item.created,
    }));

    // 写完配置后检查是否还有该 Agent 的进程在跑。
    // 真实踩过的坑：配置文件已更新，但某个几小时前启动的 codex 进程还在用内存里的
    // 旧凭据/旧地址，用户看到 401/404 会以为配置没生效。这里主动提醒重启。
    const runningProcesses =
      plan.agentId === 'codex' ? findCodexClients().length : 0;

    const binding: AgentBindingState = {
      agentId: plan.agentId,
      runningProcesses,
      appliedAt: new Date().toISOString(),
      appliedBy: principal.userId,
      files,
    };
    // 存储用真实值（revert 要比对"当前值是否仍等于我们写入的值"），
    // 但**接口响应必须脱敏**：直连模式下这里存的是上游真实 Key，
    // 原样返回等于把凭据经接口发出去（AGENTS.md 第 5 条的硬约束）。
    // 所以存储与返回分开：存原值，返回脱敏副本。
    this.repos.agents.setBinding(binding);
    return {
      ...binding,
      files: binding.files.map((file) => ({
        ...file,
        values: Object.fromEntries(
          Object.entries(file.values).map(([key, value]) =>
            isSensitiveValueKey(key) ? [key, maskPreviewSecret(value)] : [key, value],
          ),
        ),
      })),
    };
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
    // 上一次 apply 写进文件的值。**只为删除用**：像 stream_max_retries 这种
    // 可配置数值，清空时要知道"上次写的是几"才能安全地把它删掉
    // （removeTomlKeyIfValue 只在当前值仍等于 expected 时才删，
    // 传空串会永远匹配不上，键就残留了）。
    const previousBinding = this.repos.agents.getBinding(agentId);
    const previousValue = (role: AgentFileRole, key: string): string =>
      previousBinding?.files.find((file) => file.role === role)?.values[key] ?? '';

    // 模式按 Agent 各自读取：Codex 与 Claude Code 协议不同、用途也可能不同，
    // 一个全局开关会强迫两者同步切换，这是实际使用中不合理的。
    const target = settings.agentTargets?.[agentId];
    const direct = target?.mode === 'direct';
    // Codex CLI 的 wire_api 已被上游收窄到只支持 "responses"（见 openai/codex
    // discussion #7782，写 "chat" 会拒绝启动），所以 Codex 的候选协议恒为 responses，
    // 不能"回落到 openai 供应商写 chat"。协议不匹配时让用户去改供应商或开跨协议转发，
    // 而不是在这里偷偷换一种协议。
    const requiredTypes: readonly ProviderRecord['apiType'][] =
      agentId === 'claude-code' ? ['anthropic'] : ['responses'];

    // 直连模式优先用用户**明确指定**的供应商：多供应商时靠优先级自动挑一个，
    // 用户既不知道选了谁、也无法干预，等于失去控制权。
    const provider = direct
      ? pickDirectProvider(providers, target?.directProviderId, requiredTypes)
      : pickProvider(providers, settings, requiredTypes);

    const token = revealGatewayToken(settings.gatewayToken, this.ctx.secrets) ?? '';
    // 直连不需要网关令牌（用的是上游自己的 Key），只在网关模式下强制要求。
    if (!direct && !token) {
      throw badRequest('尚未生成网关令牌，请先在"模型聚合"页生成');
    }    if (provider.models.length === 0) {
      throw badRequest(`供应商 ${provider.name} 未声明任何模型，请先在供应商页补充模型`);
    }

    // 直连时若用户指定了模型就用它；否则沿用默认模型 / 第一个模型。
    const directModel = direct ? target?.directModel : null;
    const preferredModel = direct
      ? directModel && provider.models.includes(directModel)
        ? directModel
        : provider.models[0]
      : settings.defaultProviderId === provider.id && settings.defaultModel
        ? settings.defaultModel
        : provider.models[0];
    const upstreamModel = provider.models.includes(preferredModel)
      ? preferredModel
      : provider.models[0];
    const clientModel = `lam-${provider.providerKey}/${upstreamModel}`;
    const gatewayBaseUrl = this.ctx.config.publicBaseUrl;

    // 直连模式：把请求直接指向上游，配置写好后不依赖本服务是否在运行。
    // 与网关模式的三点差异（见下方 writes）：
    //   1. base_url 用上游地址，而不是 publicBaseUrl
    //   2. Key 用上游真实 Key，而不是网关令牌
    //   3. 模型用裸模型名，而不是 lam- 别名（别名只有网关认识）
    // 目录仍然要写，但条目是裸模型名——见下方 catalogContent 处「直连也必须生成」的说明。
    if (direct && provider.baseUrl.trim() === '') {
      throw badRequest(`供应商 ${provider.name} 没有配置 Base URL，无法直连`);
    }
    const upstreamBaseUrl = provider.baseUrl.trim().replace(/\/+$/, '');
    const plainKey = direct ? this.providerService.plainApiKey(provider) : '';
    if (direct && plainKey === '') {
      throw badRequest(`供应商 ${provider.name} 没有配置 API Key，无法直连`);
    }
    const effectiveModel = direct ? upstreamModel : clientModel;
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
    //
    // 两种模式都要生成，区别只在条目里的模型标识：
    // - 网关模式：全部别名（`lam-<key>/<model>`）
    // - 直连模式：该供应商自己的裸模型名
    //
    // 直连也必须生成，不能"不写就算了"：一旦没有 model_catalog_json，Codex 会回退到
    // **内置的官方模型列表**（models-manager 的 fallback_models），/model 里就会出现
    // GPT-6.x 这类与用户配置完全无关的条目。这个坑真实踩过。
    //
    // 直连时不按协议过滤：裸模型名直接打给那一家上游，中间没有网关的协议匹配，
    // 所以没有"列出来也用不了"的问题。
    const catalogPath = paths.catalog;
    // 用户在 Codex 里配的档位，用来决定目录条目的 default_reasoning_level。
    // 不读它就会出现"config.toml 写 high、/model 里显示 medium"的错位。
    // 读不到就返回 undefined，由目录回落中间档 —— 不能因为读配置失败就中断生成。
    const configuredEffort = readConfiguredEffort(paths.config);
    const catalogContent =
      agentId === 'codex' && catalogPath
        ? direct
          ? buildDirectModelCatalog(provider.models, provider.name, {
              preferredClientModel: upstreamModel,
              // 直连时 slug 就是上游裸名，能力表键与之一致。
              capabilities: provider.modelCapabilities,
              configuredEffort,
            })
          : buildModelCatalog(
              // 只列该 Agent 实际能用的协议。Codex 的 wire_api 固定是 responses，
              // 所以默认排除 openai 供应商——列进去用户选中后必然 501。
              //
              // 例外：开启跨协议转发后，网关会把 Responses 请求转成 Chat，
              // 这些供应商就真的能用了，必须列出来。否则用户开了开关却看不到
              // 对应模型，会以为功能没生效。
              listAliases(providers).filter(
                (item) =>
                  (requiredTypes as readonly string[]).includes(item.apiType) ||
                  (settings.protocolConversion && item.apiType === 'openai'),
              ),
              {
                preferredClientModel: clientModel,
                configuredEffort,
                // 仅网关模式：审批请求要经过网关才能被改写，直连时没有拦截点。
                // 不把这个占位名放进目录，Codex 会找不到它并**静默回退到父模型**，
                // 于是"配了审批模型却不生效"，且日志里看不到任何审批请求。
                approvalPlaceholder:
                  settings.approvalReviewModel !== null &&
                  settings.approvalReviewModel !== ''
                    ? APPROVAL_REVIEW_MODEL_NAME
                    : undefined,
              },
            )
        : undefined;

    const writes: Partial<Record<AgentFileRole, DesiredWrites[]>> =
      agentId === 'codex'
        ? {
            config: [
              { path: 'model_provider', value: 'llmapi' },
              // 直连用裸模型名：lam- 别名只有本服务的网关认识。
              { path: 'model', value: effectiveModel },
              // model_catalog_json 是 ConfigToml 的**顶层**键，不能放进 [model_providers.llmapi]：
              // 它不在 ModelProviderInfo 的字段里，放进 provider 段会被 serde 当未知字段丢弃，
              // Codex 只会打一条 "`model_providers.llmapi.model_catalog_json` is ignored" 告警。
              // 它指向我们生成的本地目录，有了它 Codex 就直接用静态目录、不再拉远程列表。
              // 两种模式都指向同一份本地目录（内容不同，见 catalogContent 处说明）。
              ...(paths.catalog ? [{ path: 'model_catalog_json', value: paths.catalog }] : []),
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
              {
                path: 'base_url',
                // 与转发路径同一套规则：baseUrl 自带 /v1 时不再重复拼接。
                // 直接拼 `${base}/v1` 会让「已经含 /v1」的上游变成 /v1/v1，
                // Codex 拿到 404（有些上游的 baseUrl 就带 /v1，实测过这种写法）。
                value: direct ? withV1(upstreamBaseUrl) : `${gatewayBaseUrl}/v1`,
                table: 'model_providers.llmapi',
              },
              // model_catalog_url 是 ModelProviderInfo 的 provider 级字段，指向网关的
              // /v1/models。注意它只在没有 model_catalog_json 时才生效——顶层静态目录
              // 优先级更高。两者都写是为了让"配置文件读起来能看出网关地址"，
              // 实际生效的是上面那份 model_catalog_json。
              direct
                ? // 直连不经过网关，这个 URL 指向网关会误导；删除而非留旧值。
                  // 模型列表此时由上面的本地目录提供。
                  { path: 'model_catalog_url', value: `${gatewayBaseUrl}/v1/models`,
                    table: 'model_providers.llmapi', remove: true }
                : { path: 'model_catalog_url', value: `${gatewayBaseUrl}/v1/models`,
                    table: 'model_providers.llmapi' },
              // Codex 只接受 wire_api = "responses"（"chat" 已在其新版本中被移除），
              // 所以这里恒写 responses，即便供应商是 openai 类型也不改——那种组合下
              // 由网关（protocolConversion）把 Responses 请求转成 Chat，客户端仍按
              // Responses 说话。若这里跟着供应商改成 chat，Codex 会直接拒绝启动。
              { path: 'wire_api', value: 'responses', table: 'model_providers.llmapi' },
              // 布尔 true 必须原样写入：写成字符串 "true" 在 TOML 里不是布尔，Codex 会判类型不符。
              {
                path: 'requires_openai_auth',
                value: 'true',
                raw: true,
                table: 'model_providers.llmapi',
              },
              // 流式重连次数与空闲超时。这两项都是 ModelProviderInfo 里的 u64 字段，
              // 同样是 raw（不加引号）——写成 "10" 在 TOML 里是字符串，Codex 判类型不符。
              //
              // 设置值为 null 时必须发**删除**指令而不是"不写"：这两个键很可能已经被
              // 上一次 apply（或用户手工）写进文件，只"不写"会把它留在原地，
              // 界面显示"未设置"但文件里仍生效，是最难排查的一类不一致。
              // 删除只在当前值仍等于我们写入值时执行，用户手改过的值会保留。
              ...(settings.codexStreamMaxRetries !== null
                ? [
                    {
                      path: 'stream_max_retries',
                      value: String(settings.codexStreamMaxRetries),
                      raw: true,
                      table: 'model_providers.llmapi',
                    },
                  ]
                : [
                    {
                      path: 'stream_max_retries',
                      // 删除时用**上次实际写入的值**作比对基准（取自绑定快照）。
                      // 传空串会永远匹配不上，键就残留了——那正是"界面显示未设置、
                      // 文件里仍生效"的来源。用户若手改过该值，比对不上会保留他的改动。
                      value: previousValue('config', '[model_providers.llmapi] stream_max_retries'),
                      raw: true,
                      table: 'model_providers.llmapi',
                      remove: true,
                    },
                  ]),
              ...(settings.codexStreamIdleTimeoutMs !== null
                ? [
                    {
                      path: 'stream_idle_timeout_ms',
                      value: String(settings.codexStreamIdleTimeoutMs),
                      raw: true,
                      table: 'model_providers.llmapi',
                    },
                  ]
                : [
                    {
                      path: 'stream_idle_timeout_ms',
                      value: previousValue(
                        'config',
                        '[model_providers.llmapi] stream_idle_timeout_ms',
                      ),
                      raw: true,
                      table: 'model_providers.llmapi',
                      remove: true,
                    },
                  ]),
            ],
            // 直连写上游真实 Key；网关模式写网关令牌。
            auth: [{ path: 'OPENAI_API_KEY', value: direct ? plainKey : token }],
          }
        : {
            // Claude Code 同样支持直连：换成上游地址、上游 Key 与裸模型名。
            config: [
              {
                path: 'env.ANTHROPIC_BASE_URL',
                value: direct ? upstreamBaseUrl : gatewayBaseUrl,
              },
              {
                path: 'env.ANTHROPIC_AUTH_TOKEN',
                value: direct ? plainKey : token,
              },
              { path: 'env.ANTHROPIC_MODEL', value: effectiveModel },
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
      // 预览要据此告诉用户"这份配置是走网关还是直连上游"，
      // 否则两个模式写出的文件看起来都像"某个 base_url + 某个 Key"，难以分辨。
      connectionMode: direct ? 'direct' : 'gateway',
      // 展示实际写进 base_url 的值（Codex 会补 /v1），避免预览与文件不一致。
      directBaseUrl: direct
        ? agentId === 'codex'
          ? withV1(upstreamBaseUrl)
          : upstreamBaseUrl
        : undefined,
    };
  }
}

/**
 * 给上游 baseUrl 补上 `/v1` 后缀，但**已经以 /v1 结尾时不再重复添加**。
 *
 * 与 `modelsUrlOf`（services/connectivity.ts）和网关转发路径保持同一套规则：
 * 用户填 `https://x.com` 与 `https://x.com/v1` 都是常见的正确写法，
 * 无脑拼 `/v1` 会把后者变成 `/v1/v1`，请求直接 404。
 */
function withV1(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * 直连模式下选定供应商。
 *
 * 与 pickProvider 的区别：这里**优先用户明确指定的那家**，而不是按优先级自动挑。
 * 多供应商场景下自动挑的问题不是"挑错"（优先级高的通常也对），而是用户既看不到
 * 选了谁、也无法干预——直连会把这家供应商的地址和 Key 写进配置，选错了很难发现。
 */
function pickDirectProvider(
  providers: readonly ProviderRecord[],
  providerId: string | null | undefined,
  apiTypes: readonly ProviderRecord['apiType'][],
): ProviderRecord {
  const labels = apiTypes.map((item) => apiTypeLabel(item)).join(' 或 ');

  if (providerId) {
    const chosen = providers.find((item) => item.id === providerId);
    if (!chosen) throw badRequest('指定的直连供应商不存在，请重新选择');
    if (!chosen.enabled) {
      throw badRequest(`指定的直连供应商「${chosen.name}」已被停用，请重新选择或先启用它`);
    }
    if (!apiTypes.includes(chosen.apiType)) {
      throw badRequest(
        `供应商「${chosen.name}」的协议类型不适用于该 Agent，需要 ${labels}`,
      );
    }
    return chosen;
  }

  // 没指定就退回自动挑选：先找有没有协议匹配的启用供应商，只用来把错误信息说具体
  // （"一家都没有"vs"有但你没选"）。两种情况最后都报错、不会真的返回它——
  // 直连必须由用户明确指定，否则就等于替他挑了某家的地址与 Key。
  const candidate = providers
    .filter((item) => item.enabled && apiTypes.includes(item.apiType))
    .sort((a, b) => a.priority - b.priority)[0];
  if (!candidate) throw badRequest(`没有可用的 ${labels} 供应商，请先添加并启用`);

  throw badRequest(
    `直连模式需要明确指定供应商：请在该 Agent 的配置里选择一家${labels}供应商`,
  );
}

/**
 * 走网关时选供应商。`apiTypes` 是有序的"可接受协议链"，靠前优先：
 * 1. 默认供应商协议在链里则优先命中；
 * 2. 否则按链的顺序，取每种协议里第一个启用的供应商（按 priority）；
 * 3. 链上一种都找不到就报错。
 *
 * 宁可报错也不要硬塞一个协议不匹配的供应商。协议不再体现为可变配置：Codex 恒写
 * `wire_api = "responses"`、Claude Code 恒写 Anthropic env 段，选错协议的后果不是
 * "配置写错"，而是配置看起来完全正常、请求却被网关 501，用户只看得到"模型不可用"。
 *
 * 与 pickDirectProvider 的分工：这里可以按 priority 自动挑（用户仍能在网关侧换供应商），
 * 直连则必须由用户明确指定（那会把某家的地址与 Key 钉进配置文件）。
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

/**
 * 读用户 Codex 配置里的推理档位（`model_reasoning_effort`）。
 *
 * 用途仅限目录条目的 `default_reasoning_level`：让 `/model` 里显示的初始档位与用户
 * 实际配置一致。读不到（没有配置文件、文件损坏、没配这个键）时返回 undefined，
 * 由目录回落中间档 —— 读配置失败绝不能中断配置生成。
 *
 * 用 `readTomlScalar` 而不是正则抠文本：它按表分段解析，不会把
 * `[tui]` 段里同名的键误当成顶层键。
 */
function readConfiguredEffort(configPath: string | undefined): string | undefined {
  if (!configPath) return undefined;
  const content = readFileSafe(configPath);
  if (content === null) return undefined;
  const value = readTomlScalar(content, 'model_reasoning_effort');
  return value === null || value.trim() === '' ? undefined : value.trim().toLowerCase();
}
