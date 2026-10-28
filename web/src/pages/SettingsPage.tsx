import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { applyLanguage } from '../i18n';
import type { UiLanguage } from '../i18n/language';
import { roleLabel } from '../lib/labels';
import { Badge, Card, Icon, Notice, PageHeader } from '../components/ui';
import { ApiTokensCard } from '../components/ApiTokensCard';
import { LanguageSelect } from '../components/LanguageSelect';

export default function SettingsPage(): JSX.Element {
  const { me, can, logout, refresh } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [languageBusy, setLanguageBusy] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [languageSaved, setLanguageSaved] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword !== confirmPassword) {
      setError(t('settings.password.mismatch'));
      return;
    }
    setBusy(true);
    try {
      const result = await api.changePassword(oldPassword, newPassword);
      setMessage(result.message);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      // 口令变更后旧会话已失效，这里主动回到登录页
      await logout();
      navigate('/login', { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const editable = can('settings:write');
  /** 下拉框的值直接取服务端设置：语言是租户级状态，不该在页面里维护第二份 */
  const language = me?.language ?? null;

  /**
   * 切换界面语言并落盘。
   *
   * `LanguageSelect` 内部已经乐观地 `applyLanguage(next)`（点了立刻见效），
   * 这里只负责持久化：
   * - 成功：`refresh()` 重取 `/api/auth/me`，让 `me.language` 反映新值。
   *   这一步不能省：侧边栏也有一个语言选择器，两处共用同一个服务端真源，
   *   不刷新就会出现"这里显示 English、侧边栏还显示中文"。`refresh()` 只重取身份，
   *   页面数据（令牌列表等）走各自的 `useAsync`，不会被连带重取。
   * - 失败：把界面语言回滚到上一个**已在服务端生效**的值，否则会出现"看着切了、
   *   刷新又变回去"。
   */
  const changeLanguage = async (next: UiLanguage | null): Promise<void> => {
    const previous = language;
    if (next === previous) return;
    setLanguageBusy(true);
    setLanguageError(null);
    setLanguageSaved(false);
    let persisted = false;
    try {
      await api.setLanguage(next);
      persisted = true;
      await refresh();
      setLanguageSaved(true);
    } catch {
      // 落盘失败才回滚；已写入但刷新失败时语言已经在服务端了，切回去反而与真源不符
      if (!persisted) {
        applyLanguage(previous);
        setLanguageError(t('app.language.saveFailed'));
      }
    } finally {
      setLanguageBusy(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        eyebrow={t('settings.header.eyebrow')}
        title={t('app.nav.settings')}
        description={t('settings.header.description')}
      />

      <Card title={t('settings.account.title')} desc={t('settings.account.desc')}>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="user" className="size-3.5" />
              {t('settings.account.username')}
            </dt>
            <dd className="mt-1 font-mono text-sm text-ink">{me?.user.username}</dd>
          </div>
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="server" className="size-3.5" />
              {t('settings.account.tenant')}
            </dt>
            <dd className="mt-1 font-mono text-sm text-ink">{me?.user.tenantId}</dd>
          </div>
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="shield" className="size-3.5" />
              {t('settings.account.role')}
            </dt>
            <dd className="mt-1">
              <Badge tone="accent">{roleLabel(t, me?.user.role)}</Badge>
            </dd>
          </div>
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="key" className="size-3.5" />
              {t('settings.account.permissionCount')}
            </dt>
            <dd className="mt-1 text-sm text-ink">
              {me?.permissions.length ?? 0} / {me?.allPermissions.length ?? 0}
            </dd>
          </div>
        </dl>
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-muted">
            {t('settings.account.grantedPermissions')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {me?.permissions.map((permission) => (
              <code key={permission} className="code-chip">
                {permission}
              </code>
            ))}
          </div>
        </div>
      </Card>

      <Card title={t('settings.language.title')} desc={t('settings.language.desc')}>
        <div className="flex flex-wrap items-center gap-2">
          {/* 无 settings:write 时只读：下拉框自带 aria-label，这里用 title 说明原因 */}
          <div
            className="w-full max-w-xs"
            title={editable ? undefined : t('app.language.readOnly')}
          >
            <LanguageSelect
              value={language}
              disabled={!editable || languageBusy}
              onChange={(next) => void changeLanguage(next)}
            />
          </div>
        </div>
        {languageError && (
          <div className="mt-3">
            <Notice tone="error">{languageError}</Notice>
          </div>
        )}
        {languageSaved && (
          <div className="mt-3">
            <Notice tone="ok">{t('settings.language.saved')}</Notice>
          </div>
        )}
      </Card>

      {editable && (
        <Card title={t('settings.password.title')} desc={t('settings.password.desc')}>
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <div>
              <label className="label">{t('settings.password.current')}</label>
              <input
                className="input"
                type="password"
                value={oldPassword}
                autoComplete="current-password"
                onChange={(event) => setOldPassword(event.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">{t('settings.password.next')}</label>
                <input
                  className="input"
                  type="password"
                  value={newPassword}
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div>
                <label className="label">{t('settings.password.confirm')}</label>
                <input
                  className="input"
                  type="password"
                  value={confirmPassword}
                  autoComplete="new-password"
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </div>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            {message && <Notice tone="ok">{message}</Notice>}
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || !oldPassword || newPassword.length < 8}
            >
              {busy ? t('settings.password.submitting') : t('settings.password.submit')}
            </button>
          </form>
        </Card>
      )}

      {can('settings:read') && <ApiTokensCard />}

      <Card title={t('settings.tenancy.title')} desc={t('settings.tenancy.desc')}>
        <div className="flex items-start gap-3 rounded-xl border border-line bg-subtle/40 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Icon name="shield" className="size-[18px]" />
          </span>
          <p className="text-xs leading-6 text-muted">{t('settings.tenancy.body')}</p>
        </div>
      </Card>
    </div>
  );
}
