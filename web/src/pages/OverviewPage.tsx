import { useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
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
        eyebrow="运行概览"
        title="概览"
        description="今日网关调用情况与最近请求，快速判断聚合链路是否正常。"
        actions={
          <>
            <select
              className="input w-44"
              value={filter}
              aria-label="按供应商筛选"
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="">全部供应商</option>
              {providerList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn-outline" onClick={refresh}>
              <Icon name="refresh" className="size-4" />
              刷新
            </button>
          </>
        }
      />

      <div className="stat-strip">
        <StatCard
          icon="activity"
          label="今日请求"
          value={stats.data?.total ?? 0}
          hint="按网关请求日志统计"
          loading={stats.loading}
        />
        <StatCard
          icon="check"
          label="成功率"
          value={stats.data ? `${stats.data.successRate}%` : '-'}
          hint={stats.data ? `成功 ${stats.data.success} 次` : undefined}
          loading={stats.loading}
        />
        <StatCard
          icon="clock"
          label="平均耗时"
          value={stats.data ? `${stats.data.avgLatencyMs}ms` : '-'}
          hint="全部请求的平均上游耗时"
          loading={stats.loading}
        />
      </div>

      <Card
        title="最近请求"
        desc="今日网关调用的最近 50 条记录，回退请求会单独标记。"
        flush
        actions={
          <Badge tone="neutral">{logs.data?.logs.length ?? 0} 条</Badge>
        }
      >
        {logs.loading && <Spinner />}
        {logs.error && (
          <div className="p-5">
            <Notice tone="error">{logs.error}</Notice>
          </div>
        )}
        {!logs.loading && (logs.data?.logs.length ?? 0) === 0 && (
          <Empty icon="activity">
            还没有请求记录。把客户端指向网关地址后即可看到调用。
          </Empty>
        )}
        {(logs.data?.logs.length ?? 0) > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>接口</th>
                  <th>模型</th>
                  <th>供应商</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>类型</th>
                </tr>
              </thead>
              <tbody>
                {logs.data?.logs.map((log, index) => (
                  <tr key={`${log.at}-${index}`}>
                    <td className="whitespace-nowrap text-xs text-muted">
                      {new Date(log.at).toLocaleTimeString()}
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
                        <span className="text-xs text-ink">{log.providerName ?? '—'}</span>
                        {log.mode === 'alias' && <Badge tone="accent">别名</Badge>}
                        {log.fallback && <Badge tone="warn">回退</Badge>}
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
                        {log.stream ? '流式' : '非流式'}
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
