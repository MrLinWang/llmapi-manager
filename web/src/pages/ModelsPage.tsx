import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import {
  Badge,
  Card,
  Empty,
  Icon,
  Notice,
  PageHeader,
  Spinner,
} from '../components/ui';
import { CopyButton } from '../components/CopyButton';
import { apiTypeShort } from '../lib/labels';

export default function ModelsPage(): JSX.Element {
  const { t } = useTranslation();
  const models = useAsync(() => api.models());
  const providers = useAsync(() => api.providers());
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);

  const current = models.data;

  useEffect(() => {
    if (!current) return;
    setProviderId(current.default.providerId ?? '');
    setModel(current.default.model ?? '');
  }, [current]);

  const providerList = providers.data?.providers ?? [];
  const selected = providerList.find((item) => item.id === providerId);

  const saveDefault = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      await api.setDefault(providerId || null, model || null);
      setMessage(t('models.default.saved'));
      models.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    }
  };

  const resetToken = async (): Promise<void> => {
    if (!window.confirm(t('models.gateway.resetConfirm'))) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const result = await api.resetGatewayToken();
      setNewToken(result.token);
      models.reload();
    } catch (cause) {
      // 服务端 message 已是面向用户的中文说明，非 ApiError 才用前端兜底句
      setError(cause instanceof ApiError ? cause.message : t('common.actionFailed'));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t('models.header.eyebrow')}
        title={t('app.nav.models')}
        description={t('models.header.description')}
        actions={
          current ? (
            <Badge tone="accent">
              {t('models.header.aliasCount', { count: current.aliases.length })}
            </Badge>
          ) : undefined
        }
      />

      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}

      <Card title={t('models.gateway.title')} desc={t('models.gateway.desc')}>
        {models.loading && <Spinner />}
        {current && (
          <div className="space-y-2.5">
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-subtle/40 p-3 sm:flex-row sm:items-center">
              <div className="flex min-w-[7.5rem] items-center gap-2 text-xs font-medium text-muted">
                <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Icon name="link" className="size-4" />
                </span>
                {t('models.gateway.baseUrl')}
              </div>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                {current.gateway.baseUrl}
              </code>
              <CopyButton value={current.gateway.baseUrl} />
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-line bg-subtle/40 p-3 sm:flex-row sm:items-center">
              <div className="flex min-w-[7.5rem] items-center gap-2 text-xs font-medium text-muted">
                <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Icon name="key" className="size-4" />
                </span>
                {t('models.gateway.token')}
              </div>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                {current.gateway.token.exists
                  ? current.gateway.token.masked
                  : t('models.gateway.tokenMissing')}
              </code>
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => void resetToken()}
              >
                {current.gateway.token.exists
                  ? t('models.gateway.resetToken')
                  : t('models.gateway.generateToken')}
              </button>
            </div>

            {newToken && (
              <Notice tone="warn">
                <p className="mb-1.5 font-medium">{t('models.gateway.newTokenNotice')}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md border border-line bg-elevated px-2 py-1 font-mono text-[11px]">
                    {newToken}
                  </code>
                  <CopyButton value={newToken} />
                </div>
              </Notice>
            )}
          </div>
        )}
      </Card>

      <Card title={t('models.default.title')} desc={t('models.default.desc')}>
        {providers.loading && <Spinner />}
        {!providers.loading && providerList.length === 0 && (
          <Empty icon="providers">{t('models.default.noProviders')}</Empty>
        )}
        {providerList.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div>
              <label className="label">{t('models.default.providerLabel')}</label>
              <select
                className="input"
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  const next = providerList.find((item) => item.id === event.target.value);
                  setModel(next?.models[0] ?? '');
                }}
              >
                <option value="">{t('common.none')}</option>
                {providerList.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {apiTypeShort(t, item.apiType)}
                    {item.enabled ? '' : t('models.default.disabledSuffix')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('models.default.modelLabel')}</label>
              {selected && selected.models.length > 0 ? (
                <select
                  className="input font-mono"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {selected.models.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input font-mono"
                  value={model}
                  placeholder={t('models.default.modelPlaceholder')}
                  onChange={(event) => setModel(event.target.value)}
                />
              )}
            </div>
            <button type="button" className="btn-primary" onClick={() => void saveDefault()}>
              {t('common.save')}
            </button>
          </div>
        )}
      </Card>

      <Card
        title={t('models.aliases.title')}
        desc={t('models.aliases.desc')}
        flush
        actions={
          <Badge tone="neutral">
            {t('models.aliases.count', { count: current?.aliases.length ?? 0 })}
          </Badge>
        }
      >
        {models.loading && <Spinner />}
        {current && current.aliases.length === 0 && (
          <Empty icon="models">{t('models.aliases.empty')}</Empty>
        )}
        {current && current.aliases.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('models.aliases.table.alias')}</th>
                  <th>{t('models.aliases.table.provider')}</th>
                  <th>{t('models.aliases.table.apiType')}</th>
                  <th>{t('models.aliases.table.upstreamModel')}</th>
                  <th className="text-right">{t('models.aliases.table.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {current.aliases.map((alias) => (
                  <tr key={alias.alias}>
                    <td>
                      <code className="font-mono text-xs text-ink">{alias.alias}</code>
                    </td>
                    <td className="text-xs text-ink">{alias.providerName}</td>
                    <td>
                      <Badge tone="accent">{apiTypeShort(t, alias.apiType)}</Badge>
                    </td>
                    <td className="font-mono text-xs text-muted">{alias.upstreamModel}</td>
                    <td className="text-right">
                      <CopyButton value={alias.alias} />
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
