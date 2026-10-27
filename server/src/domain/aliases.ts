import type { ApiType, ModelCapability, ProviderRecord } from './provider';

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

export type AliasResolution =
  | { kind: 'alias'; alias: ModelAlias }
  | { kind: 'default'; upstreamModel: string }
  | { kind: 'invalid'; reason: string };

/**
 * 解析请求里的 model。
 * 关键约束：带 lam- 前缀但解析不出来时必须报错，绝不回落到默认供应商
 * —— 回落会用别的供应商额度、回答另一个模型，调用方看不出来。
 */
export function resolveModel(
  requested: string,
  providers: readonly ProviderRecord[],
): AliasResolution {
  if (!isAliasShape(requested)) {
    return { kind: 'default', upstreamModel: requested };
  }

  const separatorIndex = requested.indexOf(ALIAS_SEPARATOR, ALIAS_PREFIX.length);
  if (separatorIndex < 0) {
    return { kind: 'invalid', reason: `别名 ${requested} 缺少 "/" 分隔符` };
  }
  const providerKey = requested.slice(ALIAS_PREFIX.length, separatorIndex);
  const upstreamModel = requested.slice(separatorIndex + ALIAS_SEPARATOR.length);
  if (!providerKey || !upstreamModel) {
    return { kind: 'invalid', reason: `别名 ${requested} 格式不完整` };
  }

  const provider = providers.find((item) => item.providerKey === providerKey);
  if (!provider) {
    return { kind: 'invalid', reason: `未知供应商 key: ${providerKey}` };
  }
  if (!provider.enabled) {
    return { kind: 'invalid', reason: `供应商 ${provider.name} 已禁用` };
  }
  if (!provider.models.includes(upstreamModel)) {
    return {
      kind: 'invalid',
      reason: `供应商 ${provider.name} 未声明模型 ${upstreamModel}`,
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
