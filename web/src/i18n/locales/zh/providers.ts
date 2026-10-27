/**
 * 供应商列表页（ProvidersPage）。
 *
 * 只放「列表面板」自己的文案：页面标题复用 `app.nav.providers`（与侧边栏同名），
 * 编辑/删除/排序失败的兜底句复用 `common.*`，都不在这里重复定义。
 */
export const zhProviders = {
  header: {
    eyebrow: '配置中心',
    description:
      '维护各家 LLM API。启用的供应商会参与聚合别名与网关选路，优先级越小越先被选中。',
  },
  /** 表格行内与页面头部的按钮/动作名 */
  actions: {
    create: '新增供应商',
    test: '测试',
    moveUp: '提高优先级',
    moveDown: '降低优先级',
    enable: '启用',
    disable: '停用',
  },
  /** 供应商自身状态（徽标） */
  status: {
    enabled: '启用',
    disabled: '停用',
  },
  /** 连通性测试结果；ProviderForm 的 TestResultLine 复用同一对键 */
  test: {
    ok: '连通',
    fail: '失败',
  },
  removeConfirm: '确定删除供应商「{{name}}」？该操作不可撤销。',
  list: {
    title: '供应商列表',
    desc: '按优先级排序，数值越小越优先参与网关选路。',
    count_one: '{{count}} 个',
    count_other: '{{count}} 个',
    empty: '还没有供应商。先添加一个，再去「模型聚合」生成网关令牌。',
  },
  table: {
    name: '名称 / 别名前缀',
    apiType: '协议',
    /** 标识符，两种语言都保持原样 */
    baseUrl: 'Base URL',
    models: '模型',
    key: 'Key',
    lastTest: '最近测试',
    actions: '操作',
  },
};
