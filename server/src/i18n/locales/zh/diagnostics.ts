/**
 * 诊断接口文案。
 *
 * 诊断输出是"解释为什么"给人读的：为什么选这家、为什么不是那家、哪一层断了。
 * 因此它比错误消息更长、也最需要本地化。标识符（路径、别名、apiType 机器值、
 * 模型名）一律不翻译。
 */
export const zhDiagnostics = {
  disabled: '诊断接口未启用，请设置 ENABLE_DIAGNOSTICS=1 后重启',
  pathNotString: 'path 必须是字符串',
  pathNotSupported: 'path 必须是 {{paths}} 之一',
  modelEmpty: 'model 不能为空',
  bodyNotObject: 'body 必须是 JSON 对象',
  selectionFailed: '选路失败：{{reason}}',

  route: {
    /** 只有 openai 供应商时的引导：说清"开哪个开关能解决" */
    conversionHint:
      '若你只有 openai（Chat）供应商，开启 protocolConversion 可让网关把 Responses 转成 Chat',
    /** 真实网关会在发请求前再校验一次协议，诊断必须复现这个结论 */
    wouldReject: '真实网关会返回 501：路径需要 {{required}}，主供应商是 {{apiType}}',
  },

  chain: {
    convertFailed: '转换失败（内部错误）',
    convertFailedSummary: '请求转换失败，真实请求会返回 400',
    convertSkipped: '不需要转换（路径需要 {{required}}，供应商是 {{apiType}}）',
    convertNotTriggered: '未触发',
    upstreamFailed: '上游请求失败',
    upstreamFailedSummary: '上游不可达，真实请求会返回 502',
    upstreamEmptySummary: '上游返回空响应',
    /**
     * 流式响应不解析的原因：Codex 永远发 stream:true，而 SSE 不是 JSON，
     * 硬解析会在功能正常时误报失败。
     */
    streamSkipped:
      '请求是流式（stream:true），上游返回 SSE。本接口不解析流式，否则会把"功能正常"误报成 JSON 解析失败。要验证转换映射请传 stream:false 的 body。',
    responseConvertFailed: '响应转换失败',
    responseConvertHint: '上游可能并不兼容 Chat Completions，检查供应商的 apiType 是否选错',
    allOkSummary: '全链路正常：真实请求会按上述路径转发',
    partialFailSummary: '链路中有步骤失败，见 steps 里的 error',
  },

  converter: {
    note: '这些是纯函数层面的映射检查，不涉及网络与设置',
    textName: '文本：input 字符串 → messages',
    textFailName: '文本',
    toolsName: '工具定义：扁平 → 嵌套',
    toolsFailName: '工具定义',
    customName: 'custom 工具 → 单参 function',
    customFailName: 'custom 工具',
    statefulName: '有状态特性应拒绝（previous_response_id）',
    /** 该拒绝却静默继续，是比报错更糟的情况 */
    statefulNotRejected: '没有报错——转换有损却静默继续，会让 Codex 拿到错误上下文',
    responseName: '响应：choices → output[]',
    responseFailName: '响应转换',
  },

  check: {
    codexProtocolName: 'Codex 有可用的上游协议',
    codexProtocolOk: 'responses {{responses}} 家',
    codexProtocolOkWithConversion: 'responses {{responses}} 家，openai {{openai}} 家（走转换）',
    codexProtocolFail: '既没有启用的 responses 供应商，也没开跨协议转发',
    codexProtocolFix: '添加 responses 供应商，或开启 protocolConversion',

    catalogName: 'Codex 目录里没有用不了的协议',
    catalogMissing: '还没 apply 过，目录文件不存在（Codex 会回退到内置官方模型列表）',
    catalogAllUsable: '目录 {{count}} 个条目，协议均可用',
    catalogUnusable: '目录里有 {{count}} 个当前用不了的条目：{{names}}',
    catalogFix:
      '重新 apply 一次 Codex 配置；若目录里有 openai 别名又想用，需开启 protocolConversion',

    approvalDirectName: '审批模型映射在直连模式下不会生效',
    approvalDirectDetail: 'Codex 处于直连模式，请求不经过网关，approvalReviewModel 无从生效',
    approvalDirectFix: '切回网关模式，或清空 approvalReviewModel',
    approvalOkName: '审批模型映射的生效条件',
    approvalConfigured: '已配置 {{model}}，网关模式下生效',
    approvalNotConfigured: '未配置（Codex 会用硬编码的占位名）',

    aliasName: '别名都指向现存供应商',
    aliasOk: '{{count}} 个别名均有效',
    aliasStale: '{{count}} 个别名指向已删除的供应商',
  },
};
