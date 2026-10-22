import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { roleLabel } from '../lib/labels';
import { Icon, IconButton, Notice, type IconName } from '../components/ui';

interface NavItem {
  to: string;
  label: string;
  permission: string;
  icon: IconName;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '控制台',
    items: [{ to: '/', label: '概览', permission: 'logs:read', icon: 'overview' }],
  },
  {
    label: '配置',
    items: [
      { to: '/providers', label: '供应商', permission: 'providers:read', icon: 'providers' },
      { to: '/models', label: '模型聚合', permission: 'providers:read', icon: 'models' },
      { to: '/agents', label: 'Agent 配置', permission: 'agents:read', icon: 'agents' },
      { to: '/settings', label: '设置', permission: 'settings:read', icon: 'settings' },
    ],
  },
];

const PAGE_META: Record<string, { group: string; label: string }> = {
  '/': { group: '控制台', label: '概览' },
  '/providers': { group: '配置', label: '供应商' },
  '/models': { group: '配置', label: '模型聚合' },
  '/agents': { group: '配置', label: 'Agent 配置' },
  '/settings': { group: '配置', label: '设置' },
};

function Brand(): JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
        <Icon name="sparkles" className="size-[18px]" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-ink">LLM API Manager</p>
        <p className="text-[11px] text-muted">自托管网关控制台</p>
      </div>
    </div>
  );
}

function SidebarContent({
  can,
  username,
  role,
  onNavigate,
  onLogout,
}: {
  can: (permission: string) => boolean;
  username: string;
  role: string;
  onNavigate?: () => void;
  onLogout: () => void;
}): JSX.Element {
  const initial = (username || 'U').slice(0, 1).toUpperCase();

  return (
    <>
      <div className="flex h-16 shrink-0 items-center border-b border-line px-5">
        <Brand />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => can(item.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="mb-5 last:mb-0">
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted/80">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-accent-soft text-accent'
                          : 'text-muted hover:bg-subtle hover:text-ink'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon name={item.icon} className="size-[18px] shrink-0" />
                        <span className="truncate">{item.label}</span>
                        {isActive && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-center gap-2.5 rounded-xl bg-subtle/70 px-3 py-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{username}</p>
            <p className="text-[11px] text-muted">{role}</p>
          </div>
          <IconButton icon="logout" label="退出登录" onClick={onLogout} />
        </div>
      </div>
    </>
  );
}

export default function Layout(): JSX.Element {
  const { me, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [warnings, setWarnings] = useState<Array<{ code: string; message: string }>>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    api
      .health()
      .then((result) => setWarnings(result.warnings))
      .catch(() => setWarnings([]));
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [drawerOpen]);

  const doLogout = async (): Promise<void> => {
    await logout();
    navigate('/login', { replace: true });
  };

  const username = me?.user.username ?? '未登录';
  const role = roleLabel(me?.user.role);
  const meta = PAGE_META[location.pathname] ?? { group: '控制台', label: '' };

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-elevated lg:flex">
        <SidebarContent
          can={can}
          username={username}
          role={role}
          onLogout={() => void doLogout()}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-elevated/85 px-4 backdrop-blur-md lg:px-8">
          <IconButton
            icon="menu"
            label="打开菜单"
            className="lg:hidden"
            onClick={() => setDrawerOpen(true)}
          />
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-sm text-muted sm:inline">{meta.group}</span>
            <Icon
              name="chevron-right"
              className="hidden size-3.5 text-muted/50 sm:inline"
            />
            <span className="truncate text-sm font-medium text-ink">{meta.label}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium sm:inline-flex ${
                warnings.length > 0
                  ? 'border-warn/30 bg-warn/10 text-warn'
                  : 'border-ok/20 bg-ok/10 text-ok'
              }`}
            >
              <span className="size-1.5 rounded-full bg-current" />
              {warnings.length > 0 ? `${warnings.length} 条启动告警` : '服务正常'}
            </span>
            <div className="hidden items-center gap-2 border-l border-line pl-3 lg:flex">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
                {(username || 'U').slice(0, 1).toUpperCase()}
              </span>
              <div className="leading-tight">
                <p className="text-xs font-medium text-ink">{username}</p>
                <p className="text-[10px] text-muted">{role}</p>
              </div>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 lg:px-8">
          <div className="mx-auto w-full max-w-6xl space-y-4">
            {warnings.length > 0 && (
              <Notice tone="warn">
                <div className="space-y-0.5">
                  {warnings.map((item) => (
                    <p key={item.code}>{item.message}</p>
                  ))}
                </div>
              </Notice>
            )}
            <div key={location.pathname} className="page-enter space-y-5">
              <Outlet />
            </div>
          </div>
        </main>

        <footer className="px-4 pb-6 text-center text-[11px] text-muted lg:px-8">
          LLM API Manager · 自托管 LLM API 控制台
        </footer>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="关闭菜单"
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-elevated shadow-pop">
            <IconButton
              icon="x"
              label="关闭菜单"
              className="absolute right-2 top-2 z-10"
              onClick={() => setDrawerOpen(false)}
            />
            <SidebarContent
              can={can}
              username={username}
              role={role}
              onNavigate={() => setDrawerOpen(false)}
              onLogout={() => void doLogout()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
