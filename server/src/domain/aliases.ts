import type { ApiType, ProviderRecord } from './provider';

export const ALIAS_PREFIX = 'lmm-';
export const ALIAS_SEPARATOR = '/';

export interface ModelAlias {
  alias: string;
  providerId: string;
  providerKey: string;
  providerName: string;
  apiType: ApiType;
  upstreamModel: string;
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
 * 关键约束：带 lmm- 前缀但解析不出来时必须报错，绝不回落到默认供应商
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
