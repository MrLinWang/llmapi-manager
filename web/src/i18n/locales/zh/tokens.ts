/**
 * API 令牌卡片（`web/src/components/ApiTokensCard.tsx`）。
 *
 * 两套令牌的区别必须在界面上说清（`lam_` 网关令牌 vs `api_` 管理令牌），
 * 否则用户会拿错去调 `/v1` 或 `/api`。标识符（`lam_`、`Authorization: Bearer`）
 * 一律不翻译。
 */
export const zhTokens = {
  title: 'API 令牌',
  desc: '让脚本或 CI 调用本服务的管理接口。与网关令牌（lam_）是两套，别混用。',
  revealed: {
    /** `<strong>` 只强调"看不到第二次"，属于排版而非标识符，交给 `<Trans>` */
    title: '令牌已创建，<strong>关闭后无法再次查看</strong>',
    saved: '我已保存',
    /** 下面两条拼成「调用方式：Authorization: Bearer <令牌>」 */
    usage: '调用方式：',
    authorizationHeader: 'Authorization: Bearer <令牌>',
  },
  name: {
    label: '用途名称',
    placeholder: '例如：CI 部署脚本',
    required: '请填写用途名称',
  },
  expires: {
    label: '过期时间（留空不过期）',
  },
  scopes: {
    label: '权限',
    required: '至少勾选一个权限',
    hint: '只能授予自己拥有的权限——令牌是收窄授权，不能用来提权。',
    /** 令牌列表里多个权限之间的分隔符，中文用顿号、英文用逗号 */
    separator: '、',
  },
  submit: '创建令牌',
  submitting: '处理中…',
  empty: '还没有创建任何令牌。',
  status: {
    revoked: '已吊销',
    expired: '已过期',
    active: '有效',
  },
  lastUsed: '最后使用 {{time}}',
  neverUsed: '从未使用',
  revoke: '吊销',
  revokeConfirm: '吊销令牌「{{name}}」？使用它的脚本会立刻失效。',
  revokeDone: '已吊销「{{name}}」',
};
