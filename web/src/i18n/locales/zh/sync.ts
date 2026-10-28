/**
 * 配置同步页的文案。
 *
 * 本文件是**中文原文**，英文对照在 `en/sync.ts`（用 `typeof zhSync` 约束，
 * 漏键/多键直接编译失败）。
 *
 * 三个约定：
 *
 * 1. **计数文案写 `_one` / `_other`**，调用 `t(key, { count })`。
 *    只写基名时英文 `count=1` 会输出 `1 items`。
 * 2. **插值用 `{{name}}`**，两份字典的占位符集合必须一致（`server/test/i18n.test.ts`
 *    会校验前端字典的这类契约靠 `web/test/i18n-dict.test.ts`）。
 * 3. **标识符不翻译**：`master` / `follower` / `sync:read` / `settings:write` /
 *    `/v1` / `api_` 这些要么是命令、要么是权限键，译者看不懂但用户要照抄。
 *    它们作为插值参数或原样保留在句子中。
 */
export const zhSync = {
  title: '配置同步',
  eyebrow: '多设备',
  description: '在一台机器上配好供应商与 Agent 设置，让其余设备跟随，省掉逐台重配。',
  loading: '正在读取同步状态…',

  /** 角色卡片 */
  role: {
    cardTitle: '角色',
    cardDesc: '决定本机在同步里的位置。默认「不参与同步」，行为与升级前一致。',
    standalone: '不参与同步',
    standaloneDesc: '各自独立配置。升级到本版本后的默认值，行为与以前完全一致。',
    master: '主设备（master）',
    masterDesc: '其他设备从这里拉取配置。会对外提供快照接口，其中含上游 API Key。',
    follower: '跟随设备（follower）',
    followerDesc: '主动从主设备拉取，并应用到本机。需要填 master 地址与 API 令牌。',
    switched: '已切换为「{{role}}」。',
    switchError: '操作失败',
    /** 切到 master 前的二次确认：它会开始对外提供含明文的快照 */
    masterConfirm:
      '切换到 master 后，本机会对外提供同步快照接口，其中包含上游 API Key 的明文（对端要用自己的密钥重新加密）。\n\n' +
      '请确认：\n' +
      '1. 已配置 HTTPS（或正在可信内网里使用 SYNC_ALLOW_INSECURE=1）；\n' +
      '2. 用于拉取的 API 令牌只授予 sync:read 权限。\n\n' +
      '确定切换吗？',
    followerNeedsUrl: '选择跟随设备前，请先填写 master 地址',
    masterWarning: '本机正对外提供快照接口。快照含上游 API Key 明文，务必只在 HTTPS',
    masterWarningTail:
      '（或显式允许的可信内网）下开放，并只把含 sync:read 的令牌交给 follower。',
  },

  /** 同步范围 */
  scope: {
    cardTitle: '同步范围',
    cardDesc: '只同步勾选的内容；未勾选的一律不动。留空表示什么都不做。',
    providers: '供应商与模型',
    settings: '网关设置',
    agentTargets: 'Agent 连接方式',
    neverSyncedTitle: '永远不会同步',
    neverSyncedTail: '。每台机器各自独立，否则一台被入侵等于全部沦陷。',
  },

  /** 连接（master 地址与令牌） */
  connection: {
    cardTitle: '连接',
    descFollower: '填写 master 地址与其 API 令牌后点「立即同步」。',
    descMaster: '本机是 master，由其他设备来拉取；这里只需确认可访问性。',
    masterUrlLabel: 'Master 地址',
    masterUrlPlaceholder: 'https://box.example.com:8787',
    saveUrl: '保存地址',
    savingUrl: '保存中…',
    urlSaved: '已保存 master 地址。',
    urlEmpty: 'master 地址不能为空',
    urlHint: '不带',
    urlHintTail: '，也不要带结尾斜杠。非回环地址必须是',
    urlHintTail2: '—— 快照里有上游 Key 明文。',
    tokenLabel: 'Master 的 API 令牌',
    tokenPlaceholder: 'api_…',
    tokenHint: '在 master 的「设置 → API 令牌」里创建，只需',
    tokenHintTail: '权限。令牌不会保存到本机，每次同步都要填，或由脚本直接调接口。',
    tokenRequired: '请填写 master 的 API 令牌（api_ 前缀，需含 sync:read 权限）',
    syncNow: '立即同步',
    syncing: '同步中…',
    refresh: '刷新状态',
    lastPull: '上次拉取',
    lastResult: '上次结果',
    neverPulled: '尚未同步过',
  },

  /** 冲突仲裁 */
  conflict: {
    cardTitle: '冲突仲裁',
    cardDesc: '同一条配置在本地与远端都被改过时，保留两个版本由你选择，不会静默覆盖。',
    pending_one: '{{count}} 条待处理',
    pending_other: '{{count}} 条待处理',
    banner_one:
      '有 {{count}} 条配置在本地与远端都被改过，尚未仲裁。在解决之前，这些项不会被再次覆盖。',
    banner_other:
      '有 {{count}} 条配置在本地与远端都被改过，尚未仲裁。在解决之前，这些项不会被再次覆盖。',
    loading: '正在读取冲突…',
    none: '没有待仲裁的冲突。同步时会自动合并本地未改动的项。',
    detectedAt: '检测于',
    changedFields: '差异字段：',
    localVersion: '本地版',
    remoteVersion: '远端版',
    updatedAt: '更新于',
    useLocal: '用本地',
    useRemote: '用远端',
    resolved: '已解决冲突「{{label}}」：采用{{choice}}版本。',
    choiceLocal: '本地',
    choiceRemote: '远端',
    readOnlyHint: '当前账号没有',
    readOnlyHintTail: '，只能查看同步状态与冲突，不能修改配置。',
  },

  /** 值渲染（把冲突里的 unknown 值变成人能读的一行） */
  value: {
    missing: '（不存在）',
    empty: '（空）',
    modelCount_one: '{{count}} 个模型',
    modelCount_other: '{{count}} 个模型',
    enabled: '已启用',
    disabled: '已停用',
    emptyScalar: '空',
    separator: ' · ',
    /** 设置对象的键值对分隔符 */
    pairSeparator: '，',
    keyValueSeparator: '=',
  },
};
