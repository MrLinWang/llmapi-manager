import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { formatTime } from '../i18n/format';
import {
  Badge,
  Card,
  Empty,
  Icon,
  Notice,
  PageHeader,
  Spinner,
  StatCard,
} from '../components/ui';

export default function OverviewPage(): JSX.Element {
  const { t } = useTranslation();
  const stats = useAsync(() => api.stats());
  const providers = useAsync(() => api.providers());
  const [filter, setFilter] = useState('');
  const logs = useAsync(() => api.logs(filter || undefined, 50), [filter]);

  const providerList = providers.data?.providers ?? [];

  const refresh = (): void => {
    stats.reload();
    logs.reload();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t('overview.header.eyebrow')}
        title={t('app.nav.overview')}
        description={t('overview.header.description')}
        actions={
          <>
            <select
              className="input w-44"
              value={filter}
              aria-label={t('overview.filter.label')}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="">{t('overview.filter.all')}</option>
              {providerList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn-outline" onClick={refresh}>
              <Icon name="refresh" className="size-4" />
              {t('common.refresh')}
            </button>
          </>
        }
      />

      <div className="stat-strip">
        <StatCard
          icon="activity"
          label={t('overview.stats.today')}
          value={stats.data?.total ?? 0}
          hint={t('overview.stats.todayHint')}
          loading={stats.loading}
        />
        <StatCard
          icon="check"
          label={t('overview.stats.successRate')}
          value={stats.data ? `${stats.data.successRate}%` : '-'}
          hint={
            stats.data
              ? t('overview.stats.successHint', { count: stats.data.success })
              : undefined
          }
          loading={stats.loading}
        />
        <StatCard
          icon="clock"
          label={t('overview.stats.avgLatency')}
          value={stats.data ? `${stats.data.avgLatencyMs}ms` : '-'}
          hint={t('overview.stats.avgLatencyHint')}
          loading={stats.loading}
        />
      </div>

      <Card
        title={t('overview.logs.title')}
        desc={t('overview.logs.desc')}
        flush
        actions={
          <Badge tone="neutral">
            {t('overview.logs.count', { count: logs.data?.logs.length ?? 0 })}
          </Badge>
        }
      >
        {logs.loading && <Spinner />}
        {logs.error && (
          <div className="p-5">
            <Notice tone="error">{logs.error}</Notice>
          </div>
        )}
        {!logs.loading && (logs.data?.logs.length ?? 0) === 0 && (
          <Empty icon="activity">{t('overview.logs.empty')}</Empty>
        )}
        {(logs.data?.logs.length ?? 0) > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>{t('overview.logs.table.time')}</th>
                  <th>{t('overview.logs.table.path')}</th>
                  <th>{t('overview.logs.table.model')}</th>
                  <th>{t('overview.logs.table.provider')}</th>
                  <th>{t('overview.logs.table.status')}</th>
                  <th>{t('overview.logs.table.latency')}</th>
                  <th>{t('overview.logs.table.kind')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.data?.logs.map((log, index) => (
                  <tr key={`${log.at}-${index}`}>
                    <td className="whitespace-nowrap text-xs text-muted">
                      {/* 时间跟随控制台语言，不能用 toLocaleTimeString()（它跟浏览器语言） */}
                      {formatTime(log.at)}
                    </td>
                    <td>
                      <code className="font-mono text-[11px] text-ink">{log.path}</code>
                    </td>
                    <td className="max-w-[18rem]">
                      <code className="block truncate font-mono text-[11px] text-ink">
                        {log.requestedModel}
                      </code>
                      {log.upstreamModel !== log.requestedModel && (
                        <span className="mt-0.5 block truncate text-[11px] text-muted">
                          → {log.upstreamModel}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-ink">
                          {log.providerName ?? t('overview.logs.noProvider')}
                        </span>
                        {log.mode === 'alias' && (
                          <Badge tone="accent">{t('overview.logs.badgeAlias')}</Badge>
                        )}
                        {log.fallback && (
                          <Badge tone="warn">{t('overview.logs.badgeFallback')}</Badge>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          dot
                          tone={
                            log.status >= 200 && log.status < 400
                              ? 'ok'
                              : log.status === 499
                                ? 'neutral'
                                : 'danger'
                          }
                        >
                          {log.status}
                        </Badge>
                        {log.error && (
                          <span
                            className="inline-block max-w-[14rem] truncate text-[11px] text-danger"
                            title={log.error}
                          >
                            {log.error}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-xs text-muted">{log.latencyMs}ms</td>
                    <td>
                      <Badge tone={log.stream ? 'accent' : 'neutral'}>
                        {log.stream ? t('overview.logs.stream') : t('overview.logs.nonStream')}
                      </Badge>
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
