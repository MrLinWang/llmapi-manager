import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { applyLanguage } from '../i18n';
import type { UiLanguage } from '../i18n/language';
import { roleLabel, type MessageKey } from '../lib/labels';
import { LanguageSelect } from '../components/LanguageSelect';
import { Icon, IconButton, Notice, type IconName } from '../components/ui';

/**
 * 导航项只存文案键、不存文案：语言切换要立刻生效，把中文写死在这里
 * 就得在切换时重建数组，而键是稳定的、`t()` 每次渲染都会取当前语言。
 */
interface NavItem {
  to: string;
  labelKey: MessageKey;
  permission: string;
  icon: IconName;
}

const NAV_GROUPS: Array<{ labelKey: MessageKey; items: NavItem[] }> = [
  {
    labelKey: 'app.nav.groupConsole',
    items: [{ to: '/', labelKey: 'app.nav.overview', permission: 'logs:read', icon: 'overview' }],
  },
  {
    labelKey: 'app.nav.groupConfig',
    items: [
      {
        to: '/providers',
        labelKey: 'app.nav.providers',
        permission: 'providers:read',
        icon: 'providers',
      },
      {
        to: '/models',
        labelKey: 'app.nav.models',
        permission: 'providers:read',
        icon: 'models',
      },
      {
        to: '/agents',
        labelKey: 'app.nav.agents',
        permission: 'agents:read',
        icon: 'agents',
      },
      {
        to: '/settings',
        labelKey: 'app.nav.settings',
        permission: 'settings:read',
        icon: 'settings',
      },
    ],
  },
];

/** 面包屑与侧边栏共用 `app.nav.*`：两处各写一份会出现"侧边栏改了、面包屑没改"。 */
const PAGE_META: Record<string, { groupKey: MessageKey; labelKey: MessageKey }> = {
  '/': { groupKey: 'app.nav.groupConsole', labelKey: 'app.nav.overview' },
  '/providers': { groupKey: 'app.nav.groupConfig', labelKey: 'app.nav.providers' },
  '/models': { groupKey: 'app.nav.groupConfig', labelKey: 'app.nav.models' },
  '/agents': { groupKey: 'app.nav.groupConfig', labelKey: 'app.nav.agents' },
  '/settings': { groupKey: 'app.nav.groupConfig', labelKey: 'app.nav.settings' },
};

function Brand(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-strong text-white shadow-sm">
        <Icon name="sparkles" className="size-[18px]" />
      </span>
      <div className="min-w-0">
        {/* `app.brand` 中英两份文本相同：产品名不随语言变化，但仍走字典以统一取文案的路径 */}
        <p className="truncate text-sm font-semibold tracking-tight text-ink">{t('app.brand')}</p>
        <p className="text-[11px] text-muted">{t('app.tagline')}</p>
      </div>
    </div>
  );
}

