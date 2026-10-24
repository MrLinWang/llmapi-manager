import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useAuth } from '../lib/auth';
import type { SyncConflict, SyncRole, SyncScope } from '../lib/types';
import {
  Badge,
  Card,
  Empty,
  Icon,
  Notice,
  PageHeader,
  Spinner,
} from '../components/ui';

/** 角色文案与说明。存在前端是因为它只是展示，不影响后端的角色语义。 */
const ROLE_META: Array<{ value: SyncRole; label: string; desc: string }> = [
  {
    value: 'standalone',
    label: '不参与同步',
    desc: '各自独立配置。升级到本版本后的默认值，行为与以前完全一致。',
  },
  {
    value: 'master',
    label: '主设备（master）',
    desc: '其他设备从这里拉取配置。会对外提供快照接口，其中含上游 API Key。',
  },
  {
    value: 'follower',
    label: '跟随设备（follower）',
    desc: '主动从主设备拉取，并应用到本机。需要填 master 地址与 API 令牌。',
  },
];

const SCOPE_LABELS: Record<SyncScope, string> = {
  providers: '供应商与模型',
  settings: '网关设置',
  agentTargets: 'Agent 连接方式',
};

/**
 * 把冲突里的值渲染成人能读的一行。
 *
 * 值来自后端，凭据字段已经打码，但结构仍是 unknown（供应商对象 / 设置对象），
 * 所以这里只挑几个关键字段展示，不做完整 JSON dump —— 整段 JSON 塞进表格没法读。
 */
