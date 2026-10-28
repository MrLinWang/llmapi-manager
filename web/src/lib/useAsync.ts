import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import i18next from '../i18n';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * 极小的数据获取 hook：本期页面都不需要缓存/失效策略，
 * 为此引入 react-query/swr 这类数据层并不划算——`useAsync` 自己只有几十行，
 * 而数据层的配置、失效语义与调试成本反而更高。
 *
 * 注意这只针对"数据请求层"：界面文案走 `web/src/i18n`（i18next），
 * 两者互不替代。
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : i18next.t('common.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload: () => setNonce((value) => value + 1) };
}

export { api };