function SidebarContent({
  can,
  username,
  role,
  language,
  languageEditable,
  languagePending,
  languageFailed,
  onLanguageChange,
  onNavigate,
  onLogout,
}: {
  can: (permission: string) => boolean;
  username: string;
  role: string;
  language: UiLanguage | null;
  /** 有 settings:write 才允许改；否则只读展示 */
  languageEditable: boolean;
  languagePending: boolean;
  /** 落盘失败的标记：失败时界面语言已回滚，这里只负责提示 */
  languageFailed: boolean;
  onLanguageChange: (language: UiLanguage | null) => void;
  onNavigate?: () => void;
  onLogout: () => void;
}): JSX.Element {
  const { t } = useTranslation();
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
            <div key={group.labelKey} className="mb-5 last:mb-0">
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted/80">
                {t(group.labelKey)}
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
                        <span className="truncate">{t(item.labelKey)}</span>
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
        {/* 语言选择器放在用户卡片上方：它跟"当前是谁"无关，但和账号一样是全局偏好 */}
        <div className="mb-2.5 px-1">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted/80">
            {t('app.language.label')}
          </p>
          {/* 无 settings:write 时只读：下拉框本身已有 aria-label，这里只用 title 说明原因 */}
          <div title={languageEditable ? undefined : t('app.language.readOnly')}>
            <LanguageSelect
              value={language}
              disabled={!languageEditable || languagePending}
              onChange={onLanguageChange}
              className="input"
            />
          </div>
          {languageFailed && (
            <p className="mt-1 text-[11px] text-danger" role="alert">
              {t('app.language.saveFailed')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2.5 rounded-xl bg-subtle/70 px-3 py-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{username}</p>
            <p className="text-[11px] text-muted">{role}</p>
          </div>
          <IconButton icon="logout" label={t('app.logout')} onClick={onLogout} />
        </div>
      </div>
    </>
  );
}

export default function Layout(): JSX.Element {
  const { me, logout, can, refresh } = useAuth();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [warnings, setWarnings] = useState<Array<{ code: string; message: string }>>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [languagePending, setLanguagePending] = useState(false);
  const [languageFailed, setLanguageFailed] = useState(false);
  /**
   * 已选但还没落盘的语言（`undefined` = 以服务端为准）。
   *
   * 为什么不直接把 select 的 value 绑服务端值：下拉框是受控的，
   * 保存请求回来之前 `me.language` 还是旧值，React 会用旧值把下拉框重置回去，
   * 用户看到的就是"点了选项又跳回原来那个"。成功后 `refresh()` 更新 `me` 再清掉这里。
   */
  const [languageDraft, setLanguageDraft] = useState<UiLanguage | null | undefined>(undefined);

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

  /**
   * 切换界面语言并落盘。
   *
   * `LanguageSelect` 内部已经乐观地 `applyLanguage(next)`（点了就能看到效果），
   * 这里只负责持久化。落盘失败必须回滚，否则会出现"看着切了、刷新又变回去"。
   *
   * 落盘成功后再 `refresh()` 重取 `/api/auth/me`：下拉框的 `value` 最终取自
   * `me.language`（服务端是唯一真源），不刷新就会"界面英文、下拉框还显示中文"。
   * 但**刷新失败不能回滚**——语言已经存进服务端了，把界面切回去反而与该真源不符。
   */
  const changeLanguage = async (next: UiLanguage | null): Promise<void> => {
    const previous = me?.language ?? null;
    if (next === previous) return;
    setLanguageDraft(next);
    setLanguagePending(true);
    setLanguageFailed(false);
    let persisted = false;
    try {
      await api.setLanguage(next);
      persisted = true;
      await refresh();
    } catch {
      if (!persisted) {
        applyLanguage(previous);
        setLanguageFailed(true);
      }
    } finally {
      // 请求飞行期间由 draft 顶住受控值；这里交还给服务端值（refresh 已更新 me）
      setLanguageDraft(undefined);
      setLanguagePending(false);
    }
  };

  const username = me?.user.username ?? t('app.notLoggedIn');
  const role = roleLabel(t, me?.user.role);
  const meta = PAGE_META[location.pathname];
  // 未知路径（理论上会被路由重定向掉）仍给出分组、不给标题，避免闪出一串键名
  const groupLabel = t(meta?.groupKey ?? 'app.nav.groupConsole');
  const pageLabel = meta ? t(meta.labelKey) : '';
  // 等待落盘期间用 local state 顶住受控值，避免被服务端旧值弹回去
  const language = languageDraft !== undefined ? languageDraft : (me?.language ?? null);
  const languageEditable = can('settings:write');

  return (
    <div className="flex min-h-screen bg-surface">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-elevated lg:flex">
        <SidebarContent
          can={can}
          username={username}
          role={role}
          language={language}
          languageEditable={languageEditable}
          languagePending={languagePending}
          languageFailed={languageFailed}
          onLanguageChange={(next) => void changeLanguage(next)}
          onLogout={() => void doLogout()}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-elevated/85 px-4 backdrop-blur-md lg:px-8">
          <IconButton
            icon="menu"
            label={t('app.openMenu')}
            className="lg:hidden"
            onClick={() => setDrawerOpen(true)}
          />
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-sm text-muted sm:inline">{groupLabel}</span>
            <Icon
              name="chevron-right"
              className="hidden size-3.5 text-muted/50 sm:inline"
            />
            <span className="truncate text-sm font-medium text-ink">{pageLabel}</span>
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
              {warnings.length > 0
                ? t('app.startupWarnings', { count: warnings.length })
                : t('app.serviceOk')}
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
                  {/* 告警文案由服务端按 Accept-Language 渲染（见 server/src/resilience.ts），这里直接显示 */}
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
          {t('app.footer')}
        </footer>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label={t('app.closeMenu')}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-elevated shadow-pop">
            <IconButton
              icon="x"
              label={t('app.closeMenu')}
              className="absolute right-2 top-2 z-10"
              onClick={() => setDrawerOpen(false)}
            />
            <SidebarContent
              can={can}
              username={username}
              role={role}
              language={language}
              languageEditable={languageEditable}
              languagePending={languagePending}
              languageFailed={languageFailed}
              onLanguageChange={(next) => void changeLanguage(next)}
              onNavigate={() => setDrawerOpen(false)}
              onLogout={() => void doLogout()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
