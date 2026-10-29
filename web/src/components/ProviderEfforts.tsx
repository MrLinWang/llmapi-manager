import { useTranslation } from 'react-i18next';
import type { ModelCapability } from '../lib/types';
import { Badge } from './ui';

/** 一次探测的单个模型结果（与 `EffortProbeModelResult` 同形）。 */
export interface EffortRow {
  model: string;
  accepted: string[];
  rejected: string[];
  error?: string;
}

/**
 * 思考档位的展示块。
 *
 * 数据来源有两层，优先级从高到低：
 * 1. `fresh`：刚探测完的结果（比落盘值新）
 * 2. `capabilities[model].reasoningEfforts`：服务端落盘值，也就是 Codex 目录里
 *    `supported_reasoning_levels` 的来源
 *
 * **为什么放在「编辑供应商」里而不是列表行内**：一个供应商可能声明十几个模型，
 * 每行还要带档位与"被拒"说明，塞进表格那一格会把整行撑坏，也挤掉了
 * 名称/地址/Key 这些真正按行扫读的字段。档位是"配这家供应商时关心一次"的信息，
 * 属于详情而非概览。
 *
 * **空数组与 undefined 必须分开显示**：
 * - `undefined`：没测过（或数据源没给）→ 目录回落默认三档，界面说"未实测"
 * - `[]`：测过但一个档位都没被接受 → 目录写空数组（隐藏推理菜单），界面说"未探测到"
 * 合并这两种状态会让用户以为"测过了"其实没测，或反之。
 */
export function ProviderEfforts({
  models,
  capabilities,
  fresh,
}: {
  /** 要展示的模型名（对话 + 生图，已由调用方合并） */
  models: readonly string[];
  capabilities: Record<string, ModelCapability> | undefined;
  /** 本次探测刚得到的结果（比落盘值更新，优先显示） */
  fresh?: EffortRow[];
}): JSX.Element {
  const { t } = useTranslation();
  const caps = capabilities ?? {};

  const rows = models.map((model) => {
    const fromProbe = fresh?.find((item) => item.model === model);
    const capability = caps[model];
    return {
      model,
      // 刚探测的实际结果优先（落盘值可能还是探测前的）
      accepted: fromProbe?.accepted ?? capability?.reasoningEfforts,
      rejected: fromProbe?.rejected,
      error: fromProbe?.error,
    };
  });

  const probed = rows.filter((row) => row.accepted !== undefined || row.error !== undefined);
  if (models.length === 0) {
    return (
      <p className="text-[11px] leading-5 text-muted">{t('providers.probe.noModelsHint')}</p>
    );
  }
  if (probed.length === 0) {
    return (
      <p className="text-[11px] leading-5 text-muted">{t('providers.probe.neverProbed')}</p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {probed.map((row) => (
        <li key={row.model} className="flex flex-wrap items-center gap-1.5">
          <code className="code-chip" title={row.model}>
            {row.model}
          </code>
          {row.accepted && row.accepted.length > 0 ? (
            <code className="code-chip bg-accent-soft text-accent">
              {row.accepted.join(' / ')}
            </code>
          ) : (
            <Badge tone="danger">
              {row.error ?? t('providers.probe.allRejected')}
            </Badge>
          )}
          {/*
            展示被拒的档位：用户常问"为什么我配了 ultra 不生效"，
            有这一行就能直接看出上游根本不接受它，而不用再去翻日志。
          */}
          {row.rejected && row.rejected.length > 0 && (
            <span className="text-[11px] text-muted">
              {t('providers.probe.rejectedLabel', { efforts: row.rejected.join(' / ') })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * 该供应商是否已经有落盘的档位数据。
 *
 * 表单里用它决定"要不要提示用户还没测过"，列表页不再用它做列渲染。
 */
export function hasProbedEfforts(
  models: readonly string[],
  capabilities: Record<string, ModelCapability> | undefined,
): boolean {
  const caps = capabilities ?? {};
  return models.some((model) => caps[model]?.reasoningEfforts !== undefined);
}
