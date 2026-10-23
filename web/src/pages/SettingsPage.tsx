import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { roleLabel } from '../lib/labels';
import { Badge, Card, Icon, Notice, PageHeader } from '../components/ui';
import { ApiTokensCard } from '../components/ApiTokensCard';

export default function SettingsPage(): JSX.Element {
  const { me, can, logout } = useAuth();
  const navigate = useNavigate();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (newPassword !== confirmPassword) {
      setError('两次输入的新口令不一致');
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
      setError(cause instanceof ApiError ? cause.message : '修改失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        eyebrow="账号"
        title="设置"
        description="查看当前登录身份与权限，或更新登录口令。"
      />

      <Card title="当前账号" desc="登录身份、租户与权限范围。">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="user" className="size-3.5" />
              用户名
            </dt>
            <dd className="mt-1 font-mono text-sm text-ink">{me?.user.username}</dd>
          </div>
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="server" className="size-3.5" />
              租户
            </dt>
            <dd className="mt-1 font-mono text-sm text-ink">{me?.user.tenantId}</dd>
          </div>
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="shield" className="size-3.5" />
              角色
            </dt>
            <dd className="mt-1">
              <Badge tone="accent">{roleLabel(me?.user.role)}</Badge>
            </dd>
          </div>
          <div className="rounded-xl border border-line bg-subtle/40 p-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              <Icon name="key" className="size-3.5" />
              权限数
            </dt>
            <dd className="mt-1 text-sm text-ink">
              {me?.permissions.length ?? 0} / {me?.allPermissions.length ?? 0}
            </dd>
          </div>
        </dl>
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-muted">已授予权限</p>
          <div className="flex flex-wrap gap-1.5">
            {me?.permissions.map((permission) => (
              <code key={permission} className="code-chip">
                {permission}
              </code>
            ))}
          </div>
        </div>
      </Card>

      {can('settings:write') && (
        <Card title="修改口令" desc="修改后所有已登录会话立即失效，需要重新登录。">
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <div>
              <label className="label">当前口令</label>
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
                <label className="label">新口令（至少 8 位）</label>
                <input
                  className="input"
                  type="password"
                  value={newPassword}
                  autoComplete="new-password"
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </div>
              <div>
                <label className="label">确认新口令</label>
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
              {busy ? '提交中…' : '更新口令'}
            </button>
          </form>
        </Card>
      )}

      {can('settings:read') && <ApiTokensCard />}

      <Card title="多用户与租户" desc="当前版本的边界与后续扩展方式。">
        <div className="flex items-start gap-3 rounded-xl border border-line bg-subtle/40 p-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Icon name="shield" className="size-[18px]" />
          </span>
          <p className="text-xs leading-6 text-muted">
            当前版本为单人使用：一个租户、一个 owner 账号。数据已按租户分区保存，
            权限按角色集中裁决，新增用户或租户时无需改动领域模型与接口契约。
          </p>
        </div>
      </Card>
    </div>
  );
}
