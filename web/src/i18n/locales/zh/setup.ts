/**
 * 首次初始化页。
 *
 * 含 `<code>data/setup.json</code>` 的那句用 `<Trans>`：路径本身不能翻译，
 * 拆成前后半句在英文里语序会别扭，交给内联标记处理更稳。
 */
export const zhSetup = {
  title: '设置管理员账号',
  description: '这是首次启动。请设置你自己的用户名与口令，完成后即可登录。',
  token: {
    label: '初始化令牌',
    /** 占位符是令牌前缀，属于标识符，不翻译 */
    placeholder: 'setup_…',
    hint: '首次启动时打印在服务端控制台。令牌只用于认领管理员账号，设置完成后立即失效。看不到？删除 <code>data/setup.json</code> 后重启服务会重新生成。',
  },
  username: {
    label: '用户名',
    /** 长度范围是服务端规则，展示时插值 */
    rules: '{{min}}–{{max}} 个字符，只用字母、数字、点、下划线与连字符。',
  },
  password: {
    label: '口令',
    tooShort_one: '口令至少 {{count}} 位',
    tooShort_other: '口令至少 {{count}} 位',
  },
  confirm: {
    label: '确认口令',
    mismatch: '两次输入的口令不一致',
  },
  submit: '创建管理员并登录',
  submitting: '正在创建…',
  securityNote: '口令只保存 scrypt 哈希，服务端无法还原明文；初始化令牌在完成后作废。',
  statusFailed: '无法读取初始化状态，请确认服务已启动',
};
