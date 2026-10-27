import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
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
function approvalLabel(item: ApprovalCandidate): string {
  const tag = item.direct ? '直通' : '需转换';
  const base = `${item.model} — 走 ${item.providerName} (${item.providerKey}/${item.apiType}, ${tag})`;
  // 同名模型被多家声明时说清楚：最终由网关按协议匹配挑，用户不必也不能指定
  return item.sharedWith.length === 0
    ? base
    : `${base}；${item.sharedWith.join('、')} 也声明了同名模型`;
}

function agentIcon(id: string): IconName {
  return id === 'codex' ? 'terminal' : 'agents';
}

/**
 * 「退出 Codex 进程」提示里的手动兜底命令。
 *
 * 结束进程是尽力而为：`codex app-server daemon stop` 在配置目录只读时会直接失败，
 * 自定义安装位置的进程也可能匹配不到。此时只报"已结束/没有进程"会让用户以为按钮
 * 无效，而不知道下一步该做什么，所以每次都把这条命令一起给出。
 *
 * 用 <code> 而不是纯文本，是为了让命令在中文提示里能一眼看清（与页面其他内联命令一致）。
 */
const MANUAL_CODEX_KILL_HINT: ReactNode = (
  <>
    也可手动执行 <code className="font-mono">pkill -9 -f codex</code> 来清理相关进程。
  </>
);

