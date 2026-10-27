import { useEffect, useId, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { formatDateTime } from '../i18n/format';
import type { MessageKey } from '../lib/labels';
import type { AgentConnectionMode, AgentTargetPreference, AgentPreview, Provider } from '../lib/types';
import {
  Badge,
  Card,
  Empty,
  Icon,
  IconButton,
  Notice,
  PageHeader,
  Spinner,
  type IconName,
} from '../components/ui';

/**
 * 审批模型候选。
 *
 * 必须带供应商信息，不能只给模型名：同一个模型名常被多家供应商声明
 * （例如 gpt-6-luna 同时在 openai 与 responses 两家），下拉框里两行都写
 * `gpt-6-luna` 的话，用户根本看不出选的是哪一家——而这两家的结果并不相同
 * （协议匹配的那家能直通，另一家要经过转换）。
 */
interface ApprovalCandidate {
  model: string;
  /** 会承接这家（网关选路优先协议匹配，所以是"最能直通"的那家） */
  providerName: string;
  providerKey: string;
  apiType: string;
  /** 协议与 Codex 的 responses 一致 → 直通；否则网关会做协议转换 */
  direct: boolean;
  /** 还有哪些供应商也声明了同名模型 */
  sharedWith: string[];
}

/**
 * 下拉框里一项的显示文案。
 *
 * 只写模型名会重名，所以补上供应商与协议；加 `direct` 标记是因为
 * "能直通"是用户做选择时最该知道的信息（转换有信息损失，且多一层可能失败）。
 * 但两侧重名时仍可能看混，因此再带上 providerKey（唯一）。
 */
function approvalLabel(t: TFunction, item: ApprovalCandidate): string {
  const tag = t(item.direct ? 'agents.approval.direct' : 'agents.approval.convert');
  const base = t('agents.approval.option', {
    model: item.model,
    providerName: item.providerName,
    providerKey: item.providerKey,
    apiType: item.apiType,
    tag,
  });
  // 同名模型被多家声明时说清楚：最终由网关按协议匹配挑，用户不必也不能指定
  return item.sharedWith.length === 0
    ? base
    : t('agents.approval.sharedWith', {
        base,
        names: item.sharedWith.join(t('agents.separators.enumeration')),
      });
}

function agentIcon(id: string): IconName {
  return id === 'codex' ? 'terminal' : 'agents';
}

/** Agent 显示名：与服务端下发的 id 对应，标识符不翻译。 */
function agentDisplayName(id: string): string {
  return id === 'codex' ? 'Codex' : 'Claude Code';
}

/**
 * 「退出 Codex 进程」提示里的手动兜底命令。
 *
 * 结束进程是尽力而为：`codex app-server daemon stop` 在配置目录只读时会直接失败，
 * 自定义安装位置的进程也可能匹配不到。此时只报"已结束/没有进程"会让用户以为按钮
 * 无效，而不知道下一步该做什么，所以每次都把这条命令一起给出。
 *
 * 文案本体（含 <code> 标记）在字典里，这里只声明标记要渲染成什么元素：
 * 用 <code> 而不是纯文本，是为了让命令在提示里能一眼看清（与页面其他内联命令一致）。
 */
const MANUAL_CODEX_KILL_HINT: ReactNode = (
  <Trans
    i18nKey="agents.messages.manualKillHint"
    components={{ code: <code className="font-mono" /> }}
  />
);

/**
 * 连接方式的两个选项。
 *
 * 用键而不是文案：文案在字典里，切换语言时组件重渲染即可换掉；
 * 第一项 `mode` 仍是决定写入哪套配置的机器标识，不参与翻译。
 */
const CONNECTION_MODES: Array<
  [AgentConnectionMode, MessageKey, MessageKey]
> = [
  ['gateway', 'agents.connection.gateway.label', 'agents.connection.gateway.desc'],
  ['direct', 'agents.connection.direct.label', 'agents.connection.direct.desc'],
];

/** 该 Agent 直连时必须匹配的上游协议（Codex 只认 responses，Claude Code 只认 anthropic）。 */
function requiredApiType(id: string): string {
  return id === 'claude-code' ? 'anthropic' : 'responses';
}

export default function AgentsPage(): JSX.Element {
  // 用 useTranslation 的 t 而不是全局实例：它订阅语言变化，切换语言时本页会重渲染。
  const { t } = useTranslation();
  const agents = useAsync(() => api.agents());
  const settings = useAsync(() => api.settings());
  const providers = useAsync(() => api.providers());
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 提示里可能带内联命令（<code>），所以存 ReactNode 而不是 string。
  const [error, setError] = useState<ReactNode>(null);
  const [message, setMessage] = useState<ReactNode>(null);
  /**
   * 两个流式参数的输入框文本。
   *
   * 存字符串而不是 number：用户可能正在删改（空串、只输了个 "-"），
   * 直接绑 number 会让"清空"这一步无法表达。空串在提交时转成 null（=不写该键）。
   */
  const [streamMaxRetries, setStreamMaxRetries] = useState('');
  const [streamIdleTimeoutMs, setStreamIdleTimeoutMs] = useState('');
  // label 与输入框的关联 id。用 useId 而不是写死：同一页面会渲染多个 Agent 卡片，
  // 固定 id 会让 label 指到别的卡片上的输入框（ProviderForm 里有同样的约定）。
  const streamRetriesId = useId();
  const streamIdleId = useId();

  // 设置加载/刷新后同步到输入框。用 useEffect 而不是把 settings 直接当 value：
  // 编辑中的内容不该被任何一次后台 reload 覆盖掉。
  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setStreamMaxRetries(
      data.codexStreamMaxRetries === null ? '' : String(data.codexStreamMaxRetries),
    );
    setStreamIdleTimeoutMs(
      data.codexStreamIdleTimeoutMs === null ? '' : String(data.codexStreamIdleTimeoutMs),
    );
    // 只在服务端数据变化时同步一次；把 settings.data 拆成两个字段作依赖，
    // 避免 reload 生成新对象引用时把用户正在输入的内容冲掉。
  }, [settings.data?.codexStreamMaxRetries, settings.data?.codexStreamIdleTimeoutMs]);

  /**
   * 统一的操作包装：置忙、清提示、收错误。
   *
   * `failureHint` 是给失败路径补的一句兜底说明。之前只有成功分支才带手动命令，
   * 请求一报错（后端 500、进程探测异常、路由 404）就只剩一句错误文本，
   * 用户反而最需要这一步的时候拿不到"下一步做什么"。
   */
  const run = async (
    label: string,
    action: () => Promise<void>,
    failureHint?: ReactNode,
  ): Promise<void> => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      // 服务端返回的 message 是中文，原样显示（i18n 只覆盖前端文案）；
      // 只有完全没有 message 的意外异常才用本地兜底。
      const text = cause instanceof ApiError ? cause.message : t('common.actionFailed');
      setError(
        failureHint ? (
          <>
            {text}
            {t('agents.separators.sentence')}
            {failureHint}
          </>
        ) : (
          text
        ),
      );
    } finally {
      setBusy(null);
    }
  };

  const doPreview = (id: string): Promise<void> =>
    run(`preview:${id}`, async () => {
      setPreview(await api.previewAgent(id));
    });

  const doApply = (id: string): Promise<void> =>
    run(`apply:${id}`, async () => {
      const result = await api.applyAgent(id);
      // 探测到仍在运行的进程时明确报出数量：它们内存里是旧配置，
      // 只看"已写入"会让用户以为立即生效，然后在旧进程里看到 401/404。
      const running = result.binding.runningProcesses ?? 0;
      setMessage(
        running > 0
          ? t('agents.messages.appliedWithRunning', {
              count: running,
              agent: agentDisplayName(id),
            })
          : t('agents.messages.applied'),
      );
      agents.reload();
      if (preview?.agentId === id) setPreview(await api.previewAgent(id));
    });

  /**
   * 结束本机 Codex 进程后的提示。
   *
   * 自动结束是尽力而为：`codex app-server daemon stop` 在配置目录只读时会直接失败，
   * 从非标准位置启动的进程也可能匹配不到。所以无论成功还是只剩警告，都把手动兜底
   * 命令一起给出 —— 否则用户只看到"已结束"或一句失败原因，不知道下一步该做什么。
   */
  const doStopProcesses = (id: string): Promise<void> =>
    run(
      `stop:${id}`,
      async () => {
        const result = await api.stopAgentProcesses(id);
        // actions 由后端补齐（包含"本机没有正在运行的 Codex 进程"这种情况），
        // 前端不再自己推断，避免两处逻辑各说一套。
        const parts: string[] = [...result.actions];
        if (result.warnings.length > 0) parts.push(...result.warnings);
        // actions/warnings 由后端下发、是中文原文：只在中间拼接分隔符，
        // 分隔符随界面语言变化（不能硬编码 `；`）。
        const text = parts.join(t('agents.separators.list'));
        if (result.warnings.length > 0 && result.actions.length === 0) {
          setError(
            <>
              {text}
              {t('agents.separators.sentence')}
              {MANUAL_CODEX_KILL_HINT}
            </>,
          );
        } else {
          setMessage(
            <>
              {text}
              {t('agents.separators.sentence')}
              <Trans
                i18nKey="agents.messages.reopenCodexHint"
                components={{ code: <code className="font-mono" /> }}
              />
            </>,
          );
        }
      },
      // 请求本身失败（后端 500 / 路由 404 / 网络断）时同样要给出兜底命令：
      // 这恰恰是用户最需要手动清理的时候。
      MANUAL_CODEX_KILL_HINT,
    );

  /**
   * 切换 Codex 的 web_search 开关。
   *
   * 与另外两个开关不同，这一项**必须**重新 apply：它决定我们生成进 config.toml 的
   * 那个键的值，不重写文件就等于没改。所以这里多调了一次 applyAgent('codex')，
   * 并且要提示用户重启进程 —— 文件变了，已运行的进程不会自己重读。
   */
  const toggleCodexWebSearch = (next: boolean): Promise<void> =>
    run('toggle:web_search', async () => {
      await api.setCodexOptions({ disableCodexWebSearch: next });
      await api.applyAgent('codex');
      setMessage(
        next ? t('agents.messages.webSearchOff') : t('agents.messages.webSearchOn'),
      );
      settings.reload();
      agents.reload();
      if (preview?.agentId === 'codex') setPreview(await api.previewAgent('codex'));
    });

  /**
   * 保存流式重连次数 / 空闲超时，并立即重新 apply。
   *
   * 与 web_search 同理：这两项直接决定我们写进 config.toml 的值，
   * 不重写文件等于没改。空输入表示"不写该键，用 Codex 默认"，提交 null。
   *
   * 前端这里只做**最基本的**空值转换，范围校验交给服务端：
   * 同一套范围常量只在 server/src/domain/settings.ts 定义一份，
   * 前端复刻一遍迟早会与后端说成不同的数。
   */
  const saveCodexStreamOptions = (input: {
    codexStreamMaxRetries?: number | null;
    codexStreamIdleTimeoutMs?: number | null;
    /** 成功提示的字典键（清空与保存是两句不同的话）。 */
    messageKey: MessageKey;
  }): Promise<void> =>
    run('toggle:stream', async () => {
      await api.setCodexOptions({
        codexStreamMaxRetries: input.codexStreamMaxRetries,
        codexStreamIdleTimeoutMs: input.codexStreamIdleTimeoutMs,
      });
      await api.applyAgent('codex');
      setMessage(t(input.messageKey));
      settings.reload();
      agents.reload();
      if (preview?.agentId === 'codex') setPreview(await api.previewAgent('codex'));
    });

  /**
   * 失焦即保存。空串 → null（不写该键）；非空则交给服务端按范围校验。
   *
   * 值没变时不发请求：失焦是高频事件，每次点开再点走都写一遍盘没有意义。
   */
  const persistStreamOptions = (): Promise<void> => {
    const nextRetries = streamMaxRetries.trim() === '' ? null : Number(streamMaxRetries);
    const nextIdle = streamIdleTimeoutMs.trim() === '' ? null : Number(streamIdleTimeoutMs);
    const unchanged =
      nextRetries === (settings.data?.codexStreamMaxRetries ?? null) &&
      nextIdle === (settings.data?.codexStreamIdleTimeoutMs ?? null);
    if (unchanged) return Promise.resolve();

    // 上下限在这里**不判断**：交给服务端，避免处出现两套规则。
    // 但仍然挡掉明显不是数字的输入，否则会先发一个必然 400 的请求。
    if (
      (nextRetries !== null && !Number.isFinite(nextRetries)) ||
      (nextIdle !== null && !Number.isFinite(nextIdle))
    ) {
      setError(t('agents.messages.streamInvalid'));
      return Promise.resolve();
    }

    return saveCodexStreamOptions({
      codexStreamMaxRetries: nextRetries,
      codexStreamIdleTimeoutMs: nextIdle,
      messageKey:
        nextRetries === null && nextIdle === null
          ? 'agents.messages.streamCleared'
          : 'agents.messages.streamSaved',
    });
  };

  /**
   * 保存某个 Agent 的连接模式，不自动下发。
   *
   * 传进来的只有 patch，不含 apply：切到直连但还没选供应商时 apply 会直接 400
   * （服务端要求直连必须明确指定供应商），等于用报错当交互反馈。让用户先选好供应商、
   * 再自己点「应用配置」，路径更顺。
   */
  const applyTarget = (id: string, patch: Parameters<typeof api.setAgentTarget>[1]): Promise<void> =>
    run(`mode:${id}`, async () => {
      await api.setAgentTarget(id, patch);
      settings.reload();
      agents.reload();
      if (preview?.agentId === id) setPreview(await api.previewAgent(id));
    });

  /**
   * 切换连接方式。
   *
   * 直连会把上游地址与真实 Key 直接写进配置文件，之后即使本服务没在运行，
   * Codex 也能用 —— 代价是没有网关侧的换源、回退与请求日志。
   * 这里只改偏好、不自动下发，具体原因见 applyTarget。
   */
  const switchMode = (mode: AgentConnectionMode, id: string): Promise<void> =>
    applyTarget(id, { mode });

  /**
   * 「Approve for me」的模型映射：Codex 用 API Key 认证时把审批模型硬编码成
   * gpt-5.6-luna，配置里没有任何字段能改它。走网关时这个名字会原样出现在请求体里，
   * 网关可以把它当占位名换掉。
   *
   * 所以这项设置只在走网关时有意义 —— 直连模式下请求不经过本服务，下拉框也就被隐藏了
   * （见下方渲染处的 currentTarget.mode === 'gateway' 判断）。
   *
   * 同样不自动 apply：它是网关的运行时行为，不改任何下发文件。
   */
  const pickApprovalModel = (model: string): Promise<void> =>
    run('approval-model', async () => {
      await api.setCodexOptions({ approvalReviewModel: model || null });
      setMessage(
        model
          ? t('agents.messages.approvalSet', { model })
          : t('agents.messages.approvalCleared'),
      );
      settings.reload();
    });

  /**
   * 跨协议转发开关。打开后 Codex 的 Responses 请求可以落到只支持 Chat 的上游，
   * 由网关双向转换（含流式与工具调用）。
   *
   * 不自动 apply：这是网关的运行时行为，不改任何下发文件，apply 没有意义。
   * 反过来也要留意：开关值会参与模型目录的生成（开开关后 openai 供应商的别名
   * 才会进 Codex 的目录），所以想让新模型出现在 /model 里，仍要重新 apply 一次。
   */
  const toggleProtocolConversion = (next: boolean): Promise<void> =>
    run('toggle:conversion', async () => {
      await api.setCodexOptions({ protocolConversion: next });
      setMessage(
        next ? t('agents.messages.conversionOn') : t('agents.messages.conversionOff'),
      );
      settings.reload();
    });

  /**
   * 直连模式下选定供应商，并立即写进配置。
   *
   * 这里与切换模式不同、要自动 apply：用户是在"已经选了直连"之后才做这一步，
   * 选完供应商配置就完整了，再让他多点一次没有额外风险。
   */
  const pickDirectProvider = (id: string, providerId: string): Promise<void> =>
    run(`provider:${id}`, async () => {
      await api.setAgentTarget(id, { directProviderId: providerId || null });
      await api.applyAgent(id);
      setMessage(
        providerId
          ? t('agents.messages.directProviderSet')
          : t('agents.messages.directProviderCleared'),
      );
      settings.reload();
      agents.reload();
      if (preview?.agentId === id) setPreview(await api.previewAgent(id));
    });

  const doRevert = (id: string): Promise<void> =>
    run(`revert:${id}`, async () => {
      const result = await api.revertAgent(id);
      if (result.conflicts.length > 0) {
        // 两句各自带计数（还原了几个 / 保留了几个），各自取复数：
        // 合成一句会出现"Reverted 1 keys"这种英文单复数错误。
        setMessage(
          <>
            {t('agents.messages.reverted', { count: result.restored.length })}
            {t('agents.separators.list')}
            {t('agents.messages.conflictsKept', {
              count: result.conflicts.length,
              keys: result.conflicts
                .map((item) => item.key)
                .join(t('agents.separators.enumeration')),
            })}
          </>,
        );
      } else {
        setMessage(
          <>
            {t('agents.messages.reverted', { count: result.restored.length })}
            {t('agents.separators.sentence')}
          </>,
        );
      }
      agents.reload();
      setPreview(null);
    });

  /** 某 Agent 当前的连接偏好；没存过就当作走网关。 */
  const targetOf = (id: string): AgentTargetPreference =>
    settings.data?.agentTargets?.[id] ?? {
      mode: 'gateway',
      directProviderId: null,
      directModel: null,
    };

  /**
   * 是否该提示用户「可以开启跨协议转发」。
   *
   * 四个条件同时成立才提示，缺一不可：Codex、有启用的 openai 供应商、没有启用的
   * responses 供应商、开关还是关着的。前两条里的「有 chat、没 responses」决定了
   * 转换真的能解决问题（否则开了也没用，只会误导）；最后一条避免已经开着时还反复劝。
   *
   * 这里只提示、不自动改设置：转换有信息损失（托管工具没有 Chat 等价物会被丢弃），
   * 必须由用户明确同意。真正会自动开启的是网关 —— 首次收到这类请求时它会打开开关
   * 并回写响应头 x-llmapi-auto-conversion: 1，让用户能发现行为被改了。
   */
  const needsConversionHint = (id: string): boolean => {
    if (id !== 'codex') return false;
    const list = providers.data?.providers ?? [];
    const hasResponses = list.some(
      (provider) => provider.enabled && provider.apiType === 'responses',
    );
    const hasChat = list.some(
      (provider) => provider.enabled && provider.apiType === 'openai',
    );
    return hasChat && !hasResponses && !(settings.data?.protocolConversion ?? false);
  };

  /**
   * 可映射的审批模型：**所有已启用供应商**声明的模型，不限协议。
   *
   * 这里原先只列 responses 供应商，理由是"审批请求走 /v1/responses，目标若来自
   * openai 供应商还得再转换一次"。这个理由站不住：Codex 只能绑定 responses 协议，
   * 用户手里常常只有 openai（Chat）供应商——那样列表就空着，功能等于不可用。
   * 而网关本来就有跨协议转发（且协议不匹配时还会自动开启），转换是常规能力，不是隐患。
   *
   * 真正的约束下沉到服务端：用户选定后由选路逻辑判断这家能不能承接本次路径，
   * 不能就在报错里说清原因，而不是在列表阶段就替用户把选项藏起来。
   */
  const approvalCandidates = (): ApprovalCandidate[] => {
    // 按模型名聚合：设置里只存模型名，"选哪家供应商"由网关按协议匹配自动决定。
    // 所以同一个名字在列表里只能出现一次——出现两次用户会以为能选供应商，
    // 而实际选了也没区别（值相同）。把"会落到哪家"写进标签就行。
    const byModel = new Map<string, ApprovalCandidate>();
    for (const provider of providers.data?.providers ?? []) {
      if (!provider.enabled) continue;
      const direct = provider.apiType === 'responses';
      for (const model of provider.models) {
        const existing = byModel.get(model);
        if (!existing) {
          byModel.set(model, {
            model,
            providerName: provider.name,
            providerKey: provider.providerKey,
            apiType: provider.apiType,
            direct,
            // 还有别家也声明了这个模型——标签里要提示，因为最终选哪家由网关切定
            sharedWith: [],
          });
        } else {
          // 记下"还有谁声明了同一个名字"。必须排除自己：切换主供应商后
          // 原主供应商也要补进 sharedWith，否则会漏掉（或重复记自己）。
          const others = new Set(
            [existing.providerName, ...existing.sharedWith].filter(
              (name) => name !== provider.name,
            ),
          );
          if (direct && !existing.direct) {
            // 有一家能直通就以它为准：网关选路优先协议匹配
            existing.providerName = provider.name;
            existing.providerKey = provider.providerKey;
            existing.apiType = provider.apiType;
            existing.direct = true;
          }
          existing.sharedWith = [...others];
        }
      }
    }
    // 能直通的排前面，其余按名字
    return [...byModel.values()].sort(
      (a, b) => Number(b.direct) - Number(a.direct) || a.model.localeCompare(b.model),
    );
  };

  /**
   * 该 Agent 可直连的供应商：协议必须严格匹配、且已启用。
   *
   * 直连时请求不经过网关、也就没有转换的机会，所以协议必须对齐
   * （Codex 只认 responses，Claude Code 只认 anthropic）。列出一家 openai 供应商会让
   * 用户选中后必然 501 或启动失败 —— 在候选列表里就排除，比事后报错好。
   */
  const directCandidates = (id: string): Provider[] => {
    const needed = requiredApiType(id);
    return (providers.data?.providers ?? []).filter(
      (provider) => provider.enabled && provider.apiType === needed,
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={t('agents.header.eyebrow')}
        title={t('app.nav.agents')}
        description={t('agents.header.description')}
        actions={
          <Badge tone="neutral">
            {t('agents.header.count', { count: agents.data?.agents.length ?? 0 })}
          </Badge>
        }
      />

      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}

      {agents.loading && <Spinner />}
      {agents.data && agents.data.agents.length === 0 && (
        <Empty icon="agents">{t('agents.empty')}</Empty>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {agents.data?.agents.map((agent) => {
          // 每个 Agent 各自一份偏好，互不影响：Codex 走网关、Claude Code 直连
          // 是完全合理的组合，所以这里必须按 agent.id 取，不能提到循环外。
          const currentTarget = targetOf(agent.id);
          return (
          <Card key={agent.id}>
            <div className="flex items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                <Icon name={agentIcon(agent.id)} className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">{agent.name}</h2>
                  {agent.applied ? (
                    <Badge tone="ok" dot>
                      {t('agents.status.applied')}
                    </Badge>
                  ) : (
                    <Badge dot>{t('agents.status.notApplied')}</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted">{agent.description}</p>
                {agent.appliedAt && (
                  <p className="mt-1 text-[11px] text-muted">
                    {/* 时间必须按界面语言格式化，不能用 toLocaleString（它跟随浏览器） */}
                    {t('agents.card.appliedAt', { time: formatDateTime(agent.appliedAt) })}
                    {agent.appliedBy ? ` · ${agent.appliedBy}` : ''}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <button
                type="button"
                className="btn-outline btn-sm"
                disabled={busy === `preview:${agent.id}`}
                onClick={() => void doPreview(agent.id)}
              >
                <Icon name="play" className="size-3.5" />
                {busy === `preview:${agent.id}`
                  ? t('agents.actions.previewing')
                  : t('agents.actions.preview')}
              </button>
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={busy === `apply:${agent.id}`}
                onClick={() => void doApply(agent.id)}
              >
                <Icon name="zap" className="size-3.5" />
                {busy === `apply:${agent.id}`
                  ? t('agents.actions.applying')
                  : agent.applied
                    ? t('agents.actions.reapply')
                    : t('agents.actions.apply')}
              </button>
              {/* 只有 Codex 有常驻进程与启动时快照的模型目录，Claude Code 不需要 */}
              {agent.id === 'codex' && (
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  disabled={busy === `stop:${agent.id}`}
                  title={t('agents.actions.stopTitle')}
                  onClick={() => void doStopProcesses(agent.id)}
                >
                  <Icon name="refresh" className="size-3.5" />
                  {busy === `stop:${agent.id}`
                    ? t('agents.actions.stopping')
                    : t('agents.actions.stop')}
                </button>
              )}
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!agent.applied || busy === `revert:${agent.id}`}
                onClick={() => void doRevert(agent.id)}
              >
                {busy === `revert:${agent.id}`
                  ? t('agents.actions.reverting')
                  : t('agents.actions.revert')}
              </button>
            </div>

            {/*
              连接模式按 Agent 独立选择：Codex 与 Claude Code 协议不同、用途也可能不同，
              共用一个开关会强迫两者同步切换。

              切换本身只改偏好、不自动下发 —— 此时配置可能还不完整（例如刚切到直连
              却还没选供应商），自动 apply 会拿 400 当反馈。用户点「应用配置」才写入。
            */}
            <div className="mt-3 border-t border-line pt-3">
              <span className="block text-xs font-medium text-ink">
                {t('agents.connection.label')}
              </span>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {CONNECTION_MODES.map(([mode, labelKey, descKey]) => {
                  const active = (currentTarget?.mode ?? 'gateway') === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      disabled={settings.data === null || busy === `mode:${agent.id}`}
                      onClick={() => void switchMode(mode, agent.id)}
                      className={`rounded-xl border px-3 py-2 text-left transition ${
                        active
                          ? 'border-accent bg-accent-soft'
                          : 'border-line hover:border-accent/50 hover:bg-subtle'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium text-ink">
                        {active && <Icon name="check" className="size-3.5 text-accent" />}
                        {t(labelKey)}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                        {t(descKey)}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/*
                直连必须明确选一家供应商：多供应商时自动按优先级挑，用户既看不到
                选了谁、也无法干预，而这会把该家的地址和真实 Key 写进配置。
                服务端在保存偏好时就会校验协议匹配与是否停用，所以下拉里已经排除了
                不匹配/已停用的供应商（见 directCandidates）。

                选定后会立即 apply（与切换模式不同）：此时配置已完整，多让用户点一次
                没有额外保护作用。
              */}
              {currentTarget?.mode === 'direct' && (
                <div className="mt-3 rounded-xl border border-line bg-subtle/50 p-3">
                  <label
                    htmlFor={`direct-provider-${agent.id}`}
                    className="block text-[11px] font-medium text-ink"
                  >
                    {t('agents.connection.providerLabel')}
                  </label>
                  <select
                    id={`direct-provider-${agent.id}`}
                    className="input mt-1.5 w-full text-xs"
                    value={currentTarget.directProviderId ?? ''}
                    disabled={busy === `provider:${agent.id}` || settings.data === null}
                    onChange={(event) => void pickDirectProvider(agent.id, event.target.value)}
                  >
                    <option value="">{t('agents.connection.providerPlaceholder')}</option>
                    {directCandidates(agent.id).map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {t('agents.connection.providerOption', {
                          name: provider.name,
                          // 协议标识符是机器值（决定路由），不翻译
                          apiType: provider.apiType,
                          count: provider.models.length,
                        })}
                      </option>
                    ))}
                  </select>
                  {directCandidates(agent.id).length === 0 && (
                    <p className="mt-1.5 text-[11px] leading-4 text-danger">
                      {t('agents.connection.noCandidates', {
                        apiType: requiredApiType(agent.id),
                      })}
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] leading-4 text-muted">
                    {t('agents.connection.hint')}
                  </p>
                </div>
              )}
            </div>

            {/*
              「Approve for me」的模型映射。Codex 在 API Key 认证下会把审批模型
              硬编码成 gpt-5.6-luna（没有任何配置项能改），走网关时网关能看到这个
              请求体字段，于是可以换成别的模型。

              所以只在 mode === 'gateway' 时渲染：直连模式下请求根本不经过本服务，
              这段映射逻辑无从生效，显示出来只会让人以为设了就有用。
            */}
            {agent.id === 'codex' && currentTarget.mode === 'gateway' && (
              <div className="mt-3 border-t border-line pt-3">
                <label
                  htmlFor={`approval-model-${agent.id}`}
                  className="block text-xs font-medium text-ink"
                >
                  {t('agents.approval.label')}
                </label>
                <select
                  id={`approval-model-${agent.id}`}
                  className="input mt-1.5 w-full text-xs"
                  value={settings.data?.approvalReviewModel ?? ''}
                  disabled={busy === 'approval-model' || settings.data === null}
                  onChange={(event) => void pickApprovalModel(event.target.value)}
                >
                  <option value="">{t('agents.approval.none')}</option>
                  {approvalCandidates().map((item) => (
                    <option key={item.model} value={item.model}>
                      {approvalLabel(t, item)}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] leading-4 text-muted">
                  <Trans
                    i18nKey="agents.approval.description"
                    components={{ code: <code className="font-mono" /> }}
                  />
                </p>
                <p className="mt-1 text-[11px] leading-4 text-muted">
                  <Trans
                    i18nKey="agents.approval.legend"
                    components={{ strong: <strong className="text-ink" /> }}
                  />
                </p>
              </div>
            )}

            {/*
              没有任何 responses 供应商时的引导。不自动改设置：
              转换有信息损失，必须由用户明确同意。

              措辞上要点明"下次请求会自动开启"——那是网关侧的行为，与这里的
              开关是两回事，不说清楚用户会以为提示在强迫他先手动勾选。
            */}
            {needsConversionHint(agent.id) && (
              <div className="mt-3 rounded-xl border border-warn/40 bg-warn/5 p-3">
                <p className="text-[11px] leading-4 text-ink">
                  {t('agents.conversion.hint')}
                </p>
              </div>
            )}

            {/*
              跨协议转发。Codex 只会发 /v1/responses，而不少上游只有 Chat
              Completions；打开后由网关做双向转换。

              只在走网关时显示：这是网关侧的行为，直连模式下请求直接打上游，
              本服务没有机会转换，开关也就毫无作用。
            */}
            {agent.id === 'codex' && currentTarget.mode === 'gateway' && (
              <div className="mt-3 border-t border-line pt-3">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-accent"
                    checked={settings.data?.protocolConversion ?? false}
                    disabled={
                      settings.loading || busy === 'toggle:conversion' || settings.data === null
                    }
                    onChange={(event) => void toggleProtocolConversion(event.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-ink">
                      {t('agents.conversion.label')}
                      {busy === 'toggle:conversion' && (
                        <span className="ml-1 text-muted">{t('agents.actions.toggling')}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                      <Trans
                        i18nKey="agents.conversion.description"
                        components={{ code: <code className="font-mono" /> }}
                      />
                    </span>
                  </span>
                </label>
              </div>
            )}

            {/*
              只有 Codex 需要这个开关：web_search 是 Responses 的托管工具，
              聚合上游转 Chat 时普遍不支持，会 400 unsupported_tool。

              与上面的跨协议转发不同，这一项直连时也要显示：它写的是 config.toml，
              两种模式下都生效（直连官方上游时用户往往想保留联网搜索）。
            */}
            {agent.id === 'codex' && (
              <div className="mt-3 border-t border-line pt-3">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 accent-accent"
                    checked={settings.data?.disableCodexWebSearch ?? true}
                    disabled={
                      settings.loading || busy === 'toggle:web_search' || settings.data === null
                    }
                    onChange={(event) => void toggleCodexWebSearch(event.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-ink">
                      {t('agents.webSearch.label')}
                      {busy === 'toggle:web_search' && (
                        <span className="ml-1 text-muted">{t('agents.actions.toggling')}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                      <Trans
                        i18nKey="agents.webSearch.description"
                        components={{ code: <code className="font-mono" /> }}
                      />
                    </span>
                  </span>
                </label>

                {/*
                  流式重连与空闲超时。两项都是 provider 段里的 u64 字段：
                  - stream_max_retries：断流后最多重连几次
                  - stream_idle_timeout_ms：等流式活动的最长时间

                  默认预填 10 / 600000（来自实测）。清空输入框表示"不写该键"，
                  提交 null，此时 Codex 用内置默认（5 次 / 300000ms）。
                */}
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    {/*
                      label 必须用 htmlFor 关联到 input（这里用 useId 生成唯一 id）：
                      没有关联时点 label 不会聚焦输入框，读屏软件也读不出这是哪个字段。
                      与 ProviderForm 的处理保持一致。
                    */}
                    <label className="label flex items-center gap-1.5" htmlFor={streamRetriesId}>
                      {t('agents.stream.retriesLabel')}
                      {busy === 'toggle:stream' && (
                        <span className="text-[11px] font-normal text-muted">
                          {t('common.saving')}
                        </span>
                      )}
                    </label>
                    <input
                      id={streamRetriesId}
                      type="number"
                      className="input font-mono"
                      min={0}
                      max={100}
                      step={1}
                      value={streamMaxRetries}
                      disabled={settings.loading || busy === 'toggle:stream'}
                      placeholder={t('agents.stream.retriesPlaceholder')}
                      onChange={(event) => setStreamMaxRetries(event.target.value)}
                      onBlur={() => void persistStreamOptions()}
                    />
                    <p className="field-hint">{t('agents.stream.retriesHint')}</p>
                  </div>
                  <div>
                    <label className="label" htmlFor={streamIdleId}>
                      {t('agents.stream.idleLabel')}
                    </label>
                    <input
                      id={streamIdleId}
                      type="number"
                      className="input font-mono"
                      min={1000}
                      max={3600000}
                      step={1000}
                      value={streamIdleTimeoutMs}
                      disabled={settings.loading || busy === 'toggle:stream'}
                      placeholder={t('agents.stream.idlePlaceholder')}
                      onChange={(event) => setStreamIdleTimeoutMs(event.target.value)}
                      onBlur={() => void persistStreamOptions()}
                    />
                    <p className="field-hint">{t('agents.stream.idleHint')}</p>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-muted">
                  <Trans
                    i18nKey="agents.stream.note"
                    components={{
                      strong: <strong className="text-ink" />,
                      code: <code className="font-mono" />,
                    }}
                  />
                </p>
              </div>
            )}
          </Card>
          );
        })}
      </div>

      {preview && (
        <Card
          title={t('agents.preview.title', { name: preview.name })}
          desc={t('agents.preview.gatewayBaseUrl', { url: preview.gatewayBaseUrl })}
          actions={
            <IconButton
              icon="x"
              label={t('agents.preview.close')}
              onClick={() => setPreview(null)}
            />
          }
        >
          <div className="space-y-5">
            {preview.files.map((file) => (
              <div key={file.role}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-subtle text-muted">
                    <Icon
                      name={file.role === 'auth' ? 'key' : 'settings'}
                      className="size-3.5"
                    />
                  </span>
                  <code className="font-mono text-xs text-ink">{file.path}</code>
                  {file.exists ? (
                    <Badge tone="neutral">{t('agents.preview.exists')}</Badge>
                  ) : (
                    <Badge tone="accent">{t('agents.preview.willCreate')}</Badge>
                  )}
                  {/* file.role 是机器标识（auth / settings / config），不翻译 */}
                  <Badge tone="neutral">{file.role}</Badge>
                </div>
                {file.entries.length === 0 ? (
                  <Empty>{t('agents.preview.emptyFile')}</Empty>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-line">
                    <div className="overflow-x-auto">
                      <table className="table-base">
                        <thead>
                          <tr>
                            <th>{t('agents.preview.columns.key')}</th>
                            <th>{t('agents.preview.columns.current')}</th>
                            <th>{t('agents.preview.columns.next')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {file.entries.map((entry) => (
                            <tr key={entry.key}>
                              <td className="font-mono text-xs text-ink">{entry.key}</td>
                              <td className="max-w-[18rem] break-all font-mono text-[11px] text-muted">
                                {entry.current ?? t('agents.preview.currentUnset')}
                              </td>
                              <td className="max-w-[18rem] break-all font-mono text-[11px] text-ink">
                                {entry.next}
                                {entry.differs && (
                                  <span
                                    className="ml-1 text-danger"
                                    title={t('agents.preview.differs')}
                                  >
                                    ●
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
