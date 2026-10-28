import type { UiLanguage } from '../domain/settings';
import {
  CODEX_REASONING_EFFORTS,
  filterReasoningEfforts,
  type ModelCapability,
  type ProviderRecord,
} from '../domain/provider';
import { translate } from '../i18n';

/**
 * 逐档实测：真的向上游发请求，确认某个 model + reasoning effort 组合是否被接受。
 *
 * 为什么需要它：模型目录里的 `supported_reasoning_levels` 只能来自
 * `modelCapabilities[model].reasoningEfforts`。上游 `/models` 通常不带这个信息
 * （实测聚合上游只给 context/output），公开数据源又经常缺档位或给空数组
 * （modelinfo.dev 对 glm-5.3-flash / kimi-k2.7-code 就是 `supported=true, efforts=[]`）。
 * 靠猜就会写出上游不认的档位，用户一选就 400。唯一能确认的办法是逐档打一次。
 *
 * 设计取舍：
 * - **只发极小请求**：Responses 方向把 `max_output_tokens` 压到 16；Chat 方向不传
 *   max token（`max_tokens` / `max_completion_tokens` 的支持面各家不同，传错会让
 *   "档位被拒"与"参数不被认"混在一起），靠 `hi` 这种输入把输出量控制住。
 * - **并发 4**：一个 12 模型的供应商是 12 × 9 = 108 次请求，串行太慢、全并发容易
 *   被上游限流。并发数写死在这里，不暴露成设置项。
 * - **单请求 20s 超时**：超时按"该档位不可用"处理，但会把原因带回结果，不会静默吞掉。
 * - 失败**不抛异常**：一个档位失败不该让整个接口 500；由调用方决定怎么展示。
 * - **进度回调**：一次探测可能是上百个请求、几十秒，`onProgress` 每完成一个就报一次，
 *   路由把它转成 NDJSON 流推给前端画进度条。没有它，用户只能看着界面不动，
 *   分不清"在跑"还是"卡死"。
 *
 * 与 CLI 的关系：`scripts/sync-model-registry.ts` 的 `--verify-efforts` 以前在这里
 * 也有一份单独的探测实现，两处必须共用 `probeEffort()`，否则"CLI 说支持、网页说
 * 不支持"这种分叉又会出现。
 *
 * 与转发的关系：这里的请求**不经过**网关（不占网关选路、不写请求日志），
 * 直接按供应商的 `baseUrl` 打上游——探测的是"这家上游接不接受这个档位"，
 * 与网关的路由策略无关。
 */

/** 单次探测请求的上限；超过就当作该档位不可用。 */
const REQUEST_TIMEOUT_MS = 20_000;
/** 并发探测数。写死：见文件头注释，不暴露成设置项。 */
const PROBE_CONCURRENCY = 4;
/** 错误详情截断长度：它会被原样放进接口响应并显示在界面上。 */
const MAX_ERROR_SNIPPET = 160;

export interface EffortProbeTarget {
  apiType: ProviderRecord['apiType'];
  baseUrl: string;
  apiKey: string;
}

/**
 * 候选档位：Codex 认识的全部档位，按强度升序。
 *
 * 对外导出是为了让路由在开流之前就知道 `total`（进度条的分母），
 * 与 `probeProviderEfforts` 内部使用的默认值保持同一份。
 */
export const EFFORT_PROBE_CANDIDATES: readonly string[] = filterReasoningEfforts(
  CODEX_REASONING_EFFORTS,
);

export interface EffortProbeProgress {
  /** 已完成的请求数（不是"正在进行的第几个"） */
  done: number;
  total: number;
  model: string;
  effort: string;
  accepted: boolean;
}

export interface EffortProbeModelResult {
  model: string;
  /** 上游接受、并按强度升序排好的档位 */
  accepted: string[];
  rejected: string[];
  /** 全部档位都失败时的第一条原因（HTTP 状态或网络错误），成功时不填 */
  error?: string;
}

export interface EffortProbeOutcome {
  /** 本次实际探测的候选档位（顺序即 CODEX_REASONING_EFFORTS） */
  candidates: string[];
  /** 每个模型一行结果，顺序与 record.models 一致 */
  models: EffortProbeModelResult[];
  /** 需要写回 `provider.modelCapabilities` 的条目：只包含探测出档位的模型 */
  capabilities: Record<string, ModelCapability>;
}

interface EffortAttempt {
  accepted: boolean;
  error?: string;
}

function trimSnippet(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > MAX_ERROR_SNIPPET
    ? `${compact.slice(0, MAX_ERROR_SNIPPET)}…`
    : compact;
}

/**
 * 上游接口地址：与转发/拉模型列表同一套规则——baseUrl 自带 `/v1` 时不重复拼。
 * 重复拼会打到 `/v1/v1/...`，上游回 404，探测结果就全成了"不可用"。
 */
function endpoint(target: EffortProbeTarget, path: string): string {
  const base = target.baseUrl.trim().replace(/\/+$/, '');
  return `${base}${/\/v1$/i.test(base) ? '' : '/v1'}${path}`;
}

