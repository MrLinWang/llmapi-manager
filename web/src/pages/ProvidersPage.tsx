import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { Provider, TestResult } from '../lib/types';
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
          onProbed={reload}
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

    </div>
  );
}
