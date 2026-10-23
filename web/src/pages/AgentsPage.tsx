import { useState } from 'react';
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

function agentIcon(id: string): IconName {
  return id === 'codex' ? 'terminal' : 'agents';
}

export default function AgentsPage(): JSX.Element {
  const agents = useAsync(() => api.agents());
  const settings = useAsync(() => api.settings());
  const providers = useAsync(() => api.providers());
  const [preview, setPreview] = useState<AgentPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '操作失败');
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

  const doStopProcesses = (id: string): Promise<void> =>
    run(`stop:${id}`, async () => {
      const result = await api.stopAgentProcesses(id);
      // actions 由后端补齐（包含"本机没有正在运行的 Codex 进程"这种情况），
      // 前端不再自己推断，避免两处逻辑各说一套。
      const parts: string[] = [...result.actions];
      if (result.warnings.length > 0) parts.push(...result.warnings);
      const text = parts.join('；');
      if (result.warnings.length > 0 && result.actions.length === 0) {
        setError(text);
      } else {
        setMessage(`${text}。重新打开 Codex 即可加载最新配置。`);
      }
    });

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
   * 可映射的审批模型：只取 responses 供应商声明的模型。
   *
   * 为什么限定 responses：审批请求走的是 Codex 的 /v1/responses 路径，映射目标若来自
   * 一家 openai 供应商，网关还得再做一次协议转换，等于给用户多埋一层可能失败的环节。
   * 宁可不列出，也别给一个大概率走不通的选项。
   */
  const approvalCandidates = (): string[] => {
    const needed = 'responses';
    return (providers.data?.providers ?? [])
      .filter((provider) => provider.enabled && provider.apiType === needed)
      .flatMap((provider) => provider.models);
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
                  {approvalCandidates().map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <p className="mt-1.5 text-[11px] leading-4 text-muted">
                  Codex 把审批模型写死为{' '}
                  <code className="font-mono">gpt-5.6-luna</code>，无法配置。走网关时本服务
                  能识别审批请求（<code className="font-mono">turn_trigger=guardian_review</code>
                  ），把其中的模型名替换成这里选定的模型。只在走网关时生效。
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
