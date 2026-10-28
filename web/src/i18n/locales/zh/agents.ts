/**
 * Agent 配置页文案。
 *
 * 这一页文案密度最高，且多处夹着标识符与配置键（`gpt-5.6-luna`、`/v1/responses`、
 * `web_search`、`turn_trigger=guardian_review`）。标识符**原样留在文案里**、不翻译，
 * 需要样式的地方用 `<Trans>` 的 `code` / `strong` 组件包起来：
 * 字典值里写 `<code>gpt-5.6-luna</code>`，页面里不再手工拼 JSX。
 *
 * 计数句用 `_one` / `_other` 两份键（中文两份文本相同），调用 `t(key, { count })`。
 */
export const zhAgents = {
  header: {
    eyebrow: '本机集成',
    description:
      '把聚合后的网关地址与令牌写入各 Agent 的配置文件。只改本系统拥有的键，写入前自动备份。',
    count_one: '{{count}} 个 Agent',
    count_other: '{{count}} 个 Agent',
  },
  empty: '没有可用的 Agent',
  status: {
    applied: '已接管',
    notApplied: '未接管',
  },
  card: {
    /** 时间先经 `formatDateTime` 按界面语言格式化，再作为 `time` 插值。 */
    appliedAt: '最近下发：{{time}}',
  },
  actions: {
    preview: '预览',
    previewing: '预览中…',
    apply: '应用配置',
    applying: '写入中…',
    reapply: '重新应用',
    revert: '还原',
    reverting: '还原中…',
    stop: '退出 Codex 进程',
    stopping: '结束中…',
    stopTitle: '结束本机正在运行的 Codex（TUI 与托管守护进程），让它重新读取配置与模型目录',
    toggling: '切换中…',
  },
  connection: {
    label: '连接方式',
    gateway: {
      label: '走网关',
      desc: '请求经本服务转发，可换源、回退并记录请求日志。',
    },
    direct: {
      label: '直连上游',
      desc: '把上游地址与 Key 直接写进配置；不启动本服务也能用。',
    },
    providerLabel: '直连供应商',
    providerPlaceholder: '请选择供应商…',
    providerOption_one: '{{name}}（{{apiType}}）· {{count}} 个模型',
    providerOption_other: '{{name}}（{{apiType}}）· {{count}} 个模型',
    noCandidates: '没有可用的供应商：该 Agent 需要 {{apiType}} 协议的供应商。',
    hint: '选定后会把该供应商的地址与 Key 写进配置。切换供应商后记得点「应用配置」。',
  },
  approval: {
    label: 'Approve for me 使用的模型',
    none: '不映射（跟随 Codex 默认）',
    /** 下拉项：模型名 + 会落到哪家供应商 + 是否直通。 */
    option: '{{model}} — 走 {{providerName}} ({{providerKey}}/{{apiType}}, {{tag}})',
    direct: '直通',
    convert: '需转换',
    /** 同名模型被多家声明时的后缀；`names` 已用 `separators.enumeration` 连接。 */
    sharedWith: '{{base}}；{{names}} 也声明了同名模型',
    description:
      'Codex 把审批模型写死为 <code>gpt-5.6-luna</code>，无法配置。走网关时本服务能识别审批请求（<code>turn_trigger=guardian_review</code>），把其中的模型名替换成这里选定的模型。只在走网关时生效。',
    legend:
      '每项标注了会走哪家供应商：<strong>直通</strong>表示协议匹配、不转换；<strong>需转换</strong>表示要经过跨协议转换（有信息损失）。同名模型被多家声明时，由网关优先选协议匹配的那家——这里只锁定模型名，不锁定供应商。',
  },
  conversion: {
    label: '跨协议转发（Responses → Chat）',
    description:
      '打开后，发往 <code>/v1/responses</code> 的请求可以落到「OpenAI 兼容（Chat）」供应商上，由网关转换请求、响应与流式事件（含工具调用）。关闭时协议不匹配一律返回 501。转换有信息损失：托管工具（如 <code>web_search</code>）没有 Chat 等价物会被丢弃，依赖会话状态的字段会直接报错。',
    hint: '当前没有「Responses」协议的可启用供应商。已有「Chat」供应商，下次请求会自动开启跨协议转发并由网关转换；你也可以现在就勾选下方开关。',
  },
  webSearch: {
    label: '关闭联网搜索（web_search = "disabled"）',
    description:
      'Codex 默认把 <code>web_search</code> 作为 Responses 托管工具塞进请求，多数聚合上游转 Chat 线路时不支持，会报 <code>unsupported_tool</code>。直连官方上游可关掉此项以保留联网搜索。',
  },
  stream: {
    retriesLabel: '流式重连上限',
    retriesPlaceholder: '5（Codex 默认）',
    retriesHint: '单位：次，允许 0–100。留空表示不写该键、使用 Codex 默认 5 次。',
    idleLabel: '流式空闲超时',
    idlePlaceholder: '300000（Codex 默认）',
    idleHint: '单位：毫秒，允许 1000–3600000。留空表示使用 Codex 默认 300000（5 分钟）。',
    note: '链路在空闲约 60 秒时被上游/反向代理掐断的情况下，提高重连上限能减少「重试耗尽后整轮失败」，但<strong>不能消除重连本身</strong>——它只是让每次被掐断后更可能接上。空闲超时放宽的是 <code>Codex 自己的判据</code>，管不了对端主动断连。',
  },
  messages: {
    /* 服务端返回的 cause.message 是中文、原样显示，不进这里。 */
    applied: '配置已写入。若该 Agent 正在运行，请重启以加载新配置。',
    appliedWithRunning_one:
      '配置已写入，但检测到 {{count}} 个 {{agent}} 进程仍在运行。它们用的是旧配置，必须退出后重新启动才生效。',
    appliedWithRunning_other:
      '配置已写入，但检测到 {{count}} 个 {{agent}} 进程仍在运行。它们用的是旧配置，必须退出后重新启动才生效。',
    reopenCodexHint:
      '重新打开 Codex 即可加载最新配置。也可手动执行 <code>pkill -9 -f codex</code> 来清理相关进程。',
    manualKillHint: '也可手动执行 <code>pkill -9 -f codex</code> 来清理相关进程。',
    webSearchOff: '已关闭联网搜索并重新应用配置。Codex 不再发送 web_search 工具。',
    webSearchOn: '已开启联网搜索并重新应用配置。上游若不支持该工具会报 unsupported_tool。',
    streamCleared: '已清空流式参数（改用 Codex 默认）。已重新应用配置。重启 Codex 后生效。',
    streamSaved: '已保存流式参数并已重新应用配置。重启 Codex 后生效。',
    streamInvalid: '流式参数必须是数字，或留空使用默认值',
    approvalSet: '已设置：审批请求里的 gpt-5.6-luna 会被换成 {{model}}。',
    approvalCleared: '已清除审批模型映射，审批将按 Codex 默认行为调用。',
    conversionOn:
      '已开启跨协议转发：Responses 请求会被转成 Chat 发给上游。托管工具（如 web_search）无等价物，会被丢弃。',
    conversionOff: '已关闭跨协议转发：协议不匹配的请求将返回 501。',
    directProviderSet: '已选定直连供应商并写入配置。之后不启动本服务也能用。',
    directProviderCleared: '已清除直连供应商选择。',
    /**
     * 还原结果拆成两句：还原了几个键、有几个因手改而保留。
     * 两处计数各自取复数，英文才不会出现"Reverted 1 keys"。
     */
    reverted_one: '已还原 {{count}} 个键',
    reverted_other: '已还原 {{count}} 个键',
    conflictsKept_one: '{{count}} 个键因被手动修改而保留：{{keys}}',
    conflictsKept_other: '{{count}} 个键因被手动修改而保留：{{keys}}',
  },
  preview: {
    title: '{{name}} · 配置预览',
    gatewayBaseUrl: '网关地址：{{url}}',
    close: '关闭预览',
    exists: '已存在',
    willCreate: '将创建',
    emptyFile: '该文件无需写入',
    /**
     * 预览表格的空值占位。
     *
     * 不复用 `common.notSet`：那一份是"未设置"（无括号），用在供应商卡片的 Key 行；
     * 这里原文是全角括号包起来的占位，换成无括号会改变这个只读表格的视觉。
     */
    currentUnset: '（未设置）',
    columns: {
      key: '键',
      current: '当前值',
      next: '将写入',
    },
    differs: '与当前值不同',
  },
  /**
   * 句子连接符。
   *
   * 这些提示是「服务端返回的中文文本 + 前端文案」拼接出来的（错误前缀、进程结论），
   * 无法整体塞进一条 Trans；中间的分隔符仍要跟随界面语言：中文全角、英文半角加空格。
   * 单独成键是为了避免各处硬编码 `。` / `；` / `、`。
   */
  separators: {
    /** 句末句号；也用于把"服务端原文"与"前端追加句"接起来 */
    sentence: '。',
    list: '；',
    enumeration: '、',
  },
};
