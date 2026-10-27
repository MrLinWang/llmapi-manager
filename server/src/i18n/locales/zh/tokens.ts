/**
 * API 管理令牌文案。
 *
 * 覆盖 `/api/tokens` 的校验错误，以及网关令牌（`lam_`）生成响应里的提示语。
 *
 * **安全约束**：任何一条都不得回显令牌明文、`tokenHash` 或 `tokenCipher`。
 * 需要标识某个令牌时只用 `id` / `name` / `prefix` 这类非机密字段；
 * 完整令牌只在生成/重置的那一次响应里以独立字段 `token` 返回，绝不拼进文案。
 */
export const zhTokens = {
  scopes: {
    mustBeArray: 'scopes 必须是权限名数组',
    unknown: '未知权限 {{scope}}；可选值：{{available}}',
    /**
     * `users:manage` / `tenants:manage` 当前没有任何接口使用，
     * 授予令牌只增加风险面，所以一律拒绝。
     */
    ungrantable: '权限 {{permission}} 不能授予 API 令牌',
    /** 只收窄、不提权：否则只读用户能靠创建令牌绕过自身限制 */
    cannotGrantSelf: '你不能授予自己没有的权限 {{permission}}',
    empty: 'scopes 不能为空，否则令牌无法调用任何接口',
  },
  name: {
    required: 'name 不能为空，它用于在列表里区分多个令牌',
    tooLong: 'name 不能超过 {{max}} 个字符',
  },
  expiresAt: {
    mustBeString: 'expiresAt 必须是 ISO 时间字符串或 null',
    invalid: 'expiresAt 不是合法时间：{{value}}',
    mustBeFuture: 'expiresAt 必须晚于当前时间',
  },
  /** 令牌不能创建/吊销令牌：否则一个即将被吊销的令牌可以先给自己留后门 */
  sessionRequired: {
    create: 'API 令牌不能创建新令牌，请用登录会话操作',
    revoke: 'API 令牌不能吊销令牌，请用登录会话操作',
  },
  /** 未知 id 只回显 id 本身（调用方自己传的），不回显任何令牌内容 */
  notFound: '未知令牌：{{id}}',
  gateway: {
    /** 网关令牌（lam_）生成响应里的提示：明文只出现这一次 */
    resetNotice: '这是唯一一次显示完整令牌，请立即复制并更新已下发的 Agent 配置。',
  },
};
