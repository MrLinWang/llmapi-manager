import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { AgentPreview } from '../lib/types';
import {
  Badge,
  Card,
  Empty,
  Icon,
  IconButton,
  Notice,
  PageHeader,
  Spinner,
  type IconName,
} from '../components/ui';

function agentIcon(id: string): IconName {
  return id === 'codex' ? 'terminal' : 'agents';
}

export default function AgentsPage(): JSX.Element {
  const agents = useAsync(() => api.agents());
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败');
    } finally {
      setBusy(null);
    }
  };

  const doPreview = (id: string): Promise<void> =>
    run(`preview:${id}`, async () => {
      setPreview(await api.previewAgent(id));
    });

  const doApply = (id: string): Promise<void> =>
    run(`apply:${id}`, async () => {
      await api.applyAgent(id);
      setMessage('配置已写入。若该 Agent 正在运行，请重启以加载新配置。');
      agents.reload();
      if (preview?.agentId === id) setPreview(await api.previewAgent(id));
    });

  const doRevert = (id: string): Promise<void> =>
    run(`revert:${id}`, async () => {
      const result = await api.revertAgent(id);
      if (result.conflicts.length > 0) {
        setMessage(
          `已还原 ${result.restored.length} 个键；${result.conflicts.length} 个键因被手动修改而保留：${result.conflicts
            .map((item) => item.key)
            .join('、')}`,
        );
      } else {
        setMessage(`已还原 ${result.restored.length} 个键。`);
      }
      agents.reload();
      setPreview(null);
    });

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="本机集成"
        title="Agent 配置"
        description="把聚合后的网关地址与令牌写入各 Agent 的配置文件。只改本系统拥有的键，写入前自动备份。"
        actions={<Badge tone="neutral">{agents.data?.agents.length ?? 0} 个 Agent</Badge>}
      />

      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}

      {agents.loading && <Spinner />}
      {agents.data && agents.data.agents.length === 0 && (
        <Empty icon="agents">没有可用的 Agent</Empty>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {agents.data?.agents.map((agent) => (
          <Card key={agent.id}>
            <div className="flex items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name={agentIcon(agent.id)} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">{agent.name}</h2>
                  {agent.applied ? (
                    <Badge tone="ok" dot>
                      已接管
                    </Badge>
                  ) : (
                    <Badge dot>未接管</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted">{agent.description}</p>
                {agent.appliedAt && (
                  <p className="mt-1 text-[11px] text-muted">
                    最近下发：{new Date(agent.appliedAt).toLocaleString()}
                    {agent.appliedBy ? ` · ${agent.appliedBy}` : ''}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <button
                type="button"
                className="btn-outline btn-sm"
                disabled={busy === `preview:${agent.id}`}
                onClick={() => void doPreview(agent.id)}
              >
                <Icon name="play" className="size-3.5" />
                {busy === `preview:${agent.id}` ? '预览中…' : '预览'}
              </button>
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={busy === `apply:${agent.id}`}
                onClick={() => void doApply(agent.id)}
              >
                <Icon name="zap" className="size-3.5" />
                {busy === `apply:${agent.id}` ? '写入中…' : agent.applied ? '重新应用' : '应用配置'}
              </button>
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!agent.applied || busy === `revert:${agent.id}`}
                onClick={() => void doRevert(agent.id)}
              >
                {busy === `revert:${agent.id}` ? '还原中…' : '还原'}
              </button>
            </div>
          </Card>
        ))}
      </div>

      {preview && (
        <Card
          title={`${preview.name} · 配置预览`}
          desc={`网关地址：${preview.gatewayBaseUrl}`}
          actions={
            <IconButton
              icon="x"
              label="关闭预览"
              onClick={() => setPreview(null)}
            />
          }
        >
          <div className="space-y-5">
            {preview.files.map((file) => (
              <div key={file.role}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-subtle text-muted">
                    <Icon
                      name={file.role === 'auth' ? 'key' : 'settings'}
                      className="size-3.5"
                    />
                  </span>
                  <code className="font-mono text-xs text-ink">{file.path}</code>
                  {file.exists ? (
                    <Badge tone="neutral">已存在</Badge>
                  ) : (
                    <Badge tone="accent">将创建</Badge>
                  )}
                  <Badge tone="neutral">{file.role}</Badge>
                </div>
                {file.entries.length === 0 ? (
                  <Empty>该文件无需写入</Empty>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-line">
                    <div className="overflow-x-auto">
                      <table className="table-base">
                        <thead>
                          <tr>
                            <th>键</th>
                            <th>当前值</th>
                            <th>将写入</th>
                          </tr>
                        </thead>
                        <tbody>
                          {file.entries.map((entry) => (
                            <tr key={entry.key}>
                              <td className="font-mono text-xs text-ink">{entry.key}</td>
                              <td className="max-w-[18rem] break-all font-mono text-[11px] text-muted">
                                {entry.current ?? '（未设置）'}
                              </td>
                              <td className="max-w-[18rem] break-all font-mono text-[11px] text-ink">
                                {entry.next}
                                {entry.differs && (
                                  <span className="ml-1 text-danger" title="与当前值不同">
                                    ●
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
