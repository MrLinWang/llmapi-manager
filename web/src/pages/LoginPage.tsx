import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Icon, Notice } from '../components/ui';
import { LanguageSelect } from '../components/LanguageSelect';

export default function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-canvas relative flex min-h-full items-center justify-center px-4 py-12">
      {/*
       * 登录前读不到服务端设置（`/api/auth/me` 必然 401），所以这里是纯本地切换：
       * 不传 `onChange`、不落盘，`value` 固定为 `null`（跟随浏览器）。
       * 登录成功后 `AuthProvider.refresh()` 会按服务端设置重新 apply，覆盖本地选择。
       * 位置在右上角：不挤占表单的视觉动线，也让用户先看到能切语言。
       */}
      <div className="absolute right-4 top-4 w-36">
        <LanguageSelect value={null} />
      </div>

      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
            <Icon name="sparkles" className="size-6" />
          </span>
          {/* 品牌名不翻译：它是产品名，不随界面语言变化 */}
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('app.brand')}</h1>
          <p className="mt-1 text-sm text-muted">{t('login.tagline')}</p>
        </div>

        <form onSubmit={(event) => void submit(event)} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="username">
              {t('login.username')}
            </label>
            <input
              id="username"
              className="input"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              {t('login.password')}
            </label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" className="btn-primary w-full" disabled={busy || !password}>
            {busy ? t('login.submitting') : t('login.submit')}
          </button>
          <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted">
            <Icon name="shield" className="size-3.5" />
            {t('login.firstRunHint')}
          </div>
        </form>

        <p className="mt-5 text-center text-[11px] text-muted">{t('app.selfHostedNote')}</p>
      </div>
    </div>
  );
}
