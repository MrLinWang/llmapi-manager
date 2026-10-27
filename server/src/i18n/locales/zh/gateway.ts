/**
 * 网关与别名文案。
 *
 * 这些文案会经 `/v1/*` 的响应体直接回给调用方（可能是人，也可能是 Agent），
 * 所以必须跟随请求语言。标识符（`lam-`、`/v1/...`、apiType 机器值）一律不翻译。
 */
export const zhGateway = {
  apiType: {
    openai: 'OpenAI 兼容（Chat Completions）',
    anthropic: 'Anthropic 兼容（Messages）',
    responses: 'OpenAI 兼容（Responses）',
  },
  auth: {
    /** `/v1/*` 的 401：调用方（Agent 脚本）会直接看到这句 */
    invalidToken: '网关令牌缺失或无效',
  },
  alias: {
    missingSeparator: '别名 {{alias}} 缺少 "/" 分隔符',
    incomplete: '别名 {{alias}} 格式不完整',
    unknownProvider: '未知供应商 key: {{key}}',
    providerDisabled: '供应商 {{name}} 已禁用',
    modelNotDeclared: '供应商 {{name}} 未声明模型 {{model}}',
  },
  selection: {
    /** 供应商被停用（不是删除） */
    providerDisabled: '已停用',
    /** 协议不匹配，且转换帮不上忙 */
    protocolMismatch: '协议不匹配：需要 {{required}}，它是 {{apiType}}',
    protocolMismatchNoConversion:
      '协议不匹配：需要 {{required}}，它是 {{apiType}}（转换只支持 responses→chat，当前开关未开或方向不适用）',
    noEnabledProviderOfType: '没有启用的 {{required}} 供应商，请先在控制台添加并启用',
    noEnabledProvider: '没有启用的供应商，请先在控制台添加并启用',
    /** 审批模型落在需要转换的供应商上 */
    approvalNeedsConversionOff:
      '审批模型 {{model}} 属于 {{apiType}} 供应商 {{name}}，但本次请求走 {{path}}（需要 {{required}}），当前未开启跨协议转发',
    approvalModelMissing:
      '已设置的审批模型 {{model}} 不在任何已启用供应商的模型列表里，请检查供应商配置或重新选择审批模型',
    /** 别名指向的供应商已被删除（不是禁用，是记录消失） */
    providerGone: '别名指向的供应商已不存在',
    /** 审批模型落在协议不匹配的供应商上 */
    approvalNeedsConversion:
      '审批模型 {{model}} 属于 {{apiType}} 供应商 {{name}}，而本次请求需要 {{required}} 上游',
  },
  forward: {
    requestConvertFailed: '请求无法转换为 Chat 格式：{{detail}}',
    responseConvertFailed: '上游响应无法转换为 Responses 格式：{{detail}}',
    requestAborted: '请求被中止（客户端断开或超时）',
    upstreamRequestFailed: '上游请求失败：{{detail}}',
    upstreamStatus: '上游返回 {{status}}',
    upstreamEmptyBody: '上游未返回响应体',

    /**
     * 开着转换开关，但这组协议没有转换器。
     * 不说"请联系管理员"——用户自己就是管理员。
     */
    conversionUnsupported:
      '不支持 {{path}} → {{apiType}} 的转换：目前只支持 Responses → Chat，供应商 {{name}} 是 {{apiType}}',
    /** 没开转换开关，且打开就能解决 */
    conversionDisabled:
      '未开启协议转换：{{path}} 需要 {{required}} 上游，而供应商 {{name}} 是 {{apiType}}。可在设置页开启"跨协议转发"让网关把 Responses 请求转成 Chat 发送',
  },
  convert: {
    /** 请求体不是对象 / input 类型不对等结构性错误 */
    inputElementInvalid: 'input 数组里的元素必须是对象或字符串',
    functionCallIncomplete: 'function_call 缺少 call_id 或 name',
    customToolCallIncomplete: 'custom_tool_call 缺少 call_id 或 name',
    customToolOutputNoCallId: 'custom_tool_call_output 缺少 call_id',
    functionOutputNoCallId: 'function_call_output 缺少 call_id',
    unsupportedRole: 'input 消息的 role 不支持: {{role}}',
    unsupportedInputType: '不支持的 input 项类型: {{type}}',
    toolElementInvalid: 'tools 里的元素必须是对象',
    /** 工具没写 description 时给 Chat 上游的兜底说明 */
    rawTextToolInput: '工具的原始文本输入',
    bodyNotObject: '请求体必须是 JSON 对象',
    inputNotStringOrArray: 'input 必须是字符串或数组',
    noMessagesAfterConversion: '转换后没有任何消息，请检查 input 与 instructions',
    /** 上游返回的结构不符合 Chat 规范 */
    responseNotObject: '上游响应不是 JSON 对象',
    responseNoChoices: '上游响应缺少 choices',
    responseChoiceInvalid: '上游响应的 choices[0] 不是对象',
    upstreamError: '上游返回错误',
    /** Responses 请求里的会话状态类字段没有 Chat 等价物 */
    statelessFieldUnsupported:
      '字段 {{field}} 无法转换到 Chat Completions：该字段用于会话状态，转成无状态的 Chat 请求会静默丢语义',
    /** 上游返回的结构无法映射回 Responses */
    responseShapeUnsupported: '上游响应结构无法转换为 Responses 格式：{{detail}}',
    streamEventUnsupported: '上游流式事件无法转换：{{detail}}',
  },
  request: {
    /** `/v1/*` 请求体校验：没有 model 就无法选路 */
    modelRequired: '请求体必须包含 model 字段',
  },
  notImplemented: {
    /** `/v1/messages` 等没有转换器的组合 */
    protocolMismatch: '未开启协议转换：{{path}} 需要 {{required}} 上游，而供应商 {{name}} 是 {{apiType}}',
  },
};
