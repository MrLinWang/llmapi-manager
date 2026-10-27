import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { SetupStatus } from '../lib/types';
import { Icon, Notice } from '../components/ui';
import { LanguageSelect } from '../components/LanguageSelect';

/**
 * 首次初始化页。
 *
 * 用户在这里自己设置管理员用户名与口令，而不是去控制台抄一个随机口令。
 * 门禁是服务端启动时打印的一次性初始化令牌：能读到控制台的人才算部署者。
 */
export default function SetupPage(): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const { t } = useTranslation();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 读状态失败：存标记而不是句子，渲染时再取字典，切语言后提示也会跟着变 */
  const [statusFailed, setStatusFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.setupStatus();
        setStatus(result);
        setUsername(result.defaultUsername);
        if (!result.needsSetup) {
          // 已初始化却进来了：直接去登录页
          navigate('/login', { replace: true });
        }
      } catch {
        // 这里刻意不放 `t` 进依赖：切语言会重跑一遍 effect，把用户已填的用户名
        // 重新覆盖成 defaultUsername。提示文案在渲染处取即可。
        setStatusFailed(true);
      }
    })();
  }, [navigate]);

  const minPassword = status?.rules.minPasswordLength ?? 8;
  const passwordTooShort = password.length > 0 && password.length < minPassword;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    !busy &&
    token.trim() !== '' &&
    username.trim() !== '' &&
    password.length >= minPassword &&
    confirm === password;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.completeSetup(token.trim(), username.trim(), password);
      // 初始化成功后直接登录态刷新，进入控制台
      await refresh();
      navigate('/', { replace: true });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.setupFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-canvas relative flex min-h-full items-center justify-center px-4 py-12">
      {/*
       * 首次初始化时同样读不到服务端设置（还没有账号），所以只做本地切换：
       * 不传 `onChange`、不落盘，`value` 固定 `null` 表示按浏览器探测。
       */}
      <div className="absolute right-4 top-4 w-36">
        <LanguageSelect value={null} />
      </div>

      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
            <Icon name="shield" className="size-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('setup.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('setup.description')}</p>
        </div>

        <form onSubmit={(event) => void submit(event)} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="token">
              {t('setup.token.label')}
            </label>
            <input
              id="token"
              className="input font-mono text-[13px]"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('setup.token.placeholder')}
              onChange={(event) => setToken(event.target.value)}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              {/* 路径 `data/setup.json` 是标识符，不翻译，交给内联标记 */}
              <Trans
                i18nKey="setup.token.hint"
                components={{ code: <code className="font-mono" /> }}
              />
            </p>
          </div>

          <div>
            <label className="label" htmlFor="username">
              {t('setup.username.label')}
            </label>
            <input
              id="username"
              className="input"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
            {status && (
              <p className="mt-1.5 text-[11px] text-muted">
                {t('setup.username.rules', {
                  min: status.rules.minUsernameLength,
                  max: status.rules.maxUsernameLength,
                })}
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="password">
              {t('setup.password.label')}
            </label>
            <input
              id="password"
              className="input"
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
            {passwordTooShort && (
              <p className="mt-1.5 text-[11px] text-danger">
                {t('setup.password.tooShort', { count: minPassword })}
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="confirm">
              {t('setup.confirm.label')}
            </label>
            <input
              id="confirm"
              className="input"
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
            />
            {mismatch && (
              <p className="mt-1.5 text-[11px] text-danger">{t('setup.confirm.mismatch')}</p>
            )}
          </div>

          {error && <Notice tone="error">{error}</Notice>}
          {!error && statusFailed && <Notice tone="error">{t('setup.statusFailed')}</Notice>}

          <button type="submit" className="btn-primary w-full" disabled={!canSubmit}>
            {busy ? t('setup.submitting') : t('setup.submit')}
          </button>

          <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
            <Icon name="shield" className="mt-0.5 size-3.5 shrink-0" />
            {t('setup.securityNote')}
          </div>
        </form>

        <p className="mt-5 text-center text-[11px] text-muted">{t('app.selfHostedNote')}</p>
      </div>
    </div>
  );
}
