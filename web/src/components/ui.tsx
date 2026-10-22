import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconName =
  | 'overview'
  | 'providers'
  | 'models'
  | 'agents'
  | 'settings'
  | 'logout'
  | 'plus'
  | 'refresh'
  | 'activity'
  | 'check'
  | 'clock'
  | 'alert'
  | 'info'
  | 'x'
  | 'menu'
  | 'chevron-right'
  | 'copy'
  | 'key'
  | 'link'
  | 'edit'
  | 'trash'
  | 'arrow-up'
  | 'arrow-down'
  | 'play'
  | 'terminal'
  | 'server'
  | 'globe'
  | 'shield'
  | 'sparkles'
  | 'inbox'
  | 'user'
  | 'zap';

const ICONS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  providers: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  models: (
    <>
      <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
      <path d="m4 12 8 4.5 8-4.5" />
      <path d="m4 16.5 8 4.5 8-4.5" />
    </>
  ),
  agents: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="14" cy="18" r="2" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  check: <path d="m20 6-11 11-5-5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m11 12 9-9M17 4l3 3M14 7l3 3" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.07 0l2-2a5 5 0 0 0-7.07-7.07l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-2 2A5 5 0 0 0 12 20.07l1.1-1.1" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </>
  ),
  'arrow-up': <path d="m18 15-6-6-6 6" />,
  'arrow-down': <path d="m6 9 6 6 6-6" />,
  play: <path d="m6 3 14 9-14 9V3Z" />,
  terminal: <path d="m4 17 6-6-6-6M12 19h8" />,
  server: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </>
  ),
  shield: <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />,
  sparkles: (
    <>
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
      <path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 4h16l2 10v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4L4 4Z" />
      <path d="M2 14h6l2 3h4l2-3h6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  zap: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />,
};

export function Icon({
  name,
  className = 'size-4',
}: {
  name: IconName;
  className?: string;
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted">
            {eyebrow}
          </p>
        )}
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  desc,
  actions,
  children,
  flush = false,
  className = '',
}: {
  title?: string;
  desc?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** 表格类内容使用：去掉正文内边距，让表头贴边 */
  flush?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {desc && <p className="mt-0.5 text-xs leading-5 text-muted">{desc}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={flush ? '' : 'card-body'}>{children}</div>
    </section>
  );
}

const NOTICE_STYLES = {
  info: 'border-accent/25 bg-accent-soft/70 text-ink',
  warn: 'border-warn/30 bg-warn/10 text-ink',
  error: 'border-danger/25 bg-danger/10 text-ink',
  ok: 'border-ok/25 bg-ok/10 text-ink',
} as const;

const NOTICE_ICONS: Record<keyof typeof NOTICE_STYLES, IconName> = {
  info: 'info',
  warn: 'alert',
  error: 'alert',
  ok: 'check',
};

const NOTICE_ICON_STYLES: Record<keyof typeof NOTICE_STYLES, string> = {
  info: 'text-accent',
  warn: 'text-warn',
  error: 'text-danger',
  ok: 'text-ok',
};

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs leading-5 ${NOTICE_STYLES[tone]}`}
    >
      <Icon name={NOTICE_ICONS[tone]} className={`mt-0.5 size-4 shrink-0 ${NOTICE_ICON_STYLES[tone]}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Spinner({ label = '加载中…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2.5 py-10 text-xs text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </div>
  );
}

const BADGE_STYLES = {
  neutral: 'border-line bg-subtle text-muted',
  ok: 'border-ok/20 bg-ok/10 text-ok',
  danger: 'border-danger/20 bg-danger/10 text-danger',
  warn: 'border-warn/25 bg-warn/10 text-warn',
  accent: 'border-accent/20 bg-accent-soft text-accent',
} as const;

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: 'neutral' | 'ok' | 'danger' | 'warn' | 'accent';
  dot?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className={`badge ${BADGE_STYLES[tone]}`}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Empty({
  children,
  icon = 'inbox',
}: {
  children: ReactNode;
  icon?: IconName;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <span className="flex size-11 items-center justify-center rounded-2xl border border-line bg-subtle text-muted">
        <Icon name={icon} className="size-5" />
      </span>
      <p className="max-w-md text-xs leading-5 text-muted">{children}</p>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  loading,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: IconName;
  loading?: boolean;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      {icon && (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name={icon} className="size-[18px]" />
        </span>
      )}
      <div className="min-w-0">
        <p className="text-xs text-muted">{label}</p>
        <p className="mt-0.5 text-2xl font-semibold tracking-tight tabular-nums text-ink">
          {loading ? <span className="text-muted">…</span> : value}
        </p>
        {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
      </div>
    </div>
  );
}

export function IconButton({
  icon,
  label,
  tone = 'ghost',
  className = '',
  ...rest
}: {
  icon: IconName;
  label: string;
  tone?: 'ghost' | 'danger';
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={rest.title ?? label}
      className={`btn-icon ${tone === 'danger' ? 'hover:bg-danger/10 hover:text-danger' : ''} ${className}`}
      {...rest}
    >
      <Icon name={icon} className="size-4" />
    </button>
  );
}
