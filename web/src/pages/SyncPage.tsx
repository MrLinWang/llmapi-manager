import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useAuth } from '../lib/auth';
import type { SyncConflict, SyncRole, SyncScope } from '../lib/types';
import { formatDateTime } from '../i18n/format';
import type { MessageKey } from '../lib/labels';
import {
  Badge,
  Card,
  Empty,
  Icon,
  Notice,
  PageHeader,
  Spinner,
} from '../components/ui';

/**
 * 角色文案。只存**键**不存文案：语言切换要立刻生效，
 * 把中文写死在这里就得在切换时重建数组，而键是稳定的。
 */
const ROLE_META: Array<{ value: SyncRole; labelKey: MessageKey; descKey: MessageKey }> = [
  { value: 'standalone', labelKey: 'sync.role.standalone', descKey: 'sync.role.standaloneDesc' },
  { value: 'master', labelKey: 'sync.role.master', descKey: 'sync.role.masterDesc' },
  { value: 'follower', labelKey: 'sync.role.follower', descKey: 'sync.role.followerDesc' },
];

const SCOPE_LABEL_KEYS: Record<SyncScope, MessageKey> = {
  providers: 'sync.scope.providers',
  settings: 'sync.scope.settings',
  agentTargets: 'sync.scope.agentTargets',
};

/**
 * 把冲突里的值渲染成人能读的一行。
 *
 * 值来自后端，凭据字段已经打码，但结构仍是 unknown（供应商对象 / 设置对象），
 * 所以这里只挑几个关键字段展示，不做完整 JSON dump —— 整段 JSON 塞进表格没法读。
 */
/** `t` 的类型别名：只用到「键 + 可选插值」这一种能力。 */
type Translate = (key: MessageKey, options?: Record<string, unknown>) => string;

/**
 * 把冲突里的值渲染成人能读的一行。
 *
 * 值来自后端，凭据字段已经打码，但结构仍是 unknown（供应商对象 / 设置对象），
 * 所以这里只挑几个关键字段展示，不做完整 JSON dump —— 整段 JSON 塞进表格没法读。
 *
 * 文案走 `t`：这里的单词（"已启用"/"个模型"）也是界面文案，硬编码会被
 * `web/test/i18n-guard.test.tsx` 扫出来。
 */
function describeValue(value: unknown, t: Translate): string {
  if (value === null || value === undefined) return t('sync.value.missing');
  if (typeof value !== 'object') return String(value);

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  // 供应商：名字 + 上游地址 + Key 预览，足够判断"这是哪一家"
  if (typeof record.name === 'string') parts.push(record.name);
  if (typeof record.baseUrl === 'string') parts.push(record.baseUrl);
  if (typeof record.apiKey === 'string' && record.apiKey !== '') {
    parts.push(`Key ${record.apiKey}`);
  }
  if (Array.isArray(record.models)) {
    parts.push(t('sync.value.modelCount', { count: record.models.length }));
  }
  if (typeof record.enabled === 'boolean') {
    parts.push(record.enabled ? t('sync.value.enabled') : t('sync.value.disabled'));
  }

  // 设置：只列被改动的那些键，避免把整份设置铺开
  if (parts.length === 0) {
    const keys = Object.keys(record).filter((key) => record[key] !== undefined);
    if (keys.length === 0) return t('sync.value.empty');
    return keys
      .slice(0, 4)
      .map((key) => `${key}${t('sync.value.keyValueSeparator')}${formatScalar(record[key], t)}`)
      .join(t('sync.value.pairSeparator'));
  }
  return parts.join(t('sync.value.separator'));
}

function formatScalar(value: unknown, t: Translate): string {
  if (value === null || value === undefined) return t('sync.value.emptyScalar');
  if (typeof value === 'object') return Array.isArray(value) ? `[${value.length}]` : '{…}';
  return String(value);
}

/**
 * 时间用 `i18n/format.ts` 而不是 `toLocaleString()`：
 * 后者跟随浏览器语言，会出现"界面英文、时间中文格式"。
 */
function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatDateTime(date);
}

