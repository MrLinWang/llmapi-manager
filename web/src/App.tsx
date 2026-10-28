import { Navigate, Route, Routes } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './lib/auth';
import { api } from './lib/api';
import Layout from './pages/Layout';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import OverviewPage from './pages/OverviewPage';
import ProvidersPage from './pages/ProvidersPage';
import ModelsPage from './pages/ModelsPage';
import AgentsPage from './pages/AgentsPage';
import SettingsPage from './pages/SettingsPage';
import SyncPage from './pages/SyncPage';
import { Spinner } from './components/ui';

function Guarded({ children }: { children: JSX.Element }): JSX.Element {
  const { me, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <Spinner label={t('app.checkingSession')} />;
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

/**
 * 初始化闸门。
 *
 * 为什么单列一层：未初始化时还没有任何账号，`/api/auth/me` 必然 401，
 * 不能复用登录态判断"该去登录页还是设置页"。所以先问免鉴权的 /api/setup/status。
 */
function useSetupGate(): { checking: boolean; needsSetup: boolean } {
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const status = await api.setupStatus();
        setNeedsSetup(status.needsSetup);
      } catch {
        // 读不到状态时不要卡死用户：按"已初始化"处理，让登录页给出更具体的错误
        setNeedsSetup(false);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  return { checking, needsSetup };
}

export default function App(): JSX.Element {
  const { me, loading } = useAuth();
  const setup = useSetupGate();
  const { t } = useTranslation();

  if (setup.checking || loading) return <Spinner label={t('app.preparing')} />;

  // 未初始化：任何路径都先去设置页，避免用户面对一个还不存在的账号
  if (setup.needsSetup) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/setup" element={<Navigate to={me ? '/' : '/login'} replace />} />
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        element={
          <Guarded>
            <Layout />
          </Guarded>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="providers" element={<ProvidersPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="sync" element={<SyncPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
