import type { ApiType, ModelCapability, ProviderRecord } from './provider';
import type { MessageKey, MessageParams } from '../i18n';
import { renderZh } from '../i18n/render';

/**
 * 别名前缀：`lam-<providerKey>/<model>` 是"明确指向某一家"的写法。
 * resolveModel 只看这个前缀决定走别名还是默认供应商，因此它必须足够独特，
 * 避免与上游真实模型名撞车。
 */
export const ALIAS_PREFIX = 'lam-';
export const ALIAS_SEPARATOR = '/';

export interface ModelAlias {
  alias: string;
  providerId: string;
  providerKey: string;
  providerName: string;
  apiType: ApiType;
  upstreamModel: string;
  /**
   * 这家供应商声明的该模型能力（上下文窗口 / 输出上限），透传自 ProviderRecord。
   *
   * 为什么挂在别名上而不是按 `upstreamModel` 反查：同一个裸模型名可能被多家
   * 供应商声明，而各家的上下文与输出上限并不相同（本地实测 `gpt-6-luna` 就同时
   * 属于 openai 与 responses 两家）。按名字反查会拿到"某一家的值"，
   * 与别名"明确指向某一家"的语义冲突。缺省表示未知，由目录回落保守默认值。
   */
  capability?: ModelCapability;
}

export function buildAlias(providerKey: string, model: string): string {
  return `${ALIAS_PREFIX}${providerKey}${ALIAS_SEPARATOR}${model}`;
}

export function isAliasShape(model: string): boolean {
  return model.startsWith(ALIAS_PREFIX);
}

/** 聚合已启用供应商的模型。禁用供应商不发布任何别名。 */
export function listAliases(providers: readonly ProviderRecord[]): ModelAlias[] {
  const out: ModelAlias[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      const alias = buildAlias(provider.providerKey, model);
      if (seen.has(alias)) continue;
      seen.add(alias);
      out.push({
        alias,
        providerId: provider.id,
        providerKey: provider.providerKey,
        providerName: provider.name,
        apiType: provider.apiType,
        upstreamModel: model,
        capability: provider.modelCapabilities?.[model],
      });
    }
  }
  return out;
}

/**
 * 解析失败的原因。
 *
 * 存"键 + 参数"而不是成品字符串：同一处失败要能按请求语言渲染。
 * `reason` 仍是中文渲染结果——网关响应、诊断接口与测试都在直接读它，
 * 删掉它会让这些调用方改成两段式取值，收益低于成本。
 * 需要英文时用 `reasonKey` + `reasonParams` 自行 `translate()`。
 */
export type AliasInvalidReason = {
  reason: string;
  reasonKey: MessageKey;
  reasonParams?: MessageParams;
};

export type AliasResolution =
  | { kind: 'alias'; alias: ModelAlias }
  | { kind: 'default'; upstreamModel: string }
  | ({ kind: 'invalid' } & AliasInvalidReason);

/**
 * 构造一条解析失败原因：同时给出键与中文渲染结果。
 *
 * 这里**不调用 `translate()`** 而是从字典直接取值：`domain/` 是纯领域层，
 * 不该依赖"字典是否已被 `createContext` 装载"这种运行时状态——否则单测里
 * 直接调 `resolveModel` 会拿到键名而不是文案。
 */
function invalid(key: MessageKey, params?: MessageParams): AliasInvalidReason {
  return { reason: renderZh(key, params), reasonKey: key, reasonParams: params };
}

/**
 * 别名解析的可选项。
 *
 * `imagePath`：本次请求走的是 `/v1/images/*`。此时该供应商必须把模型登记在
 * **`imageModels`** 里——`models` 是对话模型，拿它去打 Images 端点必然被上游拒绝。
 * 分开判断才能给出"该模型在对话列表里、但不在生图列表里"这种可操作的报错，
 * 而不是笼统的"未声明模型"（用户会去 `models` 里找，那儿明明有）。
 */
export interface ResolveModelOptions {
  imagePath?: boolean;
}

/**
 * 解析请求里的 model。
 * 关键约束：带 lam- 前缀但解析不出来时必须报错，绝不回落到默认供应商
 * —— 回落会用别的供应商额度、回答另一个模型，调用方看不出来。
 */
export function resolveModel(
  requested: string,
  providers: readonly ProviderRecord[],
  options: ResolveModelOptions = {},
): AliasResolution {
  if (!isAliasShape(requested)) {
    return { kind: 'default', upstreamModel: requested };
  }

  const separatorIndex = requested.indexOf(ALIAS_SEPARATOR, ALIAS_PREFIX.length);
  if (separatorIndex < 0) {
    return { kind: 'invalid', ...invalid('gateway.alias.missingSeparator', { alias: requested }) };
  }
  const providerKey = requested.slice(ALIAS_PREFIX.length, separatorIndex);
  const upstreamModel = requested.slice(separatorIndex + ALIAS_SEPARATOR.length);
  if (!providerKey || !upstreamModel) {
    return { kind: 'invalid', ...invalid('gateway.alias.incomplete', { alias: requested }) };
  }

  const provider = providers.find((item) => item.providerKey === providerKey);
  if (!provider) {
    return { kind: 'invalid', ...invalid('gateway.alias.unknownProvider', { key: providerKey }) };
  }
  if (!provider.enabled) {
    return {
      kind: 'invalid',
      ...invalid('gateway.alias.providerDisabled', { name: provider.name }),
    };
  }

  // 生图与对话的模型清单是分开的两份，别名也按路径查对应的那份。
  if (options.imagePath === true) {
    const imageModels = provider.imageModels ?? [];
    if (!imageModels.includes(upstreamModel)) {
      // 分两种报错：在对话列表里 → 提示挪到生图列表；两边都没有 → 常规"未声明"。
      // 合成一句"未声明模型"会让用户在 models 里找到它，然后怀疑功能坏了。
      if (provider.models.includes(upstreamModel)) {
        return {
          kind: 'invalid',
          ...invalid('gateway.alias.modelIsNotImageModel', {
            name: provider.name,
            model: upstreamModel,
          }),
        };
      }
      return {
        kind: 'invalid',
        ...invalid('gateway.alias.modelNotDeclared', {
          name: provider.name,
          model: upstreamModel,
        }),
      };
    }
  } else if (!provider.models.includes(upstreamModel)) {
    return {
      kind: 'invalid',
      ...invalid('gateway.alias.modelNotDeclared', {
        name: provider.name,
        model: upstreamModel,
      }),
    };
  }

  return {
    kind: 'alias',
    alias: {
      alias: requested,
      providerId: provider.id,
      providerKey,
      providerName: provider.name,
      apiType: provider.apiType,
      upstreamModel,
    },
  };
}
