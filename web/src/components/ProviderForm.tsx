import { useId, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Provider } from '../lib/types';
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
  const [values, setValues] = useState<ProviderFormValues>(toFormValues(provider));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 从上游拉回、等待用户勾选的模型 */
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchHint, setFetchHint] = useState<string | null>(null);
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
        setFetchError(result.error ?? '未能获取模型列表');
        setCandidates(null);
        return;
      }
      if (result.models.length === 0) {
        setFetchHint('上游返回了空列表，请确认该供应商是否开放了模型列表接口。');
        setCandidates(null);
        return;
      }
      setCandidates(result.models);
      setFetchHint(`上游返回 ${result.models.length} 个模型（${result.latencyMs}ms），勾选后确认。`);
    } catch (cause) {
      setFetchError(cause instanceof ApiError ? cause.message : '获取模型列表失败');
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
      setError('至少填写一个模型名');
      setBusy(false);
      return;
    }
    const body = {
      name: values.name.trim(),
      apiType: values.apiType,
      baseUrl: values.baseUrl.trim(),
      apiKey: values.apiKey.trim() === '' ? undefined : values.apiKey.trim(),
      models,
      notes: values.notes.trim() || undefined,
      websiteUrl: values.websiteUrl.trim() || undefined,
    };
    try {
      if (provider) await api.updateProvider(provider.id, body);
      else await api.createProvider(body);
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="card overflow-hidden">
      <div className="card-header">
        <div>
          <h2 className="text-sm font-semibold text-ink">
            {provider ? '编辑供应商' : '新增供应商'}
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-muted">
            保存后立即参与模型聚合与网关选路。
          </p>
        </div>
        <IconButton icon="x" label="关闭表单" onClick={onCancel} />
      </div>

      <div className="space-y-5 p-5">
        <section>
          <SectionTitle title="基本信息" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">名称</label>
              <input
                className="input"
                value={values.name}
                placeholder="例如 PackyCode"
                onChange={(event) => update('name', event.target.value)}
              />
              {provider && (
                <p className="field-hint">
                  别名前缀：lam-{provider.providerKey}/
                </p>
              )}
            </div>
            <div>
              <label className="label">协议类型</label>
              <select
                className="input"
                value={values.apiType}
                onChange={(event) =>
                  update('apiType', event.target.value as 'openai' | 'anthropic' | 'responses')
                }
              >
                {API_TYPE_META.map((meta) => (
                  <option key={meta.value} value={meta.value}>
                    {meta.label}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                该协议走 <code className="font-mono">{selectedMeta.path}</code>；
                与上游真实支持的接口必须一致，不匹配时网关默认返回 501。
                例外：Codex 只会发 Responses 请求，开启「跨协议转发」后网关会把
                Responses 转成 Chat 发给「Chat Completions」供应商。
              </p>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle title="连接信息" />
          <div className="space-y-4">
            <div>
              <label className="label">Base URL</label>
              <input
                className="input font-mono"
                value={values.baseUrl}
                placeholder="https://api.example.com"
                onChange={(event) => update('baseUrl', event.target.value)}
              />
              <p className="field-hint">
                不带 /v1 也可以，服务端会自动补全。若已包含 /v1 则原样使用。
              </p>
            </div>
            <div>
              <label className="label">
                API Key{' '}
                {provider?.hasApiKey && (
                  <span className="font-normal text-muted">（留空则不修改）</span>
                )}
              </label>
              <input
                className="input font-mono"
                type="password"
                value={values.apiKey}
                placeholder={provider?.hasApiKey ? provider.apiKeyMasked : 'sk-…'}
                onChange={(event) => update('apiKey', event.target.value)}
              />
              <p className="field-hint">
                凭据加密落盘，接口只返回首 3 位与尾 4 位的脱敏结果。
              </p>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle title="模型与备注" />
          <div className="space-y-4">
            <div>
              <div className="mb-1.5 flex items-end justify-between gap-2">
                <label className="label mb-0" htmlFor={modelInputId}>
                  模型列表
                </label>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={fetching || values.baseUrl.trim() === ''}
                  title={
                    values.baseUrl.trim() === ''
                      ? '先填写 Base URL'
                      : '用当前填写的协议与地址向上游查询可用模型'
                  }
                  onClick={() => void loadModels()}
                >
                  {fetching ? '获取中…' : '从上游获取模型'}
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
                      aria-label={`移除模型 ${model}`}
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
                    currentModels().length === 0 ? '输入模型名后回车，如 gpt-5.1' : ''
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
              <p className="field-hint">
                回车或逗号添加，点片段上的 × 移除；也可直接粘贴多个（逗号或换行分隔）。
              </p>

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
                    点选要启用的模型（再点一次取消），已添加的以强调色显示。
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
                      全选
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
                      清空选择
                    </button>
                    <button
                      type="button"
                      className="btn-ghost ml-auto text-xs"
                      onClick={() => {
                        setCandidates(null);
                        setFetchHint(null);
                      }}
                    >
                      收起
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label">官网（可选）</label>
                <input
                  className="input"
                  value={values.websiteUrl}
                  placeholder="https://example.com"
                  onChange={(event) => update('websiteUrl', event.target.value)}
                />
              </div>
              <div>
                <label className="label">备注（可选）</label>
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
          取消
        </button>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? '保存中…' : '保存'}
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
  const result = provider.lastTest;
  if (!result) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <Badge tone={result.ok ? 'ok' : 'danger'} dot>
        {result.ok ? '连通' : '失败'}
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
