import { useEffect, useState } from 'react';
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

export default function ModelsPage(): JSX.Element {
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
      setMessage('默认模型已保存');
      models.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    }
  };

  const resetToken = async (): Promise<void> => {
    if (
      !window.confirm(
        '重置后旧令牌立即失效，已下发的 Agent 配置需要重新应用。确定继续？',
      )
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const result = await api.resetGatewayToken();
      setNewToken(result.token);
      models.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '重置失败');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="网关"
        title="模型聚合"
        description="所有启用供应商的模型被聚合为 lmm-<供应商>/<模型> 别名；不带别名的请求走下面的默认模型。"
        actions={
          current ? <Badge tone="accent">{current.aliases.length} 个可用别名</Badge> : undefined
        }
      />

      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}

      <Card title="网关接入" desc="Agent 或任意 OpenAI / Anthropic 客户端指向这里。">
        {models.loading && <Spinner />}
        {current && (
          <div className="space-y-2.5">
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-subtle/40 p-3 sm:flex-row sm:items-center">
              <div className="flex min-w-[7.5rem] items-center gap-2 text-xs font-medium text-muted">
                <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
                  <Icon name="link" className="size-4" />
                </span>
                网关地址
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
                网关令牌
              </div>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                {current.gateway.token.exists ? current.gateway.token.masked : '尚未生成令牌'}
              </code>
              <button
                type="button"
                className="btn-outline btn-sm"
                onClick={() => void resetToken()}
              >
                {current.gateway.token.exists ? '重置令牌' : '生成令牌'}
              </button>
            </div>

            {newToken && (
              <Notice tone="warn">
                <p className="mb-1.5 font-medium">这是唯一一次显示完整令牌，请立即复制：</p>
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

      <Card title="默认供应商与模型" desc="用于承接不带 lmm- 别名的请求。">
        {providers.loading && <Spinner />}
        {!providers.loading && providerList.length === 0 && (
          <Empty icon="providers">还没有供应商，请先在「供应商」页添加。</Empty>
        )}
        {providerList.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div>
              <label className="label">默认供应商</label>
              <select
                className="input"
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value);
                  const next = providerList.find((item) => item.id === event.target.value);
                  setModel(next?.models[0] ?? '');
                }}
              >
                <option value="">（不设置）</option>
                {providerList.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.apiType}
                    {item.enabled ? '' : '（已停用）'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">默认模型</label>
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
                  placeholder="选择供应商后填写"
                  onChange={(event) => setModel(event.target.value)}
                />
              )}
            </div>
            <button type="button" className="btn-primary" onClick={() => void saveDefault()}>
              保存
            </button>
          </div>
        )}
      </Card>

      <Card
        title="聚合别名"
        desc="只列出已启用供应商的模型，可直接复制给客户端使用。"
        flush
        actions={<Badge tone="neutral">{current?.aliases.length ?? 0} 个</Badge>}
      >
        {models.loading && <Spinner />}
        {current && current.aliases.length === 0 && (
          <Empty icon="models">暂无可用别名，请先启用供应商并声明模型。</Empty>
        )}
        {current && current.aliases.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>别名</th>
                  <th>供应商</th>
                  <th>协议</th>
                  <th>上游模型</th>
                  <th className="text-right">操作</th>
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
                      <Badge tone="accent">{alias.apiType}</Badge>
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
