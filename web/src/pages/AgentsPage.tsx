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
  const settings = useAsync(() => api.settings());
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

  const doStopProcesses = (id: string): Promise<void> =>
    run(`stop:${id}`, async () => {
      const result = await api.stopAgentProcesses(id);
      // actions 由后端补齐（包含"本机没有正在运行的 Codex 进程"这种情况），
      // 前端不再自己推断，避免两处逻辑各说一套。
      const parts: string[] = [...result.actions];
      if (result.warnings.length > 0) parts.push(...result.warnings);
      const text = parts.join('；');
      if (result.warnings.length > 0 && result.actions.length === 0) {
        setError(text);
      } else {
        setMessage(`${text}。重新打开 Codex 即可加载最新配置。`);
      }
    });

  /**
   * 切换 Codex 的行为开关。
   *
   * 切换后自动重新应用配置：开关只影响我们生成的文件内容，不改的话用户还得记得
   * 再点一次"应用配置"，容易出现"开关点了但没生效"的困惑。
   */
  const toggleCodexWebSearch = (next: boolean): Promise<void> =>
    run('toggle:web_search', async () => {
      await api.setCodexOptions({ disableCodexWebSearch: next });
      await api.applyAgent('codex');
      setMessage(
        next
          ? '已关闭联网搜索并重新应用配置。Codex 不再发送 web_search 工具。'
          : '已开启联网搜索并重新应用配置。上游若不支持该工具会报 unsupported_tool。',
      );
      settings.reload();
      agents.reload();
      if (preview?.agentId === 'codex') setPreview(await api.previewAgent('codex'));
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
              {/* 只有 Codex 有常驻进程与启动时快照的模型目录，Claude Code 不需要 */}
              {agent.id === 'codex' && (
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  disabled={busy === `stop:${agent.id}`}
                  title="结束本机正在运行的 Codex（TUI 与托管守护进程），让它重新读取配置与模型目录"
                  onClick={() => void doStopProcesses(agent.id)}
                >
                  <Icon name="refresh" className="size-3.5" />
                  {busy === `stop:${agent.id}` ? '结束中…' : '退出 Codex 进程'}
                </button>
              )}
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!agent.applied || busy === `revert:${agent.id}`}
                onClick={() => void doRevert(agent.id)}
              >
                {busy === `revert:${agent.id}` ? '还原中…' : '还原'}
              </button>
            </div>

            {/*
              只有 Codex 需要这个开关：web_search 是 Responses 的托管工具，
              聚合上游转 Chat 时普遍不支持，会 400 unsupported_tool。
            */}
            {agent.id === 'codex' && (
              <div className="mt-3 border-t border-line pt-3">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-accent"
                    checked={settings.data?.disableCodexWebSearch ?? true}
                    disabled={
                      settings.loading || busy === 'toggle:web_search' || settings.data === null
                    }
                    onChange={(event) => void toggleCodexWebSearch(event.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-ink">
                      关闭联网搜索（web_search = "disabled"）
                      {busy === 'toggle:web_search' && (
                        <span className="ml-1 text-muted">切换中…</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                      Codex 默认把 <code className="font-mono">web_search</code> 作为 Responses
                      托管工具塞进请求，多数聚合上游转 Chat 线路时不支持，会报{' '}
                      <code className="font-mono">unsupported_tool</code>。直连官方上游可关掉此项以保留联网搜索。
                    </span>
                  </span>
                </label>
              </div>
            )}
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
