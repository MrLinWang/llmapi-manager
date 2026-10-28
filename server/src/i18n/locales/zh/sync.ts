/**
 * 配置同步的接口文案。
 *
 * 覆盖 `/api/sync/*` 的校验错误与角色/状态相关的拒绝原因。
 *
 * **安全约束**：任何一条都不得回显上游 API Key、网关令牌明文或快照内容。
 * 需要标识某个项时只用 `targetLabel` / `id` / `scope` 这类非机密字段。
 *
 * 这一区域是合并 `main` 的 i18n 之后补的：原先 `routes/sync.ts` 直接传中文
 * 成品文案给 `badRequest()`，在英文界面下会原样输出中文。`MessageKey` 是
 * `string`，类型检查抓不到，只能靠约定与这套字典。
 */
export const zhSync = {
  scopes: {
    mustBeArray: 'scopes 必须是数组',
    /** `{{value}}` 是用户传进来的原始值，`{{available}}` 是可选范围 */
    unknown: '未知的同步范围 {{value}}；可选：{{available}}',
    /** 空 scopes 表示"什么都不同步"（安全默认），不能当成"全部同步" */
    emptyForExport:
      '未选择任何同步范围。请在「同步范围」里勾选要同步的内容（空白表示不同步任何数据）。',
    emptyForPull:
      '未选择任何同步范围。请先在「同步范围」里勾选要同步的内容（空白表示不同步任何数据）。',
  },
  masterUrl: {
    invalid: 'master 地址不合法：{{value}}',
    mustBeHttp: 'master 地址必须用 http 或 https：{{value}}',
    /** follower 必须有地址：分两次提交会在中间态被 400 挡回来 */
    requiredForFollower: '选择 follower 角色时必须填写 master 地址',
    mustBeStringOrNull: 'masterUrl 必须是字符串或 null',
    /** follower 侧明文 HTTP：会把 master 令牌与上游 Key 送出去 */
    insecure:
      'master 地址是明文 HTTP（{{value}}），拉取时会暴露 API 令牌与上游 Key。请改用 https，或（仅在可信内网）设置 SYNC_ALLOW_INSECURE=1。',
  },
  role: {
    unknown: 'role 必须是 {{available}} 之一',
    /** 导出快照要求本机是 master：follower 上没有"权威版本"可给 */
    mustBeMasterToExport: '当前不是 master 角色，没有可导出的快照',
    mustBeFollowerToPull: '只有 follower 角色才能拉取',
    mustBeMasterToServe: '当前不是 master 角色，无法提供快照',
  },
  pull: {
    noMasterUrl: '尚未配置 master 地址',
    /** 提示令牌来源与所需权限，但不回显令牌本身 */
    tokenRequired: '需要 master 的 API 令牌（api_ 前缀，且包含 sync:read 权限）',
    timeout: '拉取超时（30 秒），检查 master 地址与网络连通性',
    failed: '拉取失败：{{reason}}',
    /** master 返回的 HTTP 状态非 2xx */
    badStatus: 'master 返回 {{status}}：{{reason}}',
    /** 响应不是预期的快照结构 */
    badPayload: 'master 返回的不是合法快照：{{reason}}',
  },
  conflict: {
    choiceInvalid: 'choice 必须是 local 或 remote',
    unknown: '未知冲突：{{id}}',
    /** 冲突已被处理过（并发仲裁） */
    alreadyResolved: '这条冲突已经处理过，请刷新后重试',
    /** 冲突里的值无法解码（换了 DATA_ENCRYPTION_KEY） */
    undecodable: '冲突内容无法解码，可能是本机的数据密钥变了。原因：{{reason}}',
  },
  snapshot: {
    /** 导出侧的链路检查：快照含全部上游 Key 明文 */
    mustUseHttps:
      '同步快照包含上游 API Key 明文，必须走 HTTPS。请在前面部署反向代理并设置 TRUST_PROXY=1（反代需覆盖 X-Forwarded-Proto），或（仅在可信内网，例如 EasyTier 隧道内）设置 SYNC_ALLOW_INSECURE=1。',
    /** 快照里的记录结构不对 */
    malformed: '快照结构不合法：{{reason}}',
    /** schemaVersion 比自己新 */
    futureSchema: '快照的 schemaVersion（{{remote}}）比本机（{{local}}）新，拒绝应用',
  },
  /** 拉取成功的摘要（进 `lastPullResult`，会显示在界面上） */
  summary: {
    applied: '已应用 {{count}} 项',
    conflicts: '产生 {{count}} 条冲突待仲裁',
    unchanged: '没有变化',
    /** 拼在摘要尾部，例如「已应用 3 项，产生 1 条冲突待仲裁（120ms）」 */
    elapsed: '（{{ms}}ms）',
    /** master 的实例标识变了：可能换了机器，值得提醒核对配置 */
    masterChanged: '注意：master 的实例标识变了，可能换了一台机器，建议核对配置',
  },
};