function authHeaders(target: EffortProbeTarget): Record<string, string> {
  // 与 connectivity.ts 同一分组：openai / responses 共用 Bearer，只有 anthropic 用 x-api-key。
  // anthropic 在路由层就被拒绝（Messages 没有 reasoning effort 概念），这里是兜底。
  if (target.apiType === 'anthropic') {
    return { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' };
  }
  return { authorization: `Bearer ${target.apiKey}` };
}

/** 按协议构造探测请求。`effort` 是所有候选档位里的一个值。 */
function probeRequest(
  target: EffortProbeTarget,
  model: string,
  effort: string,
): { url: string; body: Record<string, unknown> } {
  if (target.apiType === 'openai') {
    return {
      url: endpoint(target, '/chat/completions'),
      body: {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: effort,
        stream: false,
      },
    };
  }
  // responses（Codex 原生方向）：与 Codex 发出的形状一致，reasoning.effort 是判定对象。
  return {
    url: endpoint(target, '/responses'),
    body: {
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      reasoning: { effort },
      max_output_tokens: 16,
      store: false,
    },
  };
}

/**
 * 探测单个档位是否被上游接受（2xx 即接受）。
 *
 * 只发一次、不重试：探测的目的是"让上游自己回答"，重试会把超时/限流拖成数倍时长，
 * 而且重试成功也说明不了这个档位就稳定可用。
 */
export async function probeEffort(
  target: EffortProbeTarget,
  model: string,
  effort: string,
  language: UiLanguage = 'zh',
): Promise<EffortAttempt> {
  const { url, body } = probeRequest(target, model, effort);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(target) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // 必须消费响应体：不读会让连接保持占用，108 个请求很容易把连接池拖干。
    const text = await response.text();
    if (response.ok) return { accepted: true };
    return {
      accepted: false,
      error: `HTTP ${response.status}: ${trimSnippet(text) || response.statusText}`,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? translate(language, 'providers.test.timeout', { seconds: REQUEST_TIMEOUT_MS / 1000 })
        : error instanceof Error
          ? error.message
          : String(error);
    return { accepted: false, error: trimSnippet(message) };
  } finally {
    clearTimeout(timer);
  }
}

/** 小工具：按固定并发跑完所有任务，结果顺序与输入一致。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 对一个供应商的所有模型逐档实测。
 *
 * 返回**已合并好**的能力表（只包含探测出档位的模型），调用方把它并进
 * `record.modelCapabilities` 再走 `ProviderService.update()`；
 * 全档位都失败的模型保持原配置不动（并带 `error` 说明），避免把一次网络抖动
 * 写死成"这个模型不支持推理"。
 */
export async function probeProviderEfforts(
  record: ProviderRecord,
  apiKey: string,
  options: {
    language?: UiLanguage;
    candidates?: readonly string[];
    /**
     * 每完成一次上游请求回调一次，用于 SSE/NDJSON 进度推送。
     *
     * 回调里不要抛异常：它跑在探测循环中，抛了会让整个探测中断。
     * 路由侧写入已断开的连接时也只做 no-op，不在这里处理。
     */
    onProgress?: (progress: EffortProbeProgress) => void;
  } = {},
): Promise<EffortProbeOutcome> {
  const language = options.language ?? 'zh';
  // 过滤/排序口径与目录生成完全一致：只探测 Codex 认识的档位。
  const candidates = filterReasoningEfforts(options.candidates ?? EFFORT_PROBE_CANDIDATES);
  const target: EffortProbeTarget = {
    apiType: record.apiType,
    baseUrl: record.baseUrl,
    apiKey,
  };

  type Pair = { model: string; effort: string };
  const pairs: Pair[] = [];
  for (const model of record.models) {
    for (const effort of candidates) pairs.push({ model, effort });
  }

  // 进度按**完成数**递增：并发 4 时事件会成组到达，这是正常的——
  // 进度条只需要单调递增，不需要精确到"某一刻正在打哪个请求"。
  let done = 0;
  const attempts = await mapWithConcurrency(pairs, PROBE_CONCURRENCY, async (pair) => {
    const attempt = await probeEffort(target, pair.model, pair.effort, language);
    done += 1;
    options.onProgress?.({
      done,
      total: pairs.length,
      model: pair.model,
      effort: pair.effort,
      accepted: attempt.accepted,
    });
    return attempt;
  });

  const perModel = new Map<string, { accepted: string[]; rejected: string[]; error?: string }>();
  for (const model of record.models) {
    perModel.set(model, { accepted: [], rejected: [] });
  }
  pairs.forEach((pair, index) => {
    const bucket = perModel.get(pair.model);
    if (!bucket) return;
    const attempt = attempts[index];
    if (attempt.accepted) {
      bucket.accepted.push(pair.effort);
    } else {
      bucket.rejected.push(pair.effort);
      if (bucket.error === undefined && attempt.error !== undefined) {
        bucket.error = attempt.error;
      }
    }
  });

  const models: EffortProbeModelResult[] = [];
  const capabilities: Record<string, ModelCapability> = {};
  for (const model of record.models) {
    const bucket = perModel.get(model)!;
    const accepted = filterReasoningEfforts(bucket.accepted);
    const rejected = filterReasoningEfforts(bucket.rejected);
    if (accepted.length > 0) {
      capabilities[model] = {
        ...(record.modelCapabilities?.[model] ?? {}),
        supportsReasoning: true,
        reasoningEfforts: accepted,
      };
      models.push({ model, accepted, rejected });
    } else {
      models.push({
        model,
        accepted,
        rejected,
        // 一个档位都没被接受：可能是模型不支持 reasoning，也可能是地址/鉴权/协议不对。
        // 把上游给的第一条原因带上，用户才能自己判断——只写"都不支持"会掩盖配置错误。
        error: bucket.error ?? translate(language, 'providers.probe.allRejected'),
      });
    }
  }

  return { candidates, models, capabilities };
}