export default function SyncPage(): JSX.Element {
  const { t } = useTranslation();
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
      setError(cause instanceof ApiError ? cause.message : t('sync.role.switchError'));
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
        const confirmed = window.confirm(t('sync.role.masterConfirm'));
        if (!confirmed) return;
      }
      if (role === 'follower' && !masterUrl.trim()) {
        setError(t('sync.role.followerNeedsUrl'));
        return;
      }
      await api.setSyncConfig({
        role,
        // 角色与地址一起提交：服务端要求 follower 必须有 masterUrl，
        // 分两次提交会在中间态被 400 挡回来
        ...(role === 'follower' ? { masterUrl: masterUrl.trim() } : {}),
      });
      setMessage(
        t('sync.role.switched', { role: t(ROLE_META.find((item) => item.value === role)!.labelKey) }),
      );
      status.reload();
    });

  /** 保存 master 地址（follower 用）。 */
  const saveMasterUrl = (): Promise<void> =>
    run('masterUrl', async () => {
      if (!masterUrl.trim()) {
        setError(t('sync.connection.urlEmpty'));
        return;
      }
      await api.setSyncConfig({ masterUrl: masterUrl.trim() });
      setMessage(t('sync.connection.urlSaved'));
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
        setError(t('sync.connection.tokenRequired'));
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
        t('sync.conflict.resolved', {
          label: conflict.targetLabel,
          choice:
            choice === 'local'
              ? t('sync.conflict.choiceLocal')
              : t('sync.conflict.choiceRemote'),
        }),
      );
      conflicts.reload();
      status.reload();
    });

  if (status.loading) return <Spinner label={t('sync.loading')} />;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t('sync.eyebrow')}
        title={t('sync.title')}
        description={t('sync.description')}
        actions={
          config && (
            <Badge tone={config.role === 'standalone' ? 'neutral' : 'accent'}>
              {ROLE_META.find((item) => item.value === config.role)
                ? t(ROLE_META.find((item) => item.value === config.role)!.labelKey)
                : config.role}
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
          {t('sync.conflict.banner', { count: conflictList.length })}
        </Notice>
      )}

      <Card title={t('sync.role.cardTitle')} desc={t('sync.role.cardDesc')}>
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
                  {t(meta.labelKey)}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                  {t(meta.descKey)}
                </span>
              </button>
            );
          })}
        </div>
        {config?.role === 'master' && (
          <p className="mt-3 text-[11px] leading-4 text-warn">
            {t('sync.role.masterWarning')}
            {t('sync.role.masterWarningTail')}
          </p>
        )}
      </Card>

      <Card title={t('sync.scope.cardTitle')} desc={t('sync.scope.cardDesc')}>
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
            {t('sync.scope.neverSyncedTitle')}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-muted">
            {(status.data?.neverSynced ?? []).join(', ')}
            {t('sync.scope.neverSyncedTail')}
          </p>
        </div>
      </Card>

      {config?.role !== 'standalone' && (
        <Card
          title={t('sync.connection.cardTitle')}
          desc={
            config?.role === 'follower'
              ? t('sync.connection.descFollower')
              : t('sync.connection.descMaster')
          }
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="sync-master-url" className="label">
                {t('sync.connection.masterUrlLabel')}
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="sync-master-url"
                  className="input min-w-0 flex-1"
                  placeholder={t('sync.connection.masterUrlPlaceholder')}
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
                    {busy === 'masterUrl'
                      ? t('sync.connection.savingUrl')
                      : t('sync.connection.saveUrl')}
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[11px] leading-4 text-muted">
                {t('sync.connection.urlHint')} <code className="font-mono">/v1</code>
                {t('sync.connection.urlHintTail')}{' '}
                <code className="font-mono">https://</code>
                {t('sync.connection.urlHintTail2')}
              </p>
            </div>

            {config?.role === 'follower' && (
              <div>
                <label htmlFor="sync-token" className="label">
                  {t('sync.connection.tokenLabel')}
                </label>
                <input
                  id="sync-token"
                  className="input"
                  type="password"
                  autoComplete="off"
                  placeholder={t('sync.connection.tokenPlaceholder')}
                  value={token}
                  disabled={!canWrite || busy === 'pull'}
                  onChange={(event) => setToken(event.target.value)}
                />
                <p className="mt-1.5 text-[11px] leading-4 text-muted">
                  {t('sync.connection.tokenHint')}{' '}
                  <code className="font-mono">sync:read</code>
                  {t('sync.connection.tokenHintTail')}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!canWrite || busy === 'pull' || !token.trim()}
                    onClick={() => void pull()}
                  >
                    <Icon name="refresh" className="size-3.5" />
                    {busy === 'pull' ? t('sync.connection.syncing') : t('sync.connection.syncNow')}
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
                    {t('sync.connection.refresh')}
                  </button>
                </div>
              </div>
            )}

            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-line bg-subtle/40 p-3">
                <dt className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Icon name="clock" className="size-3.5" />
                  {t('sync.connection.lastPull')}
                </dt>
                <dd className="mt-1 text-xs text-ink">{formatTime(config?.lastPullAt ?? null)}</dd>
              </div>
              <div className="rounded-xl border border-line bg-subtle/40 p-3">
                <dt className="flex items-center gap-1.5 text-[11px] text-muted">
                  <Icon name="activity" className="size-3.5" />
                  {t('sync.connection.lastResult')}
                </dt>
                <dd className="mt-1 break-all text-xs text-ink">
                  {config?.lastPullResult ?? t('sync.connection.neverPulled')}
                </dd>
              </div>
            </dl>
          </div>
        </Card>
      )}

      <Card
        title={t('sync.conflict.cardTitle')}
        desc={t('sync.conflict.cardDesc')}
        actions={
          conflictList.length > 0 ? (
            <Badge tone="warn">{t('sync.conflict.pending', { count: conflictList.length })}</Badge>
          ) : undefined
        }
      >
        {conflicts.loading && <Spinner label={t('sync.conflict.loading')} />}
        {conflicts.error && <Notice tone="error">{conflicts.error}</Notice>}
        {!conflicts.loading && conflictList.length === 0 && (
          <Empty icon="check">{t('sync.conflict.none')}</Empty>
        )}

        <div className="space-y-3">
          {conflictList.map((conflict) => (
            <div key={conflict.id} className="rounded-xl border border-line">
              <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                <span className="text-xs font-medium text-ink">{conflict.targetLabel}</span>
                <Badge tone="neutral">{t(SCOPE_LABEL_KEYS[conflict.scope])}</Badge>
                <code className="font-mono text-[11px] text-muted">{conflict.targetId}</code>
                <span className="ml-auto text-[11px] text-muted">
                  {t('sync.conflict.detectedAt')} {formatTime(conflict.detectedAt)}
                </span>
              </div>

              <div className="space-y-2 px-3 py-2.5">
                {conflict.changedFields.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted">{t('sync.conflict.changedFields')}</span>
                    {conflict.changedFields.map((field) => (
                      <code key={field} className="code-chip">
                        {field}
                      </code>
                    ))}
                  </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border border-line bg-subtle/40 p-2.5">
                    <p className="text-[11px] font-medium text-ink">
                      {t('sync.conflict.localVersion')}
                    </p>
                    <p className="mt-1 break-all text-[11px] leading-4 text-muted">
                      {describeValue(conflict.localValue, t)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted">
                      {t('sync.conflict.updatedAt')} {formatTime(conflict.localUpdatedAt)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-line bg-subtle/40 p-2.5">
                    <p className="text-[11px] font-medium text-ink">
                      {t('sync.conflict.remoteVersion')}
                    </p>
                    <p className="mt-1 break-all text-[11px] leading-4 text-muted">
                      {describeValue(conflict.remoteValue, t)}
                    </p>
                    <p className="mt-1 text-[10px] text-muted">
                      {t('sync.conflict.updatedAt')} {formatTime(conflict.remoteUpdatedAt)}
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
                    {t('sync.conflict.useLocal')}
                  </button>
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={!canWrite || busy === `resolve:${conflict.id}`}
                    onClick={() => void resolve(conflict, 'remote')}
                  >
                    {t('sync.conflict.useRemote')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {!canWrite && (
          <p className="mt-3 text-[11px] text-muted">
            {t('sync.conflict.readOnlyHint')}{' '}
            <code className="font-mono">settings:write</code>
            {t('sync.conflict.readOnlyHintTail')}
          </p>
        )}
      </Card>
    </div>
  );
}
