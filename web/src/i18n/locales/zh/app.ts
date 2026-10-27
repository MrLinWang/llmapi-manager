/**
 * 应用外壳：品牌、导航、页脚、语言选择。
 *
 * 页面标题/面包屑与侧边栏共用同一组 `nav.*` 键——两处各写一份的话，
 * 改导航名会出现"侧边栏叫 Agent 配置、面包屑叫 Agent"这种不一致。
 */
export const zhApp = {
  brand: 'LLM API Manager',
  tagline: '自托管网关控制台',
  footer: 'LLM API Manager · 自托管 LLM API 控制台',
  nav: {
    groupConsole: '控制台',
    groupConfig: '配置',
    overview: '概览',
    providers: '供应商',
    models: '模型聚合',
    agents: 'Agent 配置',
    settings: '设置',
  },
  /** 未登录时的占位用户名 */
  notLoggedIn: '未登录',
  logout: '退出登录',
  openMenu: '打开菜单',
  closeMenu: '关闭菜单',
  /** 全局加载提示 */
  preparing: '正在准备…',
  checkingSession: '正在校验登录状态…',
  /** 顶栏健康状态 */
  serviceOk: '服务正常',
  startupWarnings_one: '{{count}} 条启动告警',
  startupWarnings_other: '{{count}} 条启动告警',
  /** 语言选择器 */
  language: {
    label: '界面语言',
    auto: '跟随浏览器',
    /** 落盘失败：界面语言已乐观切换，失败时必须回滚，提示要说明这一点 */
    saveFailed: '界面语言保存失败，已恢复原设置',
    /** 无 settings:write 时下拉框禁用，用 title 说明为什么不能点 */
    readOnly: '需要修改设置的权限才能切换语言',
  },
  /** 登录/初始化页脚 */
  selfHostedNote: '自托管 · 单进程 · 数据留在本机',
};
