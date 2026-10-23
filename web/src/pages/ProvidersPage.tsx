import { useState } from 'react';
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
      setActionError(cause instanceof ApiError ? cause.message : '测试失败');
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
      setActionError(cause instanceof ApiError ? cause.message : '操作失败');
    }
  };

  const remove = async (provider: Provider): Promise<void> => {
    if (!window.confirm(`确定删除供应商「${provider.name}」？该操作不可撤销。`)) return;
    setActionError(null);
    try {
      await api.deleteProvider(provider.id);
      reload();
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : '删除失败');
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
      setActionError(cause instanceof ApiError ? cause.message : '排序失败');
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="配置中心"
        title="供应商"
        description="维护各家 LLM API。启用的供应商会参与聚合别名与网关选路，优先级越小越先被选中。"
        actions={
          !creating &&
          !editing && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              <Icon name="plus" className="size-4" />
              新增供应商
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
        />
      )}

      <Card
        title="供应商列表"
        desc="按优先级排序，数值越小越优先参与网关选路。"
        flush
        actions={<Badge tone="neutral">{providers.length} 个</Badge>}
      >
        {loading && <Spinner />}
        {error && (
          <div className="p-5">
            <Notice tone="error">{error}</Notice>
          </div>
        )}
        {!loading && !error && providers.length === 0 && (
          <Empty icon="providers">
            还没有供应商。先添加一个，再去「模型聚合」生成网关令牌。
          </Empty>
        )}
        {providers.length > 0 && (
          <div className="overflow-x-auto">
            <table className="table-base table-compact">
              <thead>
                <tr>
                  <th className="w-12">#</th>
                  <th className="min-w-[13rem]">名称 / 别名前缀</th>
                  <th className="w-20">协议</th>
                  <th className="min-w-[10rem]">Base URL</th>
                  <th className="min-w-[11rem]">模型</th>
                  <th className="min-w-[8rem]">Key</th>
                  <th className="min-w-[7rem]">最近测试</th>
                  <th className="w-[1%] whitespace-nowrap text-right sm:sticky sm:right-0 sm:z-10 sm:border-l sm:border-line sm:bg-subtle">
                    操作
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
                                启用
                              </Badge>
                            ) : (
                              <Badge dot>停用</Badge>
                            )}
                          </div>
                          <code className="mt-0.5 block whitespace-nowrap font-mono text-[11px] text-muted">
                            lam-{provider.providerKey}/
                          </code>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone="accent">{apiTypeShort(provider.apiType)}</Badge>
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
                      {provider.hasApiKey ? provider.apiKeyMasked : '未设置'}
                    </td>
                    <td>
                      {testResults[provider.id] ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px]">
                          <Badge tone={testResults[provider.id].ok ? 'ok' : 'danger'} dot>
                            {testResults[provider.id].ok ? '连通' : '失败'}
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
                          label="测试"
                          disabled={testingId === provider.id}
                          onClick={() => void test(provider)}
                        />
                        <IconButton
                          icon="arrow-up"
                          label="提高优先级"
                          disabled={index === 0}
                          onClick={() => void move(provider, -1)}
                        />
                        <IconButton
                          icon="arrow-down"
                          label="降低优先级"
                          disabled={index === providers.length - 1}
                          onClick={() => void move(provider, 1)}
                        />
                        <button
                          type="button"
                          className="btn-ghost btn-sm whitespace-nowrap"
                          onClick={() => void toggle(provider)}
                        >
                          {provider.enabled ? '停用' : '启用'}
                        </button>
                        <IconButton
                          icon="edit"
                          label="编辑"
                          onClick={() => {
                            setCreating(false);
                            setEditing(provider);
                          }}
                        />
                        <IconButton
                          icon="trash"
                          label="删除"
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
