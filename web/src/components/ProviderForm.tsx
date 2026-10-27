import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import type { ModelCapability, Provider } from '../lib/types';
import { Badge, IconButton, Notice } from './ui';
import { API_TYPE_META } from '../lib/labels';

export interface ProviderFormValues {
  name: string;
  apiType: 'openai' | 'anthropic' | 'responses';
  baseUrl: string;
  apiKey: string;
  modelsText: string;
  notes: string;
  websiteUrl: string;
}

export function toFormValues(provider?: Provider): ProviderFormValues {
  return {
    name: provider?.name ?? '',
    apiType: provider?.apiType ?? 'openai',
    baseUrl: provider?.baseUrl ?? '',
    apiKey: '',
    modelsText: provider?.models.join('\n') ?? '',
    notes: provider?.notes ?? '',
    websiteUrl: provider?.websiteUrl ?? '',
  };
}

function SectionTitle({ title }: { title: string }): JSX.Element {
  return (
    <p className="mb-3 flex items-center gap-2 text-xs font-semibold text-ink">
      <span className="h-3 w-0.5 rounded-full bg-accent" />
      {title}
    </p>
  );
}

export function ProviderForm({
  provider,
  onSaved,
  onCancel,
}: {
  provider?: Provider;
  onSaved: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [values, setValues] = useState<ProviderFormValues>(toFormValues(provider));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 从上游拉回、等待用户勾选的模型 */
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchHint, setFetchHint] = useState<string | null>(null);
  /**
   * 按模型名记录的上游能力（上下文窗口等），保存时随供应商提交。
   *
   * 初始值来自已保存的供应商：编辑时若不再重新拉列表，不能把已有能力丢掉
   * （丢了目录就会退回 128k）。只在拉到新数据时合并覆盖。
   */
  const [capabilities, setCapabilities] = useState<Record<string, ModelCapability>>(
    () => ({ ...(provider?.modelCapabilities ?? {}) }),
  );
  /** 模型框末尾那个空白片段里正在输入的文本 */
  const [draft, setDraft] = useState('');
  const draftInput = useRef<HTMLInputElement>(null);
  // 同一页面可能同时存在多个表单实例（如编辑弹窗 + 页面表单），
  // 固定 id 会让 label 的 htmlFor 关联到别的实例的输入框。
  const modelInputId = useId();

  const selectedMeta =
    API_TYPE_META.find((item) => item.value === values.apiType) ?? API_TYPE_META[0];

  const update = <K extends keyof ProviderFormValues>(
    key: K,
    value: ProviderFormValues[K],
  ): void => setValues((prev) => ({ ...prev, [key]: value }));

  const currentModels = (): string[] =>
    values.modelsText
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

  /**
   * 去重后回写模型列表：保留原有顺序，新增的排后面。
   * 仍然以换行分隔的单个字符串存进表单状态，提交时后端按行解析；
   * 标签片段只是它的渲染形态，不是另一份数据。
   */
  const writeModels = (models: string[]): void => {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const item of models) {
      if (seen.has(item)) continue;
      seen.add(item);
      unique.push(item);
    }
    update('modelsText', unique.join('\n'));
  };

  /** 把输入框里的草稿提交为模型片段；逗号/换行分隔的会被拆开。 */
  const commitDraft = (): void => {
    const pieces = draft
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (pieces.length === 0) {
      setDraft('');
      return;
    }
    writeModels([...currentModels(), ...pieces]);
    setDraft('');
  };

  const loadModels = async (): Promise<void> => {
    setFetching(true);
    setFetchError(null);
    setFetchHint(null);
    try {
      const result = await api.fetchProviderModels({
        apiType: values.apiType,
        baseUrl: values.baseUrl.trim(),
        // 编辑态且没重填 Key 时，交给服务端沿用已保存的 Key
        apiKey: values.apiKey.trim() || undefined,
        providerId: provider?.id,
      });
      if (!result.ok || !result.models) {
        setFetchError(result.error ?? t('providerForm.models.fetchFailed'));
        setCandidates(null);
        return;
      }
      if (result.models.length === 0) {
        setFetchHint(t('providerForm.models.emptyList'));
        setCandidates(null);
        return;
      }
      setCandidates(result.models);
      // 记下上游声明的上下文窗口：保存时一并提交，Codex 目录会用它，
      // 否则只能回落 128k，1M 上下文的上游只用到约十分之一。
      // 合并而不是覆盖：只更新这次拉到能力的模型，其余模型保留原值。
      if (result.capabilities) {
        const incoming = result.capabilities;
        setCapabilities((prev) => ({ ...prev, ...incoming }));
      }
      const withCaps = result.capabilities
        ? Object.keys(result.capabilities).length
        : 0;
      // 两段都是计数句：用 `_one` / `_other` 复数键，英文才会跟着单复数变。
      setFetchHint(
        t('providerForm.models.fetched', {
          count: result.models.length,
          latencyMs: result.latencyMs,
        }) +
          (withCaps > 0 ? t('providerForm.models.withCapabilities', { count: withCaps }) : ''),
      );
    } catch (cause) {
      setFetchError(cause instanceof ApiError ? cause.message : t('common.fetchModelsFailed'));
      setCandidates(null);
    } finally {
      setFetching(false);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const models = values.modelsText
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (models.length === 0) {
      setError(t('providerForm.models.requireOne'));
      setBusy(false);
      return;
    }
    // 只提交仍在模型列表里的能力；服务端还会再裁一次（两处都做是因为
    // 用户可能先拉列表再删模型，前端这次提交就已经带着过期条目了）。
    const keptCapabilities = Object.fromEntries(
      Object.entries(capabilities).filter(([model]) => models.includes(model)),
    );
    const body = {
      name: values.name.trim(),
      apiType: values.apiType,
      baseUrl: values.baseUrl.trim(),
      apiKey: values.apiKey.trim() === '' ? undefined : values.apiKey.trim(),
      modelCapabilities:
        Object.keys(keptCapabilities).length > 0 ? keptCapabilities : undefined,
      models,
      notes: values.notes.trim() || undefined,
      websiteUrl: values.websiteUrl.trim() || undefined,
    };
    try {
      if (provider) await api.updateProvider(provider.id, body);
      else await api.createProvider(body);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="card overflow-hidden">
      <div className="card-header">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {provider
              ? t('providerForm.header.titleEdit')
              : t('providerForm.header.titleCreate')}
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-muted">
            {t('providerForm.header.desc')}
          </p>
        </div>
        <IconButton
          icon="x"
          label={t('providerForm.header.close')}
          onClick={onCancel}
        />
      </div>

      <div className="space-y-5 p-5">
        <section>
          <SectionTitle title={t('providerForm.sections.basic')} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t('providerForm.basic.name')}</label>
              <input
                className="input"
                value={values.name}
                placeholder={t('providerForm.basic.namePlaceholder')}
                onChange={(event) => update('name', event.target.value)}
              />
              {provider && (
                <p className="field-hint">
                  {t('providerForm.basic.aliasPrefix', { key: provider.providerKey })}
                </p>
              )}
            </div>
            <div>
              <label className="label">{t('providerForm.basic.apiType')}</label>
              <select
                className="input"
                value={values.apiType}
                onChange={(event) =>
                  update('apiType', event.target.value as 'openai' | 'anthropic' | 'responses')
                }
              >
                {API_TYPE_META.map((meta) => (
                  <option key={meta.value} value={meta.value}>
                    {t(meta.labelKey)}
                  </option>
                ))}
              </select>
              {/*
                这里没有用 <Trans>：句中夹着 selectedMeta.path（协议路径，是动态值、
                且包在 <code> 里）。拆成前后半句、把 <code> 留在 JSX，
                既不用往字典里传 React 组件，也不会让路径被误当成可翻译文本。
              */}
              <p className="field-hint">
                {t('providerForm.basic.protocolHintPrefix')}{' '}
                <code className="font-mono">{selectedMeta.path}</code>
                {t('providerForm.basic.protocolHintSuffix')}
              </p>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle title={t('providerForm.sections.connection')} />
          <div className="space-y-4">
            <div>
              <label className="label">{t('providerForm.connection.baseUrl')}</label>
              <input
                className="input font-mono"
                value={values.baseUrl}
                placeholder="https://api.example.com"
                onChange={(event) => update('baseUrl', event.target.value)}
              />
              <p className="field-hint">{t('providerForm.connection.baseUrlHint')}</p>
            </div>
            <div>
              <label className="label">
                {t('providerForm.connection.apiKey')}{' '}
                {provider?.hasApiKey && (
                  <span className="font-normal text-muted">
                    {t('providerForm.connection.apiKeyKeep')}
                  </span>
                )}
              </label>
              <input
                className="input font-mono"
                type="password"
                value={values.apiKey}
                placeholder={provider?.hasApiKey ? provider.apiKeyMasked : 'sk-…'}
                onChange={(event) => update('apiKey', event.target.value)}
              />
              <p className="field-hint">{t('providerForm.connection.apiKeyHint')}</p>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle title={t('providerForm.sections.models')} />
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-end justify-between gap-2">
                <label className="label mb-0" htmlFor={modelInputId}>
                  {t('providerForm.models.label')}
                </label>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={fetching || values.baseUrl.trim() === ''}
                  title={
                    values.baseUrl.trim() === ''
                      ? t('providerForm.models.fetchTitleEmpty')
                      : t('providerForm.models.fetchTitle')
                  }
                  onClick={() => void loadModels()}
                >
                  {fetching
                    ? t('providerForm.models.fetching')
                    : t('providerForm.models.fetch')}
                </button>
              </div>

              {/*
                参考 new-api 的渠道模型框：整块外观与 .input 一致，已选模型以
                标签片段排列，点片段即移除；末尾留一个可输入的空白段。
                这样既保留了"手填任意模型名"的能力，又能一眼看到已选了什么。
              */}
              <div
                className="input flex min-h-[72px] cursor-text flex-wrap content-start gap-1.5 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15"
                onClick={() => draftInput.current?.focus()}
              >
                {currentModels().map((model) => (
                  <span
                    key={model}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-subtle px-2 py-0.5 font-mono text-xs text-ink"
                    title={model}
                  >
                    <span className="truncate">{model}</span>
                    <button
                      type="button"
                      className="shrink-0 rounded text-muted transition hover:text-danger"
                      aria-label={t('providerForm.models.remove', { model })}
                      onClick={(event) => {
                        event.stopPropagation();
                        writeModels(currentModels().filter((item) => item !== model));
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  id={modelInputId}
                  ref={draftInput}
                  className="min-w-[9rem] flex-1 border-0 bg-transparent p-0 font-mono text-xs text-ink outline-none placeholder:text-muted/70"
                  value={draft}
                  placeholder={
                    currentModels().length === 0
                      ? t('providerForm.models.placeholder')
                      : ''
                  }
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                      event.preventDefault();
                      commitDraft();
                    } else if (
                      event.key === 'Backspace' &&
                      draft === '' &&
                      currentModels().length > 0
                    ) {
                      // 空输入时退格删掉最后一个片段，符合标签输入的习惯
                      writeModels(currentModels().slice(0, -1));
                    }
                  }}
                  onBlur={() => commitDraft()}
                  onPaste={(event) => {
                    const text = event.clipboardData.getData('text');
                    if (/[,，\n]/.test(text)) {
                      event.preventDefault();
                      writeModels([
                        ...currentModels(),
                        ...text.split(/[,，\n]/).map((item) => item.trim()),
                      ]);
                      setDraft('');
                    }
                  }}
                />
              </div>
              <p className="field-hint">{t('providerForm.models.hint')}</p>

              {fetchError && (
                <div className="mt-2">
                  <Notice tone="error">{fetchError}</Notice>
                </div>
              )}
              {fetchHint && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{fetchHint}</p>
              )}

              {candidates && (
                <div className="mt-2 rounded-lg border border-line bg-subtle p-3">
                  <p className="mb-2 text-[11px] leading-relaxed text-muted">
                    {t('providerForm.models.candidatesHint')}
                  </p>
                  <div className="max-h-48 overflow-y-auto pr-1">
                    <div className="flex flex-wrap gap-1.5">
                      {candidates.map((model) => {
                        const checked = currentModels().includes(model);
                        return (
                          <button
                            key={model}
                            type="button"
                            aria-pressed={checked}
                            title={model}
                            className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs transition ${
                              checked
                                ? 'border-accent/30 bg-accent-soft text-accent'
                                : 'border-line bg-elevated text-muted hover:border-muted/40 hover:text-ink'
                            }`}
                            onClick={() => {
                              const picked = currentModels();
                              writeModels(
                                checked
                                  ? picked.filter((item) => item !== model)
                                  : [...picked, model],
                              );
                            }}
                          >
                            <span className="truncate">{model}</span>
                            {checked && <span aria-hidden="true">✓</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => writeModels([...currentModels(), ...candidates])}
                    >
                      {t('providerForm.models.selectAll')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() =>
                        writeModels(
                          currentModels().filter((item) => !candidates.includes(item)),
                        )
                      }
                    >
                      {t('providerForm.models.clearSelection')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost ml-auto text-xs"
                      onClick={() => {
                        setCandidates(null);
                        setFetchHint(null);
                      }}
                    >
                      {t('providerForm.models.collapse')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">{t('providerForm.models.website')}</label>
                <input
                  className="input"
                  value={values.websiteUrl}
                  placeholder="https://example.com"
                  onChange={(event) => update('websiteUrl', event.target.value)}
                />
              </div>
              <div>
                <label className="label">{t('providerForm.models.notes')}</label>
                <input
                  className="input"
                  value={values.notes}
                  onChange={(event) => update('notes', event.target.value)}
                />
              </div>
            </div>
          </div>
        </section>

        {error && <Notice tone="error">{error}</Notice>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line bg-subtle/40 px-5 py-3">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  );
}

export function TestResultLine({
  provider,
}: {
  provider: Provider;
}): JSX.Element | null {
  // 与供应商列表的「最近测试」列共用同一对状态词，避免两处口径不一。
  const { t } = useTranslation();
  const result = provider.lastTest;
  if (!result) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <Badge tone={result.ok ? 'ok' : 'danger'} dot>
        {result.ok ? t('providers.test.ok') : t('providers.test.fail')}
      </Badge>
      <span className="text-muted">{result.latencyMs}ms</span>
      {result.error && (
        <span className="max-w-[24rem] truncate text-danger" title={result.error}>
          {result.error}
        </span>
      )}
    </span>
  );
}
