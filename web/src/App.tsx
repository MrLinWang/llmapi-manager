import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Layout from './pages/Layout';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import ProvidersPage from './pages/ProvidersPage';
import ModelsPage from './pages/ModelsPage';
import AgentsPage from './pages/AgentsPage';
import SettingsPage from './pages/SettingsPage';
import { Spinner } from './components/ui';

function Guarded({ children }: { children: JSX.Element }): JSX.Element {
  const { me, loading } = useAuth();
  if (loading) return <Spinner label="正在校验登录状态…" />;
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

export default function App(): JSX.Element {
  const { me, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <Spinner /> : me ? <Navigate to="/" replace /> : <LoginPage />}
      />
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
