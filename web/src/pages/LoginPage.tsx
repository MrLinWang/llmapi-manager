import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Icon, Notice } from '../components/ui';

export default function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('owner');
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
      setError(cause instanceof ApiError ? cause.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-canvas flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
            <Icon name="sparkles" className="size-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight text-ink">LLM API Manager</h1>
          <p className="mt-1 text-sm text-muted">聚合你的各个供应商，并统一下发到本地 Agent</p>
        </div>

        <form onSubmit={(event) => void submit(event)} className="card space-y-4 p-6">
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
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          <button type="submit" className="btn-primary w-full" disabled={busy || !password}>
            {busy ? '登录中…' : '登录'}
          </button>
          <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted">
            <Icon name="shield" className="size-3.5" />
            首次启动的初始口令打印在服务端控制台
          </div>
        </form>

        <p className="mt-5 text-center text-[11px] text-muted">
          自托管 · 单进程 · 数据留在本机
        </p>
      </div>
    </div>
  );
}
