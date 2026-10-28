/**
 * 模型聚合页：网关接入信息、默认模型、别名清单。
 *
 * 键名按页面区块分组，与 `ModelsPage.tsx` 里的卡片一一对应；
 * 标题复用 `app.nav.models`，这里只放副标题、区块文案与计数。
 *
 * 标识符不翻译：`lam-` 前缀、`/v1/...`、模型名、供应商名都按原样保留在文案里。
 */
export const zhModels = {
  header: {
    eyebrow: '网关',
    description:
      '所有启用供应商的模型被聚合为 lam-<供应商>/<模型> 别名；不带别名的请求走下面的默认模型。',
    /** 计数句：`_one` / `_other` 两份键中文文本一致 */
    aliasCount_one: '{{count}} 个可用别名',
    aliasCount_other: '{{count}} 个可用别名',
  },
  gateway: {
    title: '网关接入',
    desc: 'Agent 或任意 OpenAI / Anthropic 客户端指向这里。',
    baseUrl: '网关地址',
    token: '网关令牌',
    tokenMissing: '尚未生成令牌',
    resetToken: '重置令牌',
    generateToken: '生成令牌',
    resetConfirm: '重置后旧令牌立即失效，已下发的 Agent 配置需要重新应用。确定继续？',
    newTokenNotice: '这是唯一一次显示完整令牌，请立即复制：',
  },
  default: {
    title: '默认供应商与模型',
    desc: '用于承接不带 lam- 别名的请求。',
    noProviders: '还没有供应商，请先在「供应商」页添加。',
    providerLabel: '默认供应商',
    modelLabel: '默认模型',
    /** 下拉选项里追加在已停用供应商后面的后缀 */
    disabledSuffix: '（已停用）',
    modelPlaceholder: '选择供应商后填写',
    saved: '默认模型已保存',
  },
  aliases: {
    title: '聚合别名',
    desc: '只列出已启用供应商的模型，可直接复制给客户端使用。',
    count_one: '{{count}} 个',
    count_other: '{{count}} 个',
    empty: '暂无可用别名，请先启用供应商并声明模型。',
    table: {
      alias: '别名',
      provider: '供应商',
      apiType: '协议',
      upstreamModel: '上游模型',
      actions: '操作',
    },
  },
};
