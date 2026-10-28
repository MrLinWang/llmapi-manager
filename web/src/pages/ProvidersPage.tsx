import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { EffortProbeResult, Provider, TestResult } from '../lib/types';
import {
  Badge,
  Card,
  Empty,
  Icon,
  IconButton,
  Notice,
  PageHeader,
  Spinner,
} from '../components/ui';
import { ProviderForm, TestResultLine } from '../components/ProviderForm';
import { apiTypeShort } from '../lib/labels';

export default function ProvidersPage(): JSX.Element {
  const { t } = useTranslation();
  const { data, loading, error, reload } = useAsync(() => api.providers());
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeProgress, setProbeProgress] = useState<{
    done: number;
    total: number;
    model: string;
    effort: string;
  } | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, EffortProbeResult>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const providers = data?.providers ?? [];

  const test = async (provider: Provider): Promise<void> => {
    setTestingId(provider.id);
    setActionError(null);
    try {
      const result = await api.testProvider(provider.id);
      setTestResults((prev) => ({ ...prev, [provider.id]: result }));
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : t('common.testFailed'));
    } finally {
      setTestingId(null);
    }
  };

  const closeProbeResult = (providerId: string): void => {
    setProbeResults((prev) => {
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
  };

  const probe = async (provider: Provider): Promise<void> => {
    // 候选档位数优先取上次响应的真实值；首次探测还没有结果，按服务端的 9 档估算。
    const previous = probeResults[provider.id];
    const candidates =
      previous && previous.candidates.length > 0 ? previous.candidates.length : 9;
    const confirmed = window.confirm(
      t('providers.probe.confirm', {
        models: provider.models.length,
        requests: provider.models.length * candidates,
      }),
    );
    if (!confirmed) return;
    setActionError(null);
    setProbingId(provider.id);
    // 初始分母按「模型数 × 候选档位数」估：服务端 start 事件到达前就先画一条 0% 的轨道，
    // 用户点下去立刻能看到进度条，而不是只有一行"请稍候"。
    setProbeProgress({
      done: 0,
      total: provider.models.length * candidates,
      model: '',
      effort: '',
    });
    // 先清掉上一次结果：探测期间继续显示旧数据会让人以为这次已经出结果了。
    closeProbeResult(provider.id);
    try {
      const result = await api.probeProviderEfforts(provider.id, (progress) => {
        setProbeProgress({
          done: progress.done,
          total: progress.total,
          model: progress.model,
          effort: progress.effort,
        });
      });
      setProbeResults((prev) => ({ ...prev, [provider.id]: result }));
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : t('common.actionFailed'));
    } finally {
      setProbingId(null);
      setProbeProgress(null);
    }
  };

  const toggle = async (provider: Provider): Promise<void> => {
    setActionError(null);
    try {
      await api.setProviderEnabled(provider.id, !provider.enabled);
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : t('common.actionFailed'));
    }
  };

  const remove = async (provider: Provider): Promise<void> => {
    if (!window.confirm(t('providers.removeConfirm', { name: provider.name }))) return;
    setActionError(null);
    try {
      await api.deleteProvider(provider.id);
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : t('common.deleteFailed'));
    }
  };

  const move = async (provider: Provider, direction: -1 | 1): Promise<void> => {
    const index = providers.findIndex((item) => item.id === provider.id);
    const target = index + direction;
    if (target < 0 || target >= providers.length) return;
    const ids = providers.map((item) => item.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setActionError(null);
    try {
      await api.reorderProviders(ids);
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : t('common.sortFailed'));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t('providers.header.eyebrow')}
        title={t('app.nav.providers')}
        description={t('providers.header.description')}
        actions={
          !creating &&
          !editing && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" className="size-4" />
              {t('providers.actions.create')}
            </button>
          )
        }
      />

      {actionError && <Notice tone="error">{actionError}</Notice>}
      {probingId !== null && (
        <Notice tone="info">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {probeProgress !== null && probeProgress.done > 0
                  ? t('providers.probe.progress', probeProgress)
                  : t('providers.probe.running')}
              </span>
              {probeProgress !== null && probeProgress.total > 0 && (
                <span className="font-mono text-[11px] text-muted">
                  {probeProgress.done} / {probeProgress.total}
                </span>
              )}
            </div>
            <div
              role="progressbar"
              aria-label={t('providers.probe.running')}
              aria-valuemin={0}
              aria-valuemax={probeProgress?.total ?? 0}
              aria-valuenow={probeProgress?.done ?? 0}
              className="h-1.5 w-full overflow-hidden rounded-full bg-line"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{
                  width: `${
                    probeProgress !== null && probeProgress.total > 0
                      ? Math.min(100, Math.round((probeProgress.done / probeProgress.total) * 100))
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        </Notice>
      )}

      {(creating || editing) && (
        <ProviderForm
          provider={editing ?? undefined}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            reload();
          }}
        />
      )}

      <Card
        title={t('providers.list.title')}
        desc={t('providers.list.desc')}
        flush
        actions={<Badge tone="neutral">{t('providers.list.count', { count: providers.length })}</Badge>}
      >
        {loading && <Spinner />}
        {error && (
          <div className="p-5">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {!loading && !error && providers.length === 0 && (
          <Empty icon="providers">{t('providers.list.empty')}</Empty>
        )}
        {providers.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base table-compact">
              <thead>
                <tr>
                  <th className="w-12">#</th>
                  <th className="min-w-[13rem]">{t('providers.table.name')}</th>
                  <th className="w-20">{t('providers.table.apiType')}</th>
                  <th className="min-w-[10rem]">{t('providers.table.baseUrl')}</th>
                  <th className="min-w-[11rem]">{t('providers.table.models')}</th>
                  <th className="min-w-[8rem]">{t('providers.table.key')}</th>
                  <th className="min-w-[7rem]">{t('providers.table.lastTest')}</th>
                  <th className="w-[1%] whitespace-nowrap text-right sm:sticky sm:right-0 sm:z-10 sm:border-l sm:border-line sm:bg-subtle">
                    {t('providers.table.actions')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider, index) => (
                  <tr key={provider.id} className="group">
                    <td className="text-xs text-muted">{index + 1}</td>
                    <td>
                      <div className="flex items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-xs font-semibold text-accent">
                          {provider.name.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-ink">{provider.name}</span>
                            {provider.enabled ? (
                              <Badge tone="ok" dot>
                                {t('providers.status.enabled')}
                              </Badge>
                            ) : (
                              <Badge dot>{t('providers.status.disabled')}</Badge>
                            )}
                          </div>
                          <code className="mt-0.5 block whitespace-nowrap font-mono text-[11px] text-muted">
                            lam-{provider.providerKey}/
                          </code>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone="accent">{apiTypeShort(t, provider.apiType)}</Badge>
                    </td>
                    <td
                      className="max-w-[16rem] truncate font-mono text-xs text-muted"
                      title={provider.baseUrl}
                    >
                      {provider.baseUrl}
                    </td>
                    <td>
                      <div className="flex max-w-[16rem] flex-wrap gap-1">
                        {provider.models.slice(0, 4).map((model) => (
                          <code key={model} className="code-chip">
                            {model}
                          </code>
                        ))}
                        {provider.models.length > 4 && (
                          <span className="text-[11px] text-muted">
                            +{provider.models.length - 4}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs text-muted">
                      {provider.hasApiKey ? provider.apiKeyMasked : t('common.notSet')}
                    </td>
                    <td>
                      {testResults[provider.id] ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px]">
                          <Badge tone={testResults[provider.id].ok ? 'ok' : 'danger'} dot>
                            {testResults[provider.id].ok
                              ? t('providers.test.ok')
                              : t('providers.test.fail')}
                          </Badge>
                          <span className="text-muted">{testResults[provider.id].latencyMs}ms</span>
                        </span>
                      ) : (
                        <TestResultLine provider={provider} />
                      )}
                    </td>
                    {/*
                      固定列的背景必须始终不透明：这里曾被写成 group-hover:bg-subtle/50，
                      鼠标悬停时 50% 透明，Key/最近测试列的内容会透过操作按钮显示出来。
                      行悬停的视觉反馈改由非固定单元格承担（见 table-compact 的 hover 规则）。
                    */}
                    <td className="bg-elevated group-hover:bg-subtle sm:sticky sm:right-0 sm:z-10 sm:border-l sm:border-line">
                      <div className="flex flex-nowrap items-center justify-end gap-0.5">
                        <IconButton
                          icon="play"
                          label={t('providers.actions.test')}
                          disabled={testingId === provider.id}
                          onClick={() => void test(provider)}
                        />
                        <IconButton
                          icon="zap"
                          label={t('providers.actions.probe')}
                          disabled={provider.models.length === 0 || probingId !== null}
                          onClick={() => void probe(provider)}
                        />
                        <IconButton
                          icon="arrow-up"
                          label={t('providers.actions.moveUp')}
                          disabled={index === 0}
                          onClick={() => void move(provider, -1)}
                        />
                        <IconButton
                          icon="arrow-down"
                          label={t('providers.actions.moveDown')}
                          disabled={index === providers.length - 1}
                          onClick={() => void move(provider, 1)}
                        />
                        <button
                          type="button"
                          className="btn-ghost btn-sm whitespace-nowrap"
                          onClick={() => void toggle(provider)}
                        >
                          {provider.enabled
                            ? t('providers.actions.disable')
                            : t('providers.actions.enable')}
                        </button>
                        <IconButton
                          icon="edit"
                          label={t('common.edit')}
                          onClick={() => {
                            setCreating(false);
                            setEditing(provider);
                          }}
                        />
                        <IconButton
                          icon="trash"
                          label={t('common.delete')}
                          tone="danger"
                          onClick={() => void remove(provider)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/*
        结果面板放在列表下方而不是行内：一个供应商可能声明很多模型、每行还要显示
        接受的档位，塞进操作列会把表格撑坏。按供应商分别渲染，互不影响。
      */}
      {providers.map((provider) => {
        const result = probeResults[provider.id];
        if (!result) return null;
        return (
          <Card key={provider.id} title={`${t('providers.probe.title')} · ${provider.name}`}>
            <ul className="space-y-2">
              {result.models.map((model) => (
                <li key={model.model} className="flex flex-wrap items-center gap-2">
                  <code className="code-chip">{model.model}</code>
                  {model.accepted.length > 0 ? (
                    <code className="code-chip bg-accent-soft text-accent">
                      {model.accepted.join(' / ')}
                    </code>
                  ) : (
                    <Badge tone="danger">
                      {model.error ?? t('providers.probe.allRejected')}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
              <p className="max-w-2xl text-[11px] leading-5 text-muted">
                {t('providers.probe.hint')}
              </p>
              <button
                type="button"
                className="btn-ghost btn-sm whitespace-nowrap"
                onClick={() => closeProbeResult(provider.id)}
              >
                {t('providers.probe.close')}
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
