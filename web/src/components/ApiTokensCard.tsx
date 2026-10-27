import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/useAsync';
import type { ApiTokenView } from '../lib/types';
import { Badge, Card, Icon, Notice } from '../components/ui';
import { CopyButton } from '../components/CopyButton';
import { permissionLabel } from '../lib/labels';
import { formatTimestamp } from '../i18n/format';

/**
 * API 令牌管理。
 *
 * 令牌用于程序化访问 `/api/*` 管理面（脚本、CI），与网关令牌（`lam_`，给
 * Codex/Claude Code 调 `/v1/*` 转发）是两套东西，界面上要说清否则用户会混。
 */
export function ApiTokensCard(): JSX.Element {
  const { can } = useAuth();
  const { t } = useTranslation();
  const tokens = useAsync(() => api.apiTokens());
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** 刚创建的明文令牌：只在这里出现一次，关闭后不可再看 */
  const [revealed, setRevealed] = useState<string | null>(null);

  const available = tokens.data?.availableScopes ?? [];
  // 只能勾选自己拥有的权限，否则服务端会 403
  const grantable = available.filter((item) => can(item));

  const create = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (name.trim() === '') {
      setError(t('tokens.name.required'));
      return;
    }
    if (scopes.length === 0) {
      setError(t('tokens.scopes.required'));
      return;
    }
    setBusy(true);
    try {
      const result = await api.createApiToken({
        name: name.trim(),
        scopes,
        // 空字符串表示不过期
        expiresAt: expiresAt === '' ? null : new Date(expiresAt).toISOString(),
      });
      setRevealed(result.token);
      setName('');
      setScopes([]);
      setExpiresAt('');
      tokens.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: ApiTokenView): Promise<void> => {
    setError(null);
    setMessage(null);
    if (!window.confirm(t('tokens.revokeConfirm', { name: token.name }))) return;
    setBusy(true);
    try {
      await api.revokeApiToken(token.id);
      setMessage(t('tokens.revokeDone', { name: token.name }));
      tokens.reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.revokeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('tokens.title')} desc={t('tokens.desc')}>
      {revealed && (
        <div className="mb-4 rounded-xl border border-accent/40 bg-accent-soft/60 p-4">
          <p className="text-xs font-medium text-ink">
            {/* `<strong>` 是对"看不到第二次"的强调，交给内联标记，避免拆句后语序别扭 */}
            <Trans i18nKey="tokens.revealed.title" components={{ strong: <strong /> }} />
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-canvas px-2 py-1.5 font-mono text-[11px] text-ink">
              {revealed}
            </code>
            <CopyButton value={revealed} />
            <button type="button" className="btn-ghost btn-sm" onClick={() => setRevealed(null)}>
              {t('tokens.revealed.saved')}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-4 text-muted">
            {/* `Authorization: Bearer` 与 `<令牌>` 是照抄用的标识符，不翻译 */}
            {t('tokens.revealed.usage')}
            <code className="font-mono">{t('tokens.revealed.authorizationHeader')}</code>
          </p>
        </div>
      )}

      {error && (
        <div className="mb-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {message && (
        <div className="mb-3">
          <Notice tone="ok">{message}</Notice>
        </div>
      )}

      <form onSubmit={(event) => void create(event)} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="token-name">
              {t('tokens.name.label')}
            </label>
            <input
              id="token-name"
              className="input"
              placeholder={t('tokens.name.placeholder')}
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="token-expires">
              {t('tokens.expires.label')}
            </label>
            <input
              id="token-expires"
              className="input"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </div>
        </div>

        <div>
          <span className="label">{t('tokens.scopes.label')}</span>
          <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
            {grantable.map((item) => (
              <label key={item} className="flex cursor-pointer items-center gap-2 text-xs text-ink">
                <input
                  type="checkbox"
                  className="size-3.5 accent-accent"
                  checked={scopes.includes(item)}
                  onChange={(event) =>
                    setScopes((prev) =>
                      event.target.checked ? [...prev, item] : prev.filter((x) => x !== item),
                    )
                  }
                />
                <span className="font-mono text-[11px]">{item}</span>
                <span className="text-muted">{permissionLabel(t, item)}</span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-muted">{t('tokens.scopes.hint')}</p>
        </div>

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('tokens.submitting') : t('tokens.submit')}
        </button>
      </form>

      <div className="mt-5 border-t border-line pt-4">
        {tokens.loading ? (
          <p className="text-xs text-muted">{t('common.loading')}</p>
        ) : (tokens.data?.tokens.length ?? 0) === 0 ? (
          <p className="text-xs text-muted">{t('tokens.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {tokens.data?.tokens.map((token) => {
              const revoked = token.revokedAt !== null;
              const expired =
                token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now();
              return (
                <li
                  key={token.id}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2"
                >
                  <Icon name="key" className="size-3.5 text-muted" />
                  <span className="text-xs font-medium text-ink">{token.name}</span>
                  <code className="font-mono text-[11px] text-muted">
                    {token.prefix}…{token.tail}
                  </code>
                  {revoked ? (
                    <Badge tone="danger">{t('tokens.status.revoked')}</Badge>
                  ) : expired ? (
                    <Badge tone="warn">{t('tokens.status.expired')}</Badge>
                  ) : (
                    <Badge tone="ok">{t('tokens.status.active')}</Badge>
                  )}
                  <span className="text-[11px] text-muted">
                    {token.scopes.map((permission) => permissionLabel(t, permission)).join(t('tokens.scopes.separator'))}
                  </span>
                  <span className="text-[11px] text-muted">
                    {token.lastUsedAt
                      ? t('tokens.lastUsed', { time: formatTimestamp(token.lastUsedAt) })
                      : t('tokens.neverUsed')}
                  </span>
                  {!revoked && can('settings:write') && (
                    <button
                      type="button"
                      className="btn-ghost btn-sm ml-auto"
                      disabled={busy}
                      onClick={() => void revoke(token)}
                    >
                      {t('tokens.revoke')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
