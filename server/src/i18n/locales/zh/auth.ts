/**
 * 认证与首次初始化文案。
 *
 * 这些报错会直接回给 API 调用方，并显示在登录/初始化/设置页面上，所以必须跟随请求语言。
 *
 * **安全约束**：本文件任何一条都不得回显口令、会话令牌或初始化令牌的明文。
 * 只描述"哪里不对"，绝不描述"期望值是什么"——否则报错本身就成了爆破/枚举的探针。
 */
export const zhAuth = {
  login: {
    missingCredentials: '用户名与口令不能为空',
    /** 统一文案：不区分"用户不存在"与"口令错误"，避免账号枚举 */
    invalidCredentials: '用户名或口令不正确',
    tenantDisabled: '租户已被停用',
  },
  password: {
    oldAndNewRequired: '旧口令与新口令都必须填写',
    newTooShort: '新口令至少 {{min}} 位',
    oldIncorrect: '旧口令不正确',
    /** 成功提示，设置页会原样显示给用户 */
    updated: '口令已更新，请重新登录',
  },
  permission: {
    /**
     * 令牌场景下不提"角色"：令牌没有角色语义，说"角色 member 缺少权限"
     * 会把排查方向引到角色配置上。
     */
    tokenMissing: '该 API 令牌缺少权限 {{permission}}',
    roleMissing: '角色 {{role}} 缺少权限 {{permission}}',
  },
  setup: {
    tokenRequired: '初始化令牌不能为空',
    usernameMustBeString: '用户名必须是字符串',
    passwordMustBeString: '口令必须是字符串',
    /** 幂等语义：已初始化就一律 409，绝不覆盖现有管理员 */
    alreadyCompleted: '已完成初始化，不能重复设置',
    /** 不回显令牌，也不透露控制台里的期望值 */
    invalidToken: '初始化令牌不正确',
    usernameTaken: '用户名 {{username}} 已存在',
    usernameMin: '用户名至少 {{min}} 个字符',
    usernameMax: '用户名最多 {{max}} 个字符',
    usernamePattern: '用户名只能包含字母、数字、点、下划线与连字符',
    passwordMin: '口令至少 {{min}} 位',
  },
  guard: {
    sessionRequired: '该接口需要登录会话，API 令牌不能调用',
    routeNotDeclared: '路由 {{method}} {{url}} 未在访问登记簿中声明',
  },
};
