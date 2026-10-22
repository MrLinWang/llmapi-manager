import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Provider } from '../lib/types';
import { Badge, IconButton, Notice } from './ui';

export interface ProviderFormValues {
  name: string;
  apiType: 'openai' | 'anthropic';
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

  const update = <K extends keyof ProviderFormValues>(
    key: K,
    value: ProviderFormValues[K],
  ): void => setValues((prev) => ({ ...prev, [key]: value }));

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
                  别名前缀：lmm-{provider.providerKey}/
                </p>
              )}
            </div>
            <div>
              <label className="label">协议类型</label>
              <select
                className="input"
                value={values.apiType}
                onChange={(event) =>
                  update('apiType', event.target.value as 'openai' | 'anthropic')
                }
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic 兼容</option>
              </select>
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
              <label className="label">模型列表（每行一个，或逗号分隔）</label>
              <textarea
                className="input h-24 font-mono"
                value={values.modelsText}
                placeholder={'gpt-5.1\ngpt-5.1-mini'}
                onChange={(event) => update('modelsText', event.target.value)}
              />
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
