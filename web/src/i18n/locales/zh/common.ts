/**
 * 通用文案：按钮、状态、兜底错误。
 *
 * 这一份被多个页面共用，改动会影响全站。区域专属文案请放进各自文件
 *（如 `providers.ts`），别都堆在这里——否则每个页面都会因为别人的文案改动而变脏。
 */
export const zhCommon = {
  /** 按钮与动作 */
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  delete: '删除',
  edit: '编辑',
  refresh: '刷新',
  copy: '复制',
  copied: '已复制',
  /** 状态与占位 */
  loading: '加载中…',
  notSet: '未设置',
  none: '（不设置）',
  /** 兜底错误（服务端没有返回 message 时） */
  loadFailed: '加载失败，请重试',
  requestFailed: '请求失败（HTTP {{status}}）',
  saveFailed: '保存失败',
  actionFailed: '操作失败',
  deleteFailed: '删除失败',
  sortFailed: '排序失败',
  testFailed: '测试失败',
  loginFailed: '登录失败',
  setupFailed: '初始化失败',
  updateFailed: '修改失败',
  createFailed: '创建失败',
  revokeFailed: '吊销失败',
  fetchModelsFailed: '获取模型列表失败',
};
