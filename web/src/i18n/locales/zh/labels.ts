/**
 * 枚举类文案：协议、角色、权限名。
 *
 * 这些值除了出现在界面上，还会作为机器标识在接口/存储里流通，因此**键名与标识符
 * 分开**：`apiTypes.openai.label` 是文案，`openai` 本身永远不翻译。
 */
export const zhLabels = {
  apiTypes: {
    openai: { label: 'OpenAI 兼容（Chat Completions）', short: 'Chat' },
    responses: { label: 'OpenAI 兼容（Responses）', short: 'Responses' },
    anthropic: { label: 'Anthropic 兼容（Messages）', short: 'Messages' },
  },
  roles: {
    owner: '所有者',
    admin: '管理员',
    member: '成员',
  },
  /**
   * 权限说明。
   *
   * 界面上一律显示 `权限名 + 说明`：只给 `providers:write` 这类标识符，
   * 用户无法判断勾选后到底能干什么，而这里勾错是要授权出去的。
   *
   * 键名里不能带 `:`（i18next 的命名空间分隔符），所以用下划线形式，
   * 与 `Permission` 的映射关系集中在 `web/src/lib/labels.ts` 的 `PERMISSION_KEYS`。
   */
  permissions: {
    providersRead: '读取供应商',
    providersWrite: '增删改供应商',
    gatewayRead: '读取网关地址与令牌状态',
    gatewayWrite: '重置网关令牌',
    agentsRead: '读取 Agent 配置',
    agentsApply: '下发与还原 Agent 配置',
    logsRead: '读取请求日志与统计',
    settingsRead: '读取设置',
    settingsWrite: '修改设置',
    usersManage: '管理用户',
    tenantsManage: '管理租户',
  },
};
