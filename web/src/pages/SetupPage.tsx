import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { SetupStatus } from '../lib/types';
import { Icon, Notice } from '../components/ui';

/**
 * 首次初始化页。
 *
 * 用户在这里自己设置管理员用户名与口令，而不是去控制台抄一个随机口令。
 * 门禁是服务端启动时打印的一次性初始化令牌：能读到控制台的人才算部署者。
 */
export default function SetupPage(): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
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
        setError('无法读取初始化状态，请确认服务已启动');
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
      setError(cause instanceof ApiError ? cause.message : '初始化失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-canvas flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
            <Icon name="shield" className="size-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-ink">设置管理员账号</h1>
          <p className="mt-1 text-sm text-muted">
            这是首次启动。请设置你自己的用户名与口令，完成后即可登录。
          </p>
        </div>

        <form onSubmit={(event) => void submit(event)} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="token">
              初始化令牌
            </label>
            <input
              id="token"
              className="input font-mono text-[13px]"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="setup_…"
              onChange={(event) => setToken(event.target.value)}
            />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              首次启动时打印在服务端控制台。令牌只用于认领管理员账号，设置完成后立即失效。
              看不到？删除 <code className="font-mono">data/setup.json</code> 后重启服务会重新生成。
            </p>
          </div>

          <div>
            <label className="label" htmlFor="username">
              用户名
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
                {status.rules.minUsernameLength}–{status.rules.maxUsernameLength} 个字符，
                只用字母、数字、点、下划线与连字符。
              </p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="password">
              口令
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
              <p className="mt-1.5 text-[11px] text-danger">口令至少 {minPassword} 位</p>
            )}
          </div>

          <div>
            <label className="label" htmlFor="confirm">
              确认口令
            </label>
            <input
              id="confirm"
              className="input"
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
            />
            {mismatch && <p className="mt-1.5 text-[11px] text-danger">两次输入的口令不一致</p>}
          </div>

          {error && <Notice tone="error">{error}</Notice>}

          <button type="submit" className="btn-primary w-full" disabled={!canSubmit}>
            {busy ? '正在创建…' : '创建管理员并登录'}
          </button>

          <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted">
            <Icon name="shield" className="mt-0.5 size-3.5 shrink-0" />
            口令只保存 scrypt 哈希，服务端无法还原明文；初始化令牌在完成后作废。
          </div>
        </form>

        <p className="mt-5 text-center text-[11px] text-muted">
          自托管 · 单进程 · 数据留在本机
        </p>
      </div>
    </div>
  );
}
