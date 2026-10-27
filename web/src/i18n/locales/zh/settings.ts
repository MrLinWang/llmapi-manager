/**
 * 设置页：当前账号、界面语言、修改口令与版本边界说明。
 *
 * 页面标题复用 `app.nav.settings`（与侧边栏同一份文案），这里只放页面内的区域文案。
 * 「无权限时只读」与「保存失败提示」复用 `app.language.readOnly` /
 * `app.language.saveFailed`：侧边栏语言选择器表达的是同一件事，两处各写一份
 * 迟早会出现两种说法。
 */
export const zhSettings = {
  header: {
    eyebrow: '账号',
    description: '查看当前登录身份与权限，或更新登录口令。',
  },
  account: {
    title: '当前账号',
    desc: '登录身份、租户与权限范围。',
    username: '用户名',
    tenant: '租户',
    role: '角色',
    permissionCount: '权限数',
    grantedPermissions: '已授予权限',
  },
  language: {
    title: '界面语言',
    /**
     * 说明文字必须写清两条真实边界：偏好是租户级的（会影响别人）、服务端错误消息
     * 仍是中文。否则用户会以为"切成 English 之后所有报错也该是英文"。
     */
    desc: '语言偏好保存在服务端，对本租户的所有用户生效。服务端返回的错误文案目前仍是中文，不随界面语言切换。',
    saved: '界面语言已保存',
  },
  password: {
    title: '修改口令',
    desc: '修改后所有已登录会话立即失效，需要重新登录。',
    current: '当前口令',
    next: '新口令（至少 8 位）',
    confirm: '确认新口令',
    mismatch: '两次输入的新口令不一致',
    submit: '更新口令',
    submitting: '提交中…',
  },
  tenancy: {
    title: '多用户与租户',
    desc: '当前版本的边界与后续扩展方式。',
    body: '当前版本为单人使用：一个租户、一个 owner 账号。数据已按租户分区保存，权限按角色集中裁决，新增用户或租户时无需改动领域模型与接口契约。',
  },
};
