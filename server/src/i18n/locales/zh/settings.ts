/**
 * 租户级设置与 Agent 下发偏好文案。
 *
 * 覆盖 `/api/settings/default`、`/api/settings/codex` 与 `/api/agents/:id/target`
 * 的校验错误，以及网关令牌重置响应里的提示。
 *
 * 字段名（`codexStreamMaxRetries`、`directProviderId`…）与 Agent id、协议机器值
 * （`openai` / `anthropic` / `responses`）一律不翻译：调用方要靠它们对着接口文档
 * 与日志排查，翻译后反而对不上。
 */
export const zhSettings = {
  validation: {
    /** `parseBoundedInteger` 的三条严格性：不接受字符串、必须是整数、越界直接报错 */
    numberOrNull: '{{field}} 必须是数字或 null',
    integer: '{{field}} 必须是整数',
    integerRange: '{{field}} 必须是 {{min}}–{{max}} 的整数',
    /**
     * 带说明的越界文案：Codex 对超过上限的值是静默截断，
     * 放过去用户会以为设置生效了，所以要在文案里说清为什么直接拒绝。
     */
    integerRangeCodexTruncate:
      '{{field}} 必须是 {{min}}–{{max}} 的整数（Codex 对超过上限的值会静默截断，所以在这里直接拒绝）',
    boolean: '{{field}} 必须是布尔值',
    stringOrNull: '{{field}} 必须是字符串或 null',
  },
  default: {
    modelNotInProvider: '模型 {{model}} 不在供应商 {{name}} 的模型列表中',
  },
  agentTarget: {
    unknown: '未知 Agent: {{id}}',
    modeInvalid: 'mode 只能是 {{modes}}',
    providerDisabled: '供应商「{{name}}」已被停用，不能用于直连',
    /**
     * 协议不匹配时必须在保存阶段就拒绝：直连会把这家供应商的地址与真实 Key
     * 写进用户家目录，配错协议的结果不是 501，而是"永远打不通"。
     */
    apiTypeMismatch: '供应商「{{name}}」的协议类型不适用于 {{agent}}，需要 {{needed}}',
  },
  language: {
    /**
     * 字段缺失与显式 `null` 是两回事：后者是用户选择"跟随浏览器"，
     * 前者多半是调用方字段名写错。文案要把这个区别说出来。
     */
    fieldRequired: 'language 字段必须提供（可为 null 表示跟随浏览器）',
    invalid: 'language 必须是 {{supported}}，或 null',
  },
};
