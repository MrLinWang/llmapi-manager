/**
 * Agent 下发、进程管理与模型目录的服务端文案。
 *
 * 这里既有"报错"（经 `AppError` 的键 + 参数下发），也有"会被写进文件或直接展示
 * 给用户看的说明文字"（预览条目、进程操作的 actions/warnings、Codex 目录里每个
 * 推理档位的描述）。后者不是错误，但同样出现在界面或用户终端里，所以一并走字典。
 *
 * 不翻译的标识符（按 AGENTS.md 第 16 条）：`Codex`、`Claude Code`、`config.toml`、
 * `auth.json`、`settings.json`、`model_catalog_json`、`~/.codex`、`~/.claude`、
 * `web_search`、`turn_trigger`、`guardian_review`、`gpt-5.6-luna`、`lam-` 别名、
 * `/v1/...`。
 */
export const zhAgents = {
  /** registry 里的静态 Agent 描述：静态数据拿不到请求语言，存键、由路由层渲染 */
  description: {
    codex: '写入 ~/.codex 下的 config.toml 与 auth.json，把请求指向本服务的网关。',
    claudeCode: '写入 ~/.claude/settings.json 的 env 段，把 Anthropic 请求指向本服务。',
  },
  error: {
    unknownAgent: '未知 Agent: {{id}}',
    notBound: 'Agent {{name}} 当前没有被接管，无需还原',
    gatewayTokenMissing: '尚未生成网关令牌，请先在"模型聚合"页生成',
    providerNoModels: '供应商 {{provider}} 未声明任何模型，请先在供应商页补充模型',
    providerNoBaseUrl: '供应商 {{provider}} 没有配置 Base URL，无法直连',
    providerNoApiKey: '供应商 {{provider}} 没有配置 API Key，无法直连',
    directProviderNotFound: '指定的直连供应商不存在，请重新选择',
    directProviderDisabled: '指定的直连供应商「{{provider}}」已被停用，请重新选择或先启用它',
    directProviderWrongApiType: '供应商「{{provider}}」的协议类型不适用于该 Agent，需要 {{types}}',
    directProviderRequired: '直连模式需要明确指定供应商：请在该 Agent 的配置里选择一家{{types}}供应商',
    /** 一家协议匹配的供应商都没有（网关模式与直连模式共用同一句） */
    noProvider: '没有可用的 {{types}} 供应商，请先添加并启用',
    /**
     * Codex 专用：它只认 Responses 协议，只报"没有供应商"会让用户不知道该改哪一项。
     * 整句写进字典而不是拼一个 hint 参数，避免在服务层二次渲染（服务层不负责任何语言）。
     */
    noProviderCodex:
      '没有可用的 {{types}} 供应商，请先添加并启用。Codex CLI 只支持 Responses 协议：请把某个供应商的协议类型改为「OpenAI 兼容（Responses）」，或新增一个 responses 供应商',
  },
  preview: {
    /** 生成类文件（Codex 模型目录）在预览表里的"键"列 */
    generatedKey: '（整份生成）',
    generatedWillOverwrite: '（将被覆盖，已自动备份）',
    /** 用"包含 / 条目数"的写法，避开英文单复数：服务端 translate 不带复数能力 */
    generatedModelCount: '包含 {{count}} 个模型别名',
    generatedStale: '（上一模式留下的目录，将被删除）',
    removed: '（删除）',
  },
  revert: {
    /** 生成类文件没有"我们写入的键"，冲突说明要讲清它是整份由我们产出的 */
    generatedExpected: '(由本服务生成)',
    generatedResetCurrent: '文件原本存在，已重置为空对象',
  },
  process: {
    daemonStopped: '已停止 Codex 守护进程（codex app-server daemon stop）',
    daemonCommandMissing: '未找到 codex 命令，跳过守护进程停止（仅结束本机进程）',
    daemonNotRunning: 'Codex 守护进程本来就没有运行',
    daemonStopFailed: '停止守护进程失败：{{detail}}',
    pidKillFailed: '结束 {{file}} 记录的进程 {{pid}} 失败：{{detail}}',
    daemonKilledByPid: '已按 pid 文件结束 {{count}} 个 Codex 守护进程',
    killFailed: '结束进程 {{pid}} 失败：{{detail}}',
    clientsKilled: '已结束 {{count}} 个 Codex 客户端进程',
    stillAlive: '{{count}} 个进程在 SIGKILL 后仍未退出（pid {{pids}}），可能需要手动处理',
    allExited: '已确认相关进程全部退出',
    /** Claude Code 没有常驻进程：说清"不支持"而不是返回一个空 actions 让用户猜 */
    noneForAgent: '{{agent}} 没有需要结束的常驻进程',
    noneRunning: '本机没有正在运行的 Codex 进程',
  },
  catalog: {
    /** 目录条目上"来自哪家、哪个上游模型"的次要文字（Codex 的 /model 列表会显示） */
    providedBy: '{{provider}} 提供的 {{model}}',
    approvalPlaceholder: 'Approve for me：由网关映射到你在控制台选定的审批模型',
  },
  /** 推理档位的说明，写进 Codex 模型目录、由 /model 列表展示 */
  reasoning: {
    none: '不使用推理，直接作答',
    minimal: '最小推理投入，最快响应',
    low: '快速响应，推理较轻',
    medium: '速度与推理深度均衡',
    high: '更深的推理，适合复杂问题',
    xhigh: '很高的推理投入，适合困难任务',
    max: '最大推理投入，最慢但最深入',
    ultra: '极高推理投入（含并发子代理）',
    persistent: '持续推理，直到得出结论',
  },
};
