import { resolveModel } from '../domain/aliases';
import { requiredApiType, type GatewayPath } from './forward';
import { APPROVAL_REVIEW_MODEL_NAME, type TenantSettings } from '../domain/settings';
import type { ProviderRecord } from '../domain/provider';

/**
 * 候选供应商选择。
 *
 * 从 `routes/gateway.ts` 抽出来是为了让**调试接口复用同一份逻辑**。
 * 若诊断自己再算一遍，就会出现"诊断说会转换、实际没转换"这类最难查的问题——
 * 诊断结果与实际行为不一致，比没有诊断更糟。
 *
 * 纯函数：不读文件、不发请求，只根据入参算出"这次请求会走哪里"。
 */

export interface Candidate {
  provider: ProviderRecord;
  upstreamModel: string;
  /** 上游模型名是否被改写（别名解析、默认模型、审批占位名替换） */
  modelRewritten: boolean;
  /**
   * 需要把 Responses 请求转成 Chat 发给上游。
   * 只在 protocolConversion 打开、且路径要求 responses 而上游是 openai 时出现。
   */
  convertResponsesToChat: boolean;
  /** 命中的是哪条规则，供诊断接口解释"为什么选它" */
  reason?: CandidateReason;
}

/** 选出该候选所依据的规则。诊断接口据此说明原因，避免用户猜。 */
export type CandidateReason =
  | 'alias' // 别名明确指向（`lam-provider/model`）
  | 'default-provider' // 租户设置的默认供应商
  | 'approval-placeholder' // Codex 审批占位名被改写成用户配置的模型
  | 'priority'; // 按协议匹配优先、再按 priority 排序取第一

export type Selection =
  | {
      mode: 'alias' | 'default';
      primary: Candidate;
      fallbacks: Candidate[];
      /** 被排除的供应商及原因，诊断时能解释"为什么不是它" */
      excluded?: ExcludedProvider[];
    }
  | { mode: 'invalid'; reason: string; excluded?: ExcludedProvider[] };

export interface ExcludedProvider {
  providerId: string;
  providerName: string;
  reason: string;
}

/**
 * 该候选是否需要做 Responses → Chat 转换。
 *
 * 三个条件缺一不可：开关打开、路径要 responses、供应商是 openai。
 * 少写任何一条都会让"没开开关也转换"或"没有转换器也放行"，前者是静默改变用户语义，
 * 后者是把非法请求交给上游。
 */
export function needsConversion(
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

export function selectCandidates(
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
        reason: 'alias',
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

  // 被排除的供应商，供诊断接口解释"为什么不是它"。
  // 必须在"没有可用供应商"的早退之前算出来——那正是最需要解释原因的场景：
  // 用户看到"没有可用的 responses 供应商"，但界面上明明有几家供应商。
  const excluded: ExcludedProvider[] = providers
    .filter((item) => !usable.some((kept) => kept.id === item.id))
    .map((item) => ({
      providerId: item.id,
      providerName: item.name,
      reason: !item.enabled
        ? '已停用'
        : convertible
          ? `协议不匹配：需要 ${required}，它是 ${item.apiType}`
          : `协议不匹配：需要 ${required}，它是 ${item.apiType}（转换只支持 responses→chat，当前开关未开或方向不适用）`,
    }));

  if (usable.length === 0) {
    return {
      mode: 'invalid',
      reason: required
        ? `没有启用的 ${required} 供应商，请先在控制台添加并启用`
        : '没有启用的供应商，请先在控制台添加并启用',
      excluded,
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
        reason: 'approval-placeholder',
      },
      // 审批请求不做故障转移：换个供应商大概率没有同名模型，白白多打一次上游
      fallbacks: [],
      excluded,
    };
  }

  return {
    mode: 'default',
    primary: {
      provider: primaryProvider,
      upstreamModel: useDefaultModel ? (settings.defaultModel as string) : resolution.upstreamModel,
      modelRewritten: useDefaultModel,
      convertResponsesToChat: needsConversion(primaryProvider, path, settings),
      reason: defaultProvider !== undefined ? 'default-provider' : 'priority',
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
    excluded,
  };
}

/**
 * 请求是否来自 Codex 的「Approve for me」审批流程。
 *
 * Codex 在 `x-codex-turn-metadata` 里带 `turn_trigger: "guardian_review"`。
 * 解析失败一律当 false：这个头缺失或格式变化时宁可"不映射审批模型"，
 * 也不要因为解析异常去改写一个普通聊天请求的模型名。
 */
export function isApprovalReviewRequest(
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

