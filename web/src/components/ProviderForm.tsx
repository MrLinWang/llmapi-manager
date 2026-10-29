import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api';
import type {
  EffortProbeModelResult,
  ModelCapability,
  Provider,
} from '../lib/types';
import { Badge, Icon, IconButton, Notice } from './ui';
import { API_TYPE_META } from '../lib/labels';
import { ProviderEfforts } from './ProviderEfforts';

export interface ProviderFormValues {
  name: string;
  apiType: 'openai' | 'anthropic' | 'responses';
  baseUrl: string;
  apiKey: string;
  /** 对话模型（发布别名、进 Codex 目录） */
  modelsText: string;
  /** 生图模型（只服务 /v1/images/*，不进 Codex 目录） */
  imageModelsText: string;
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
    imageModelsText: (provider?.imageModels ?? []).join('\n') ?? '',
    notes: provider?.notes ?? '',
    websiteUrl: provider?.websiteUrl ?? '',
  };
}

/** 模型列表的两种用途：决定提交到 `models` 还是 `imageModels`。 */
type ModelListKind = 'models' | 'imageModels';

function splitModels(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 从上游拉回后的候选勾选面板。
 *
 * 抽成组件是因为现在有两个（对话 / 生图），勾选、全选、清空、收起的交互必须一致。
 * 各写一份时，"取消勾选只删本次候选"这类边界很容易在其中一个里写错。
 */
function CandidatePanel({
  models,
  candidates,
  onPick,
  onSelectAll,
  onClearSelection,
  onCollapse,
}: {
  models: string[];
  candidates: string[];
  onPick: (model: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onCollapse: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mt-2 rounded-lg border border-line bg-subtle p-3">
      <p className="mb-2 text-[11px] leading-relaxed text-muted">
        {t('providerForm.models.candidatesHint')}
      </p>
      <div className="max-h-48 overflow-y-auto pr-1">
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((model) => {
            const checked = models.includes(model);
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
                onClick={() => onPick(model, checked)}
              >
                <span className="truncate">{model}</span>
                {checked && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={onSelectAll}>
          {t('providerForm.models.selectAll')}
        </button>
        <button type="button" className="btn-ghost text-xs" onClick={onClearSelection}>
          {t('providerForm.models.clearSelection')}
        </button>
        <button type="button" className="btn-ghost ml-auto text-xs" onClick={onCollapse}>
          {t('providerForm.models.collapse')}
        </button>
      </div>
    </div>
  );
}

/**
 * 标签片段式模型输入框。
 *
 * 抽成组件是因为表单里现在有两个（对话 / 生图）。两处外观与交互必须完全一致：
 * 各写一份的话，退格删片段、粘贴多选这些细节迟早会在其中一处漏掉。
 */
function ModelChips({
  id,
  inputRef,
  models,
  draft,
  placeholder,
  removeLabel,
  onDraftChange,
  onCommitDraft,
  onRemove,
  onRemoveLast,
  onPasteMany,
}: {
  id: string;
  inputRef: React.RefObject<HTMLInputElement>;
  models: string[];
  draft: string;
  placeholder: string;
  removeLabel: (model: string) => string;
  onDraftChange: (value: string) => void;
  onCommitDraft: () => void;
  onRemove: (model: string) => void;
  onRemoveLast: () => void;
  onPasteMany: (models: string[]) => void;
}): JSX.Element {
  return (
    <div
      className="input flex min-h-[72px] cursor-text flex-wrap content-start gap-1.5 py-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15"
      onClick={() => inputRef.current?.focus()}
    >
      {models.map((model) => (
        <span
          key={model}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-subtle px-2 py-0.5 font-mono text-xs text-ink"
          title={model}
        >
          <span className="truncate">{model}</span>
          <button
            type="button"
            className="shrink-0 rounded text-muted transition hover:text-danger"
            aria-label={removeLabel(model)}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(model);
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        ref={inputRef}
        className="min-w-[9rem] flex-1 border-0 bg-transparent p-0 font-mono text-xs text-ink outline-none placeholder:text-muted/70"
        value={draft}
        placeholder={models.length === 0 ? placeholder : ''}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            onCommitDraft();
          } else if (event.key === 'Backspace' && draft === '' && models.length > 0) {
            // 空输入时退格删掉最后一个片段，符合标签输入的习惯
            onRemoveLast();
          }
        }}
        onBlur={() => onCommitDraft()}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text');
          if (/[,，\n]/.test(text)) {
            event.preventDefault();
            onPasteMany(splitModels(text));
          }
        }}
      />
    </div>
  );
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
  onProbed,
}: {
  provider?: Provider;
  onSaved: () => void;
  onCancel: () => void;
  /**
   * 探测落库后的通知：父组件据此重新拉供应商列表。
   *
   * 探测**不是**"编辑态"，它直接写服务端（写的是 `modelCapabilities`），
   * 所以不能等用户点保存——那会让"测了但不保存"的人白测一次。
   */
  onProbed?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [values, setValues] = useState<ProviderFormValues>(toFormValues(provider));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 从上游拉回、等待用户勾选的候选模型，按模型类别分开存。
   *
   * 两个框各拉各的：对话框只列能聊天的，生图框只列"只输出图像"的。
   * 放在一起会让用户在对话框里看到 gpt-image-2 并选进去——那正是我们要避免的。
   */
  const [candidates, setCandidates] = useState<Record<ModelListKind, string[] | null>>({
    models: null,
    imageModels: null,
  });
  const [fetching, setFetching] = useState<Record<ModelListKind, boolean>>({
    models: false,
    imageModels: false,
  });
  const [fetchError, setFetchError] = useState<Record<ModelListKind, string | null>>({
    models: null,
    imageModels: null,
  });
  const [fetchHint, setFetchHint] = useState<Record<ModelListKind, string | null>>({
    models: null,
    imageModels: null,
  });

  const patch = <T,>(
    setter: React.Dispatch<React.SetStateAction<Record<ModelListKind, T>>>,
    kind: ModelListKind,
    value: T,
  ): void => setter((prev) => ({ ...prev, [kind]: value }) as Record<ModelListKind, T>);

  /**
   * 逐档实测的本地状态。
   *
   * 结果落库后由 `reload()` 带回 `provider.modelCapabilities`，所以这里只存
   * "刚测出来的这批"用于即时反馈；持久展示走 `capabilities`（见下方渲染处）。
   */
  const [probing, setProbing] = useState(false);
  const [probeProgress, setProbeProgress] = useState<{
    done: number;
    total: number;
    model: string;
    effort: string;
  } | null>(null);
  const [probeResult, setProbeResult] = useState<EffortProbeModelResult[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  /**
   * 按模型名记录的上游能力（上下文窗口等），保存时随供应商提交。
   *
   * 初始值来自已保存的供应商：编辑时若不再重新拉列表，不能把已有能力丢掉
   * （丢了目录就会退回 128k）。只在拉到新数据时合并覆盖。
   */
  const [capabilities, setCapabilities] = useState<Record<string, ModelCapability>>(
    () => ({ ...(provider?.modelCapabilities ?? {}) }),
  );
  /** 两个模型框末尾那个空白片段里正在输入的文本 */
  const [draft, setDraft] = useState('');
  const [imageDraft, setImageDraft] = useState('');
  const draftInput = useRef<HTMLInputElement>(null);
  const imageDraftInput = useRef<HTMLInputElement>(null);
  // 同一页面可能同时存在多个表单实例（如编辑弹窗 + 页面表单），
  // 固定 id 会让 label 的 htmlFor 关联到别的实例的输入框。
  const modelInputId = useId();
  const imageModelInputId = useId();

  const selectedMeta =
    API_TYPE_META.find((item) => item.value === values.apiType) ?? API_TYPE_META[0];

  const update = <K extends keyof ProviderFormValues>(
    key: K,
    value: ProviderFormValues[K],
  ): void => setValues((prev) => ({ ...prev, [key]: value }));

  const textFor = (kind: ModelListKind): string =>
    kind === 'models' ? values.modelsText : values.imageModelsText;

  const currentModels = (kind: ModelListKind = 'models'): string[] =>
    splitModels(textFor(kind));

  /**
   * 去重后回写模型列表：保留原有顺序，新增的排后面。
   * 仍然以换行分隔的单个字符串存进表单状态，提交时后端按行解析；
   * 标签片段只是它的渲染形态，不是另一份数据。
   */
  const writeModels = (models: string[], kind: ModelListKind = 'models'): void => {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const item of models) {
      if (seen.has(item)) continue;
      seen.add(item);
      unique.push(item);
    }
    update(kind === 'models' ? 'modelsText' : 'imageModelsText', unique.join('\n'));
  };

  /** 把输入框里的草稿提交为模型片段；逗号/换行分隔的会被拆开。 */
  const commitDraft = (kind: ModelListKind = 'models'): void => {
    const raw = kind === 'models' ? draft : imageDraft;
    const pieces = splitModels(raw);
    const clear = (): void => {
      if (kind === 'models') setDraft('');
      else setImageDraft('');
    };
    if (pieces.length === 0) {
      clear();
      return;
    }
    writeModels([...currentModels(kind), ...pieces], kind);
    clear();
  };

  const loadModels = async (kind: ModelListKind = 'models'): Promise<void> => {
    patch<boolean>(setFetching, kind, true);
    patch<string | null>(setFetchError, kind, null);
    patch<string | null>(setFetchHint, kind, null);
    try {
      const result = await api.fetchProviderModels({
        apiType: values.apiType,
        baseUrl: values.baseUrl.trim(),
        // 编辑态且没重填 Key 时，交给服务端沿用已保存的 Key
        apiKey: values.apiKey.trim() || undefined,
        providerId: provider?.id,
      });
      if (!result.ok || !result.models) {
        patch<string | null>(setFetchError, kind, result.error ?? t('providerForm.models.fetchFailed'));
        patch<string[] | null>(setCandidates, kind, null);
        return;
      }
      const available =
        kind === 'imageModels' ? (result.imageModels ?? []) : result.models;
      if (available.length === 0) {
        // 上游没声明生图模型（或压根没带 architecture）时给出可操作的提示，
        // 而不是一个空列表让人以为上游不支持生图。
        // 两条键分开取：三元表达式会让 i18n 的类型推导退化成"字面量数组"
        const emptyKey =
          kind === 'imageModels'
            ? 'providerForm.models.imageEmptyList'
            : 'providerForm.models.emptyList';
        patch<string | null>(setFetchHint, kind, t(emptyKey));
        patch<string[] | null>(setCandidates, kind, null);
        return;
      }
      patch<string[] | null>(setCandidates, kind, available);
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
      patch<string | null>(
        setFetchHint,
        kind,
        t('providerForm.models.fetched', {
          count: available.length,
          latencyMs: result.latencyMs,
        }) +
          (withCaps > 0 ? t('providerForm.models.withCapabilities', { count: withCaps }) : ''),
      );
    } catch (cause) {
      patch<string | null>(
        setFetchError,
        kind,
        cause instanceof ApiError ? cause.message : t('common.fetchModelsFailed'),
      );
      patch<string[] | null>(setCandidates, kind, null);
    } finally {
      patch<boolean>(setFetching, kind, false);
    }
  };

  /**
   * 逐档实测：对每个模型 × 每个候选档位发一次真实请求，确认上游到底接受哪些。
   *
   * 只在**已保存**的供应商上可用：接口按 id 取记录、写回能力表，
   * 还没落盘的草稿没有 id，也没地方写。所以按钮在新建态禁用并说明原因，
   * 而不是让用户点下去收到一个 404。
   */
  const runProbe = async (): Promise<void> => {
    if (!provider) return;
    const candidates = 9;
    const confirmed = window.confirm(
      t('providers.probe.confirm', {
        models: currentModels().length,
        requests: currentModels().length * candidates,
      }),
    );
    if (!confirmed) return;

    setProbeError(null);
    setProbeResult(null);
    setProbing(true);
    setProbeProgress({ done: 0, total: currentModels().length * candidates, model: '', effort: '' });
    try {
      const result = await api.probeProviderEfforts(provider.id, (progress) => {
        setProbeProgress({
          done: progress.done,
          total: progress.total,
          model: progress.model,
          effort: progress.effort,
        });
      });
      setProbeResult(result.models);
      // 能力表已在服务端落库：把它合并进本地状态，让"保存"不会用旧值覆盖回去
      setCapabilities((prev) => ({ ...prev, ...(result.provider.modelCapabilities ?? {}) }));
      onProbed?.();
    } catch (cause) {
      setProbeError(cause instanceof ApiError ? cause.message : t('common.actionFailed'));
    } finally {
      setProbing(false);
      setProbeProgress(null);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const imageModels = splitModels(values.imageModelsText);
    // 同一个名字同时出现在两个框里时按生图处理：服务端也会裁，这里先裁一遍
    // 是为了提交体与落盘结果一致，不让用户看到"保存后列表少了一项"的困惑。
    const imageSet = new Set(imageModels);
    const models = splitModels(values.modelsText).filter((item) => !imageSet.has(item));
    // 只要有一类模型就能保存：只配生图模型是完全合法的用法
    if (models.length === 0 && imageModels.length === 0) {
      setError(t('providerForm.models.requireOne'));
      setBusy(false);
      return;
    }
    // 只提交仍在模型列表里的能力（对话 + 生图都算）；服务端还会再裁一次
    // （两处都做是因为用户可能先拉列表再删模型，前端这次提交就已经带着过期条目了）。
    const allModels = new Set([...models, ...imageModels]);
    const keptCapabilities = Object.fromEntries(
      Object.entries(capabilities).filter(([model]) => allModels.has(model)),
    );
    const body = {
      name: values.name.trim(),
      apiType: values.apiType,
      baseUrl: values.baseUrl.trim(),
      apiKey: values.apiKey.trim() === '' ? undefined : values.apiKey.trim(),
      modelCapabilities:
        Object.keys(keptCapabilities).length > 0 ? keptCapabilities : undefined,
      models,
      // 总是显式提交（哪怕空数组）：这个表单是全量编辑器，用户看到的就是全部内容。
      // 传 undefined 会被服务端理解成"这个字段不用改"，于是清空生图模型框再保存
      // 也删不掉——那是用户明确表达过的操作，不能被静默忽略。
      imageModels,
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
                  disabled={fetching.models || values.baseUrl.trim() === ''}
                  title={
                    values.baseUrl.trim() === ''
                      ? t('providerForm.models.fetchTitleEmpty')
                      : t('providerForm.models.fetchTitle')
                  }
                  onClick={() => void loadModels('models')}
                >
                  {fetching.models
                    ? t('providerForm.models.fetching')
                    : t('providerForm.models.fetch')}
                </button>
              </div>

              <ModelChips
                id={modelInputId}
                inputRef={draftInput}
                models={currentModels()}
                draft={draft}
                placeholder={t('providerForm.models.placeholder')}
                removeLabel={(model) => t('providerForm.models.remove', { model })}
                onDraftChange={setDraft}
                onCommitDraft={() => commitDraft()}
                onRemove={(model) =>
                  writeModels(currentModels().filter((item) => item !== model))
                }
                onRemoveLast={() => writeModels(currentModels().slice(0, -1))}
                onPasteMany={(pasted) => writeModels([...currentModels(), ...pasted])}
              />
              <p className="field-hint">{t('providerForm.models.hint')}</p>

              {fetchError.models && (
                <div className="mt-2">
                  <Notice tone="error">{fetchError.models}</Notice>
                </div>
              )}
              {fetchHint.models && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                  {fetchHint.models}
                </p>
              )}

              {candidates.models && (
                <CandidatePanel
                  models={currentModels()}
                  candidates={candidates.models}
                  onPick={(model, checked) => {
                    const picked = currentModels();
                    writeModels(
                      checked
                        ? picked.filter((item) => item !== model)
                        : [...picked, model],
                    );
                  }}
                  onSelectAll={() => writeModels([...currentModels(), ...candidates.models!])}
                  onClearSelection={() =>
                    writeModels(
                      currentModels().filter((item) => !candidates.models!.includes(item)),
                    )
                  }
                  onCollapse={() => {
                    patch<string[] | null>(setCandidates, 'models', null);
                    patch<string | null>(setFetchHint, 'models', null);
                  }}
                />
              )}

            </div>
            {/*
              生图模型单独一个框：它不会发布别名，也就不会出现在 Codex 的 /model 里。
              与上面的对话模型列表是两份数据，互不覆盖。
            */}
            <div>
              <div className="mb-1.5 flex items-end justify-between gap-2">
                <label className="label mb-0" htmlFor={imageModelInputId}>
                  {t('providerForm.models.imageLabel')}
                </label>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={fetching.imageModels || values.baseUrl.trim() === ''}
                  title={
                    values.baseUrl.trim() === ''
                      ? t('providerForm.models.fetchTitleEmpty')
                      : t('providerForm.models.imageFetchTitle')
                  }
                  onClick={() => void loadModels('imageModels')}
                >
                  {fetching.imageModels
                    ? t('providerForm.models.fetching')
                    : t('providerForm.models.fetch')}
                </button>
              </div>
              <ModelChips
                id={imageModelInputId}
                inputRef={imageDraftInput}
                models={currentModels('imageModels')}
                draft={imageDraft}
                placeholder={t('providerForm.models.imagePlaceholder')}
                removeLabel={(model) =>
                  t('providerForm.models.imageRemove', { model })
                }
                onDraftChange={setImageDraft}
                onCommitDraft={() => commitDraft('imageModels')}
                onRemove={(model) =>
                  writeModels(
                    currentModels('imageModels').filter((item) => item !== model),
                    'imageModels',
                  )
                }
                onRemoveLast={() =>
                  writeModels(currentModels('imageModels').slice(0, -1), 'imageModels')
                }
                onPasteMany={(pasted) =>
                  writeModels([...currentModels('imageModels'), ...pasted], 'imageModels')
                }
              />
              <p className="field-hint">{t('providerForm.models.imageHint')}</p>

              {fetchError.imageModels && (
                <div className="mt-2">
                  <Notice tone="error">{fetchError.imageModels}</Notice>
                </div>
              )}
              {fetchHint.imageModels && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                  {fetchHint.imageModels}
                </p>
              )}

              {candidates.imageModels && (
                <CandidatePanel
                  models={currentModels('imageModels')}
                  candidates={candidates.imageModels}
                  onPick={(model, checked) => {
                    const picked = currentModels('imageModels');
                    writeModels(
                      checked
                        ? picked.filter((item) => item !== model)
                        : [...picked, model],
                      'imageModels',
                    );
                  }}
                  onSelectAll={() =>
                    writeModels(
                      [...currentModels('imageModels'), ...candidates.imageModels!],
                      'imageModels',
                    )
                  }
                  onClearSelection={() =>
                    writeModels(
                      currentModels('imageModels').filter(
                        (item) => !candidates.imageModels!.includes(item),
                      ),
                      'imageModels',
                    )
                  }
                  onCollapse={() => {
                    patch<string[] | null>(setCandidates, 'imageModels', null);
                    patch<string | null>(setFetchHint, 'imageModels', null);
                  }}
                />
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

        {/*
          思考档位独立成一节，而不是塞进模型框旁边或列表行内：
          一个供应商可能声明十几个模型，每个模型还带"接受哪些档位、被拒哪些"，
          放在表格那一格里会把整行撑坏，也挤掉了名称/地址/Key 这些按行扫读的字段。
          档位属于"配这家时关心一次"的详情信息。
        */}
        <section>
          <SectionTitle title={t('providerForm.sections.efforts')} />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={
                  !provider || probing || currentModels().length === 0
                }
                title={
                  !provider
                    ? t('providers.probe.saveFirst')
                    : currentModels().length === 0
                      ? t('providers.probe.disabledNoModels')
                      : t('providers.actions.probeTitle')
                }
                onClick={() => void runProbe()}
              >
                <Icon name="zap" className="size-4" />
                {probing ? t('providers.probe.runningShort') : t('providers.actions.probe')}
              </button>
              {probing && probeProgress && (
                <span className="font-mono text-[11px] text-muted">
                  {t('providers.probe.progress', probeProgress)}
                </span>
              )}
            </div>

            {probing && probeProgress && probeProgress.total > 0 && (
              <div
                role="progressbar"
                aria-label={t('providers.probe.running')}
                aria-valuemin={0}
                aria-valuemax={probeProgress.total}
                aria-valuenow={probeProgress.done}
                className="h-1.5 w-full overflow-hidden rounded-full bg-line"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round((probeProgress.done / probeProgress.total) * 100),
                    )}%`,
                  }}
                />
              </div>
            )}

            {probeError && <Notice tone="error">{probeError}</Notice>}

            {/*
              持久展示读的是 `capabilities`（服务端落盘值，即 provider.modelCapabilities）：
              关掉页面、第二天再打开仍然在，不必为看一眼结果重测一次（几十秒 + 真烧额度）。
              `probeResult` 只是刚测完这批的即时反馈。
            */}
            <ProviderEfforts
              models={[...currentModels(), ...currentModels('imageModels')]}
              capabilities={capabilities}
              fresh={probeResult ?? undefined}
            />
            <p className="text-[11px] leading-5 text-muted">
              {t('providers.probe.hint')}
            </p>
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