function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '（不存在）';
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  // 供应商：名字 + 上游地址 + Key 预览，足够判断"这是哪一家"
  if (typeof record.name === 'string') parts.push(record.name);
  if (typeof record.baseUrl === 'string') parts.push(record.baseUrl);
  if (typeof record.apiKey === 'string' && record.apiKey !== '') {
    parts.push(`Key ${record.apiKey}`);
  }
  if (Array.isArray(record.models)) parts.push(`${record.models.length} 个模型`);
  if (typeof record.enabled === 'boolean') parts.push(record.enabled ? '已启用' : '已停用');

  // 设置：只列被改动的那些键，避免把整份设置铺开
  if (parts.length === 0) {
    const keys = Object.keys(record).filter((key) => record[key] !== undefined);
    if (keys.length === 0) return '（空）';
    return keys
      .slice(0, 4)
      .map((key) => `${key}=${formatScalar(record[key])}`)
      .join('，');
  }
  return parts.join(' · ');
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '空';
  if (typeof value === 'object') return Array.isArray(value) ? `[${value.length}]` : '{…}';
  return String(value);
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export default function SyncPage(): JSX.Element {
  const { can } = useAuth();
  const canWrite = can('settings:write');

  const status = useAsync(() => api.syncStatus());
  const conflicts = useAsync(() => api.syncConflicts());

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 这些输入框不在 useAsync 里：它们是"待提交的编辑态"，不该被后台刷新覆盖
  const [masterUrl, setMasterUrl] = useState('');
  const [token, setToken] = useState('');
  const [urlInitialized, setUrlInitialized] = useState(false);

  const config = status.data?.config;
  const conflictList = conflicts.data?.conflicts ?? [];

  // 首次拿到配置时把 master 地址灌进输入框；之后不再跟随，
  // 否则用户改到一半会被后台刷新抹掉。
  // 放在 effect 里而不是渲染期间直接 setState —— 后者会触发 React 的重渲染警告。
  // 注意必须等 status.data 真的到了：数据没到时 config 是 undefined，
  // 若此时就标记 initialized，输入框会永远停在上一次的空值上。
  const initialUrl = config?.masterUrl ?? null;
  useEffect(() => {
    if (urlInitialized || status.data === null) return;
    setMasterUrl(initialUrl ?? '');
    setUrlInitialized(true);
  }, [status.data, initialUrl, urlInitialized]);

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

  /**
   * 切换角色。
   *
   * 切到 master 要二次确认：它会开始对外提供快照接口，而快照里是**上游 API Key 明文**
   * （跨机必须明文，对端要用自己的 DATA_ENCRYPTION_KEY 重新加密）。这不是能悄悄做的改动。
   */
  const changeRole = (role: SyncRole): Promise<void> =>
    run(`role:${role}`, async () => {
      if (role === 'master') {
        const confirmed = window.confirm(
          '切换到 master 后，本机会对外提供同步快照接口，' +
            '其中包含上游 API Key 的明文（对端要用自己的密钥重新加密）。\n\n' +
            '请确认：\n' +
            '1. 已配置 HTTPS（或正在可信内网里使用 SYNC_ALLOW_INSECURE=1）；\n' +
            '2. 用于拉取的 API 令牌只授予 sync:read 权限。\n\n' +
            '确定切换吗？',
        );
        if (!confirmed) return;
      }
      if (role === 'follower' && !masterUrl.trim()) {
        setError('选择跟随设备前，请先填写 master 地址');
        return;
      }
      await api.setSyncConfig({
        role,
        // 角色与地址一起提交：服务端要求 follower 必须有 masterUrl，
        // 分两次提交会在中间态被 400 挡回来
        ...(role === 'follower' ? { masterUrl: masterUrl.trim() } : {}),
      });
      setMessage(`已切换为「${ROLE_META.find((item) => item.value === role)?.label}」。`);
      status.reload();
    });

  /** 保存 master 地址（follower 用）。 */
  const saveMasterUrl = (): Promise<void> =>
    run('masterUrl', async () => {
      if (!masterUrl.trim()) {
        setError('master 地址不能为空');
        return;
      }
      await api.setSyncConfig({ masterUrl: masterUrl.trim() });
      setMessage('已保存 master 地址。');
      status.reload();
    });

  /** 勾选/取消某个同步范围。整组一起提交，避免并发改动互相覆盖。 */
  const toggleScope = (scope: SyncScope, checked: boolean): Promise<void> =>
    run(`scope:${scope}`, async () => {
      const current = config?.scopes ?? [];
      const next = checked
        ? [...current.filter((item) => item !== scope), scope]
        : current.filter((item) => item !== scope);
      await api.setSyncConfig({ scopes: next });
      status.reload();
      // 不清空 message：这里改动频繁，每次都弹一条反而吵
    });

  /** 立即拉取。token 只在这次请求里用，成功后立刻从 state 抹掉。 */
  const pull = (): Promise<void> =>
    run('pull', async () => {
      if (!token.trim()) {
        setError('请填写 master 的 API 令牌（api_ 前缀，需含 sync:read 权限）');
        return;
      }
      const result = await api.syncPull(token.trim());
      setToken('');
      setMessage(result.summary);
      status.reload();
      conflicts.reload();
    });

  /** 仲裁一条冲突。 */
  const resolve = (conflict: SyncConflict, choice: 'local' | 'remote'): Promise<void> =>
    run(`resolve:${conflict.id}`, async () => {
      await api.resolveSyncConflict(conflict.id, choice);
      setMessage(
        `已解决冲突「${conflict.targetLabel}」：采用${choice === 'local' ? '本地' : '远端'}版本。`,
      );
      conflicts.reload();
      status.reload();
    });

  if (status.loading) return <Spinner label="正在读取同步状态…" />;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="多设备"
        title="配置同步"
        description="在一台机器上配好供应商与 Agent 设置，让其余设备跟随，省掉逐台重配。"
        actions={
          config && (
            <Badge tone={config.role === 'standalone' ? 'neutral' : 'accent'}>
              {ROLE_META.find((item) => item.value === config.role)?.label ?? config.role}
            </Badge>
          )
        }
      />

      {status.error && <Notice tone="error">{status.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}

      {/* 冲突常驻在顶部：它是唯一会阻塞后续操作的东西，藏在页面底部容易被漏掉 */}
      {conflictList.length > 0 && (
        <Notice tone="warn">
          有 {conflictList.length} 条配置在本地与远端都被改过，尚未仲裁。
          在解决之前，这些项不会被再次覆盖。
        </Notice>
      )}

      <Card title="角色" desc="决定本机在同步里的位置。默认「不参与同步」，行为与升级前一致。">
        <div className="grid gap-2 sm:grid-cols-3">
          {ROLE_META.map((meta) => {
            const active = config?.role === meta.value;
            return (
              <button
                key={meta.value}
                type="button"
                disabled={!canWrite || busy === `role:${meta.value}` || status.data === null}
                onClick={() => void changeRole(meta.value)}
                className={`rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-60 ${
                  active
                    ? 'border-accent bg-accent-soft'
                    : 'border-line hover:border-accent/50 hover:bg-subtle'
                }`}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                  {active && <Icon name="check" className="size-3.5 text-accent" />}
                  {meta.label}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                  {meta.desc}
                </span>
              </button>
            );
          })}
        </div>
        {config?.role === 'master' && (
          <p className="mt-3 text-[11px] leading-4 text-warn">
            本机正对外提供快照接口。快照含上游 API Key 明文，务必只在 HTTPS
            （或显式允许的可信内网）下开放，并只把含 <code className="font-mono">sync:read</code>
            的令牌交给 follower。
          </p>
        )}
      </Card>

      <Card
        title="同步范围"
        desc="只同步勾选的内容；未勾选的一律不动。留空表示什么都不做。"
      >
        <div className="space-y-2">
          {(status.data?.availableScopes ?? []).map((item) => {
            const checked = (config?.scopes ?? []).includes(item.scope);
            return (
              <label
                key={item.scope}
                className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line px-3 py-2 hover:bg-subtle/60"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                  checked={checked}
                  disabled={!canWrite || busy === `scope:${item.scope}`}
                  onChange={(event) => void toggleScope(item.scope, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-ink">{item.label}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-muted">
                    {item.scope}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {/* 永远不同步的内容必须显式写出来：用户最担心的就是"口令会不会被传走" */}
        <div className="mt-3 rounded-xl border border-line bg-subtle/40 p-3">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink">
            <Icon name="shield" className="size-3.5 text-accent" />
            永远不会同步
          </p>
          <p className="mt-1 text-[11px] leading-5 text-muted">
            {(status.data?.neverSynced ?? []).join('、')}
            。每台机器各自独立，否则一台被入侵等于全部沦陷。
          </p>
        </div>
      </Card>

      {config?.role !== 'standalone' && (
        <Card
          title="连接"
          desc={
            config?.role === 'follower'
              ? '填写 master 地址与其 API 令牌后点「立即同步」。'
              : '本机是 master，由其他设备来拉取；这里只需确认可访问性。'
          }
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="sync-master-url" className="label">
                Master 地址
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="sync-master-url"
                  className="input min-w-0 flex-1"
                  placeholder="https://box.example.com:8787"
                  value={masterUrl}
                  disabled={!canWrite || busy === 'masterUrl'}
                  onChange={(event) => setMasterUrl(event.target.value)}
                />
                {config?.role === 'follower' && (
                  <button
                    type="button"
                    className="btn-outline"
                    disabled={!canWrite || busy === 'masterUrl' || !masterUrl.trim()}
                    onClick={() => void saveMasterUrl()}
                  >
                    {busy === 'masterUrl' ? '保存中…' : '保存地址'}
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-muted">
                不带 <code className="font-mono">/v1</code>，也不要带结尾斜杠。
                非回环地址必须是 <code className="font-mono">https://</code>
                —— 快照里有上游 Key 明文。
              </p>
            </div>

            {config?.role === 'follower' && (
              <div>
                <label htmlFor="sync-token" className="label">
                  Master 的 API 令牌
                </label>
                <input
                  id="sync-token"
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder="api_…"
                  value={token}
                  disabled={!canWrite || busy === 'pull'}
                  onChange={(event) => setToken(event.target.value)}
                />
                <p className="mt-1.5 text-[11px] leading-4 text-muted">
                  在 master 的「设置 → API 令牌」里创建，只需 <code className="font-mono">sync:read</code>
                  权限。令牌不会保存到本机，每次同步都要填，或由脚本直接调接口。
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!canWrite || busy === 'pull' || !token.trim()}
                    onClick={() => void pull()}
                  >
                    <Icon name="refresh" className="size-3.5" />
                    {busy === 'pull' ? '同步中…' : '立即同步'}
                  </button>
                  <button
                    type="button"
                    className="btn-ghost btn-sm"
                    disabled={busy === 'pull'}
                    onClick={() => {
                      status.reload();
                      conflicts.reload();
                    }}
                  >
                    刷新状态
                  </button>
                </div>
              </div>
            )}

            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-subtle/40 p-3">
                <dt className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Icon name="clock" className="size-3.5" />
                  上次拉取
                </dt>
                <dd className="mt-1 text-xs text-ink">{formatTime(config?.lastPullAt ?? null)}</dd>
              </div>
              <div className="rounded-xl border border-line bg-subtle/40 p-3">
                <dt className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Icon name="activity" className="size-3.5" />
                  上次结果
                </dt>
                <dd className="mt-1 break-all text-xs text-ink">
                  {config?.lastPullResult ?? '尚未同步过'}
                </dd>
              </div>
            </dl>
          </div>
        </Card>
      )}

      <Card
        title="冲突仲裁"
        desc="同一条配置在本地与远端都被改过时，保留两个版本由你选择，不会静默覆盖。"
        actions={
          conflictList.length > 0 ? (
            <Badge tone="warn">{conflictList.length} 条待处理</Badge>
          ) : undefined
        }
      >
        {conflicts.loading && <Spinner label="正在读取冲突…" />}
        {conflicts.error && <Notice tone="error">{conflicts.error}</Notice>}
        {!conflicts.loading && conflictList.length === 0 && (
          <Empty icon="check">没有待仲裁的冲突。同步时会自动合并本地未改动的项。</Empty>
        )}

        <div className="space-y-3">
          {conflictList.map((conflict) => (
            <div key={conflict.id} className="rounded-xl border border-line">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <span className="text-xs font-medium text-ink">{conflict.targetLabel}</span>
                <Badge tone="neutral">{SCOPE_LABELS[conflict.scope]}</Badge>
                <code className="font-mono text-[11px] text-muted">{conflict.targetId}</code>
                <span className="ml-auto text-[11px] text-muted">
                  检测于 {formatTime(conflict.detectedAt)}
                </span>
              </div>

              <div className="space-y-2 px-3 py-2.5">
                {conflict.changedFields.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted">差异字段：</span>
                    {conflict.changedFields.map((field) => (
                      <code key={field} className="code-chip">
                        {field}
                      </code>
                    ))}
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-line bg-subtle/40 p-2.5">
                    <p className="text-[11px] font-medium text-ink">本地版</p>
                    <p className="mt-1 break-all text-[11px] leading-4 text-muted">
                      {describeValue(conflict.localValue)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted">
                      更新于 {formatTime(conflict.localUpdatedAt)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-line bg-subtle/40 p-2.5">
                    <p className="text-[11px] font-medium text-ink">远端版</p>
                    <p className="mt-1 break-all text-[11px] leading-4 text-muted">
                      {describeValue(conflict.remoteValue)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted">
                      更新于 {formatTime(conflict.remoteUpdatedAt)}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-outline btn-sm"
                    disabled={!canWrite || busy === `resolve:${conflict.id}`}
                    onClick={() => void resolve(conflict, 'local')}
                  >
                    用本地
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={!canWrite || busy === `resolve:${conflict.id}`}
                    onClick={() => void resolve(conflict, 'remote')}
                  >
                    用远端
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {!canWrite && (
          <p className="mt-3 text-[11px] text-muted">
            当前账号没有 <code className="font-mono">settings:write</code>
            ，只能查看同步状态与冲突，不能修改配置。
          </p>
        )}
      </Card>
    </div>
  );
}
