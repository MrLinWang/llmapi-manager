/**
 * 供应商表单（ProviderForm）。
 *
 * 页面级文案放这里；按钮与兜底错误复用 `common.*`，连通状态复用
 * `providers.test.*`（列表页与表单里的测试结果徽标用的是同一对词，不该各写一份）。
 *
 * 协议选项名来自 `labels.apiTypes.*`（`API_TYPE_META.labelKey`），不在这里重复。
 */
export const zhProviderForm = {
  header: {
    titleEdit: '编辑供应商',
    titleCreate: '新增供应商',
    desc: '保存后立即参与模型聚合与网关选路。',
    close: '关闭表单',
  },
  sections: {
    basic: '基本信息',
    connection: '连接信息',
    models: '模型与备注',
    efforts: '思考档位',
  },
  basic: {
    name: '名称',
    namePlaceholder: '例如 PackyCode',
    /** 别名前缀：`lam-` 与 providerKey 都是标识符，只翻译前缀说明 */
    aliasPrefix: '别名前缀：lam-{{key}}/',
    apiType: '协议类型',
    /**
     * 协议说明拆成前后两段：中间夹着 `selectedMeta.path`（协议路径，不翻译）。
     * 用 `<Trans>` 也能做，但路径是动态值、还要包 `<code>`，拆句更直观。
     */
    protocolHintPrefix: '该协议走',
    protocolHintSuffix:
      '；与上游真实支持的接口必须一致，不匹配时网关默认返回 501。例外：Codex 只会发 Responses 请求，开启「跨协议转发」后网关会把 Responses 转成 Chat 发给「Chat Completions」供应商。',
  },
  connection: {
    baseUrl: 'Base URL',
    baseUrlHint: '不带 /v1 也可以，服务端会自动补全。若已包含 /v1 则原样使用。',
    apiKey: 'API Key',
    apiKeyKeep: '（留空则不修改）',
    apiKeyHint: '凭据加密落盘，接口只返回首 3 位与尾 4 位的脱敏结果。',
  },
  models: {
    label: '模型列表',
    fetch: '从上游获取模型',
    fetching: '获取中…',
    fetchTitleEmpty: '先填写 Base URL',
    fetchTitle: '用当前填写的协议与地址向上游查询可用模型',
    placeholder: '输入模型名后回车，如 gpt-5.1',
    /** 标签片段上的移除按钮（aria-label） */
    remove: '移除模型 {{model}}',
    hint: '回车或逗号添加，点片段上的 × 移除；也可直接粘贴多个（逗号或换行分隔）。',
    emptyList: '上游返回了空列表，请确认该供应商是否开放了模型列表接口。',
    fetchFailed: '未能获取模型列表',
    /** 计数句子用复数键：中文两份文本相同，英文单复数不同 */
    fetched_one: '上游返回 {{count}} 个模型（{{latencyMs}}ms），勾选后确认。',
    fetched_other: '上游返回 {{count}} 个模型（{{latencyMs}}ms），勾选后确认。',
    withCapabilities_one: '其中 {{count}} 个带上下文窗口信息，会随供应商一起保存。',
    withCapabilities_other: '其中 {{count}} 个带上下文窗口信息，会随供应商一起保存。',
    candidatesHint: '点选要启用的模型（再点一次取消），已添加的以强调色显示。',
    selectAll: '全选',
    clearSelection: '清空选择',
    collapse: '收起',
    website: '官网（可选）',
    notes: '备注（可选）',
    requireOne: '至少填写一个模型名',
    imageLabel: '生图模型（可选）',
    imagePlaceholder: '输入生图模型名后回车，如 gpt-image-2',
    imageRemove: '移除生图模型 {{model}}',
    imageFetchTitle: '用当前填写的协议与地址向上游查询可用模型，只列出只输出图像的模型',
    imageEmptyList: '上游没有返回只输出图像的模型（或没声明输出模态），可以直接手填。',
    imageHint:
      '生图模型只服务 /v1/images/*（Codex 的内置生图工具走这里），不会发布别名、也不会出现在 Codex 的 /model 列表里。两边都填同一个名字时按生图处理。',
  },
};