export default function AgentsPage(): JSX.Element {
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
      const text = cause instanceof ApiError ? cause.message : '操作失败';
      setError(failureHint ? <>{text}。{failureHint}</> : text);
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
          ? `配置已写入，但检测到 ${running} 个 ${id === 'codex' ? 'Codex' : 'Claude Code'} 进程仍在运行。它们用的是旧配置，必须退出后重新启动才生效。`
          : '配置已写入。若该 Agent 正在运行，请重启以加载新配置。',
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
        const text = parts.join('；');
        if (result.warnings.length > 0 && result.actions.length === 0) {
          setError(
            <>
              {text}。{MANUAL_CODEX_KILL_HINT}
            </>,
          );
        } else {
          setMessage(
            <>
              {text}。重新打开 Codex 即可加载最新配置。{MANUAL_CODEX_KILL_HINT}
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
        next
          ? '已关闭联网搜索并重新应用配置。Codex 不再发送 web_search 工具。'
          : '已开启联网搜索并重新应用配置。上游若不支持该工具会报 unsupported_tool。',
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
    hint: string;
  }): Promise<void> =>
    run('toggle:stream', async () => {
      await api.setCodexOptions({
        codexStreamMaxRetries: input.codexStreamMaxRetries,
        codexStreamIdleTimeoutMs: input.codexStreamIdleTimeoutMs,
      });
      await api.applyAgent('codex');
      setMessage(`${input.hint}已重新应用配置。重启 Codex 后生效。`);
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
      setError('流式参数必须是数字，或留空使用默认值');
      return Promise.resolve();
    }

    return saveCodexStreamOptions({
      codexStreamMaxRetries: nextRetries,
      codexStreamIdleTimeoutMs: nextIdle,
      hint:
        nextRetries === null && nextIdle === null
          ? '已清空流式参数（改用 Codex 默认）。'
          : '已保存流式参数并',
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
          ? `已设置：审批请求里的 gpt-5.6-luna 会被换成 ${model}。`
          : '已清除审批模型映射，审批将按 Codex 默认行为调用。',
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
        next
          ? '已开启跨协议转发：Responses 请求会被转成 Chat 发给上游。托管工具（如 web_search）无等价物，会被丢弃。'
          : '已关闭跨协议转发：协议不匹配的请求将返回 501。',
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
          ? '已选定直连供应商并写入配置。之后不启动本服务也能用。'
          : '已清除直连供应商选择。',
      );
      settings.reload();
      agents.reload();
      if (preview?.agentId === id) setPreview(await api.previewAgent(id));
    });

  const doRevert = (id: string): Promise<void> =>
    run(`revert:${id}`, async () => {
      const result = await api.revertAgent(id);
      if (result.conflicts.length > 0) {
        setMessage(
          `已还原 ${result.restored.length} 个键；${result.conflicts.length} 个键因被手动修改而保留：${result.conflicts
            .map((item) => item.key)
            .join('、')}`,
        );
      } else {
        setMessage(`已还原 ${result.restored.length} 个键。`);
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
    const needed = id === 'claude-code' ? 'anthropic' : 'responses';
    return (providers.data?.providers ?? []).filter(
      (provider) => provider.enabled && provider.apiType === needed,
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="本机集成"
        title="Agent 配置"
        description="把聚合后的网关地址与令牌写入各 Agent 的配置文件。只改本系统拥有的键，写入前自动备份。"
        actions={<Badge tone="neutral">{agents.data?.agents.length ?? 0} 个 Agent</Badge>}
      />

      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}

      {agents.loading && <Spinner />}
      {agents.data && agents.data.agents.length === 0 && (
        <Empty icon="agents">没有可用的 Agent</Empty>
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
                      已接管
                    </Badge>
                  ) : (
                    <Badge dot>未接管</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted">{agent.description}</p>
                {agent.appliedAt && (
                  <p className="mt-1 text-[11px] text-muted">
                    最近下发：{new Date(agent.appliedAt).toLocaleString()}
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
                {busy === `preview:${agent.id}` ? '预览中…' : '预览'}
              </button>
              <button
                type="button"
                className="btn-primary btn-sm"
                disabled={busy === `apply:${agent.id}`}
                onClick={() => void doApply(agent.id)}
              >
                <Icon name="zap" className="size-3.5" />
                {busy === `apply:${agent.id}` ? '写入中…' : agent.applied ? '重新应用' : '应用配置'}
              </button>
              {/* 只有 Codex 有常驻进程与启动时快照的模型目录，Claude Code 不需要 */}
              {agent.id === 'codex' && (
                <button
                  type="button"
                  className="btn-outline btn-sm"
                  disabled={busy === `stop:${agent.id}`}
                  title="结束本机正在运行的 Codex（TUI 与托管守护进程），让它重新读取配置与模型目录"
                  onClick={() => void doStopProcesses(agent.id)}
                >
                  <Icon name="refresh" className="size-3.5" />
                  {busy === `stop:${agent.id}` ? '结束中…' : '退出 Codex 进程'}
                </button>
              )}
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={!agent.applied || busy === `revert:${agent.id}`}
                onClick={() => void doRevert(agent.id)}
              >
                {busy === `revert:${agent.id}` ? '还原中…' : '还原'}
              </button>
            </div>

            {/*
              连接模式按 Agent 独立选择：Codex 与 Claude Code 协议不同、用途也可能不同，
              共用一个开关会强迫两者同步切换。

              切换本身只改偏好、不自动下发 —— 此时配置可能还不完整（例如刚切到直连
              却还没选供应商），自动 apply 会拿 400 当反馈。用户点「应用配置」才写入。
            */}
            <div className="mt-3 border-t border-line pt-3">
              <span className="block text-xs font-medium text-ink">连接方式</span>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ['gateway', '走网关', '请求经本服务转发，可换源、回退并记录请求日志。'],
                    ['direct', '直连上游', '把上游地址与 Key 直接写进配置；不启动本服务也能用。'],
                  ] as Array<[AgentConnectionMode, string, string]>
                ).map(([mode, label, desc]) => {
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
                        {label}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                        {desc}
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
                    直连供应商
                  </label>
                  <select
                    id={`direct-provider-${agent.id}`}
                    className="input mt-1.5 w-full text-xs"
                    value={currentTarget.directProviderId ?? ''}
                    disabled={busy === `provider:${agent.id}` || settings.data === null}
                    onChange={(event) => void pickDirectProvider(agent.id, event.target.value)}
                  >
                    <option value="">请选择供应商…</option>
                    {directCandidates(agent.id).map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}（{provider.apiType}）· {provider.models.length} 个模型
                      </option>
                    ))}
                  </select>
                  {directCandidates(agent.id).length === 0 && (
                    <p className="mt-1.5 text-[11px] leading-4 text-danger">
                      没有可用的供应商：该 Agent 需要{' '}
                      {agent.id === 'claude-code' ? 'anthropic' : 'responses'} 协议的供应商。
                    </p>
                  )}
                  <p className="mt-1.5 text-[11px] leading-4 text-muted">
                    选定后会把该供应商的地址与 Key 写进配置。切换供应商后记得点「应用配置」。
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
                  Approve for me 使用的模型
                </label>
                <select
                  id={`approval-model-${agent.id}`}
                  className="input mt-1.5 w-full text-xs"
                  value={settings.data?.approvalReviewModel ?? ''}
                  disabled={busy === 'approval-model' || settings.data === null}
                  onChange={(event) => void pickApprovalModel(event.target.value)}
                >
                  <option value="">不映射（跟随 Codex 默认）</option>
                  {approvalCandidates().map((item) => (
                    <option key={item.model} value={item.model}>
                      {approvalLabel(item)}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] leading-4 text-muted">
                  Codex 把审批模型写死为{' '}
                  <code className="font-mono">gpt-5.6-luna</code>，无法配置。走网关时本服务
                  能识别审批请求（<code className="font-mono">turn_trigger=guardian_review</code>
                  ），把其中的模型名替换成这里选定的模型。只在走网关时生效。
                </p>
                <p className="mt-1 text-[11px] leading-4 text-muted">
                  每项标注了会走哪家供应商：<strong className="text-ink">直通</strong>
                  表示协议匹配、不转换；<strong className="text-ink">需转换</strong>
                  表示要经过跨协议转换（有信息损失）。同名模型被多家声明时，
                  由网关优先选协议匹配的那家——这里只锁定模型名，不锁定供应商。
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
                  当前没有「Responses」协议的可启用供应商。已有「Chat」供应商，
                  下次请求会自动开启跨协议转发并由网关转换；你也可以现在就勾选下方开关。
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
                      跨协议转发（Responses → Chat）
                      {busy === 'toggle:conversion' && (
                        <span className="ml-1 text-muted">切换中…</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                      打开后，发往 <code className="font-mono">/v1/responses</code> 的请求可以落到
                      「OpenAI 兼容（Chat）」供应商上，由网关转换请求、响应与流式事件（含工具调用）。
                      关闭时协议不匹配一律返回 501。转换有信息损失：托管工具（如{' '}
                      <code className="font-mono">web_search</code>）没有 Chat 等价物会被丢弃，
                      依赖会话状态的字段会直接报错。
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
                      关闭联网搜索（web_search = "disabled"）
                      {busy === 'toggle:web_search' && (
                        <span className="ml-1 text-muted">切换中…</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-muted">
                      Codex 默认把 <code className="font-mono">web_search</code> 作为 Responses
                      托管工具塞进请求，多数聚合上游转 Chat 线路时不支持，会报{' '}
                      <code className="font-mono">unsupported_tool</code>。直连官方上游可关掉此项以保留联网搜索。
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
                      流式重连上限
                      {busy === 'toggle:stream' && (
                        <span className="text-[11px] font-normal text-muted">保存中…</span>
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
                      placeholder="5（Codex 默认）"
                      onChange={(event) => setStreamMaxRetries(event.target.value)}
                      onBlur={() => void persistStreamOptions()}
                    />
                    <p className="field-hint">
                      单位：次，允许 0–100。留空表示不写该键、使用 Codex 默认 5 次。
                    </p>
                  </div>
                  <div>
                    <label className="label" htmlFor={streamIdleId}>流式空闲超时</label>
                    <input
                      id={streamIdleId}
                      type="number"
                      className="input font-mono"
                      min={1000}
                      max={3600000}
                      step={1000}
                      value={streamIdleTimeoutMs}
                      disabled={settings.loading || busy === 'toggle:stream'}
                      placeholder="300000（Codex 默认）"
                      onChange={(event) => setStreamIdleTimeoutMs(event.target.value)}
                      onBlur={() => void persistStreamOptions()}
                    />
                    <p className="field-hint">
                      单位：毫秒，允许 1000–3600000。留空表示使用 Codex 默认 300000（5 分钟）。
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-muted">
                  链路在空闲约 60 秒时被上游/反向代理掐断的情况下，提高重连上限能减少
                  「重试耗尽后整轮失败」，但<strong className="text-ink">不能消除重连本身</strong>
                  ——它只是让每次被掐断后更可能接上。空闲超时放宽的是{' '}
                  <code className="font-mono">Codex 自己的判据</code>，管不了对端主动断连。
                </p>
              </div>
            )}
          </Card>
          );
        })}
      </div>

      {preview && (
        <Card
          title={`${preview.name} · 配置预览`}
          desc={`网关地址：${preview.gatewayBaseUrl}`}
          actions={
            <IconButton
              icon="x"
              label="关闭预览"
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
                    <Badge tone="neutral">已存在</Badge>
                  ) : (
                    <Badge tone="accent">将创建</Badge>
                  )}
                  <Badge tone="neutral">{file.role}</Badge>
                </div>
                {file.entries.length === 0 ? (
                  <Empty>该文件无需写入</Empty>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-line">
                    <div className="overflow-x-auto">
                      <table className="table-base">
                        <thead>
                          <tr>
                            <th>键</th>
                            <th>当前值</th>
                            <th>将写入</th>
                          </tr>
                        </thead>
                        <tbody>
                          {file.entries.map((entry) => (
                            <tr key={entry.key}>
                              <td className="font-mono text-xs text-ink">{entry.key}</td>
                              <td className="max-w-[18rem] break-all font-mono text-[11px] text-muted">
                                {entry.current ?? '（未设置）'}
                              </td>
                              <td className="max-w-[18rem] break-all font-mono text-[11px] text-ink">
                                {entry.next}
                                {entry.differs && (
                                  <span className="ml-1 text-danger" title="与当前值不同">
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
