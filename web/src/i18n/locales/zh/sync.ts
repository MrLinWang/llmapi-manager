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
 * 2. **插值用 `{{name}}`**，两份字典的占位符集合必须一致（`web/test/i18n.test.tsx`
 *    会校验前端字典的这类契约）。
 * 3. **标识符不翻译**：`master` / `follower` / `peer` / `sync:read` / `sync:write` /
 *    `settings:write` / `SYNC_ALLOW_INSECURE` / `/v1` / `api_` 这些要么是命令、
 *    要么是权限键或环境变量，译者看不懂但用户要照抄。
 *    它们作为插值参数或原样保留在句子中。
 */
export const zhSync = {
  title: '配置同步',
  eyebrow: '多设备',
  description:
    '在两台设备之间复制配置，方向由角色决定：可以提供快照、可以拉取，也可以双向。手动点「立即同步」才生效。',
  loading: '正在读取同步状态…',

  /** 角色卡片 */
  role: {
    cardTitle: '角色',
    cardDesc:
      '决定本机在同步里的位置：提供快照、拉取，或两者都做。默认「不参与同步」，行为与升级前一致。',
    standalone: '不参与同步',
    standaloneDesc: '各自独立配置。升级到本版本后的默认值，行为与以前完全一致。',
    master: '主设备（master）',
    masterDesc: '只向其他设备提供快照，不主动拉取。会对外提供接口，其中含上游 API Key。',
    follower: '跟随设备（follower）',
    followerDesc: '只主动从对端拉取并应用到本机，不对外提供快照。需要填对端地址与 API 令牌。',
    peer: '双向对等（peer）',
    peerDesc: '同时向对端提供快照并从对端拉取。两端都要设为 peer，并各自持有对方含 sync:read 的令牌。',
    switched: '已切换为「{{role}}」。',
    switchError: '操作失败',
    readOnlyHint: '当前账号没有',
    readOnlyHintTail: '，只能查看同步状态，不能切换角色或修改同步范围。',
    /** 切到 master 前的二次确认：它会开始对外提供含明文的快照 */
    masterConfirm:
      '切换到 master 后，本机会对外提供同步快照接口，其中包含上游 API Key 的明文（对端要用自己的密钥重新加密）。\n\n' +
      '请确认：\n' +
      '1. 已配置 HTTPS（或正在可信内网里使用 SYNC_ALLOW_INSECURE=1）；\n' +
      '2. 用于拉取的 API 令牌只授予 sync:read 权限。\n\n' +
      '确定切换吗？',
    /** 切到 peer 前的二次确认：既导出也拉取，两台机器互相暴露 */
    peerConfirm:
      '切换到双向对等（peer）后，本机既会对外提供同步快照接口（含上游 API Key 明文），也会主动拉取对端。\n\n' +
      '请确认：\n' +
      '1. 两端都设为 peer，并分别填好对方的地址；\n' +
      '2. 两端都配置了 HTTPS（或可信内网里的 SYNC_ALLOW_INSECURE=1）；\n' +
      '3. 双方各自准备含 sync:read 的 API 令牌交给对方，本机账号还需要 sync:write 才能拉取。\n\n' +
      '确定切换吗？',
    followerNeedsUrl: '选择跟随设备前，请先填写对端地址',
    peerNeedsUrl: '选择双向对等前，请先填写对端地址',
    masterWarning: '本机正对外提供快照接口。快照含上游 API Key 明文，务必只在 HTTPS',
    masterWarningTail:
      '（或显式允许的可信内网）下开放，并只把含 sync:read 的令牌交给对端。',
    peerWarning: '本机正同时提供与拉取快照，两台机器都会对外暴露快照接口。快照含上游 API Key 明文，两端都必须只在 HTTPS',
    peerWarningTail:
      '（或显式允许的可信内网）下开放，并各自只把含 sync:read 的令牌交给对方。',
  },

  /** 同步范围 */
  scope: {
    cardTitle: '同步范围',
    cardDesc: '只同步勾选的内容；未勾选的一律不动。留空表示什么都不做。',
    providers: '供应商与模型',
    settings: '网关设置',
    agentTargets: 'Agent 连接方式',
    deletionNote: '删除不会传播：在一端删除的记录不会在另一端被删除，合并只覆盖两端都存在的项。',
    neverSyncedTitle: '永远不会同步',
    neverSyncedTail: '。每台机器各自独立，否则一台被入侵等于全部沦陷。',
  },

  /** 连接（对端地址与令牌） */
  connection: {
    cardTitle: '连接',
    descFollower: '填写对端地址与其 API 令牌后点「立即同步」。',
    descMaster: '本机是 master，只向其他设备提供快照、不主动拉取；这里说明对端要如何连过来。',
    descPeer: '本机既向对端提供快照，也从对端拉取。两端都要设为 peer，并各自持有对方含 sync:read 的令牌。',
    masterUrlLabel: '对端地址',
    masterUrlPlaceholder: 'https://box.example.com:8787',
    saveUrl: '保存地址',
    savingUrl: '保存中…',
    urlSaved: '已保存对端地址。',
    urlEmpty: '对端地址不能为空',
    urlHint: '不带',
    urlHintTail: '，也不要带结尾斜杠。非回环地址必须用',
    urlHintTail2:
      '—— 快照里有上游 Key 明文。可信内网里走明文 HTTP 时，两端都要显式设置 SYNC_ALLOW_INSECURE=1。',
    tokenLabel: '对端的 API 令牌',
    tokenPlaceholder: 'api_…',
    tokenHint: '在对端「设置 → API 令牌」里创建，只需',
    tokenHintTail: '权限。令牌不会保存到本机，每次同步都要填，或由脚本直接调接口。',
    tokenRequired: '请填写对端的 API 令牌（api_ 前缀，需含 sync:read 权限）',
    syncNow: '立即同步',
    syncing: '同步中…',
    refresh: '刷新状态',
    lastPull: '上次拉取',
    lastResult: '上次结果',
    neverPulled: '尚未同步过',
    /** master/peer 侧：本机在提供什么、对端需要什么权限 */
    serveTitle: '导出快照（供对端拉取）',
    serveDesc:
      '对端用含 sync:read 的令牌调用 GET /api/sync/snapshot。快照含上游 API Key 明文，只在 HTTPS 或显式允许的可信内网下开放。',
    serveMissingPermission:
      '当前账号没有 sync:read，无法导出快照。请让管理员用拥有 sync:read 的账号在「设置 → API 令牌」创建令牌交给对端，或授予当前账号该权限。',
    peerHintTitle: '双向对等（peer）要做的两件事',
    peerHint:
      '1. 两端都设为 peer 并互相填写对方地址；2. 两端各自创建一个含 sync:read 的令牌交给对方。任一端的地址、防火墙或令牌不对，该方向的拉取都会失败。',
    pullMissingPermission:
      '当前账号没有 sync:write，不能拉取或仲裁冲突。请让管理员在「设置 → API 令牌」授予该权限，或创建一个含 sync:write 的 API 令牌。',
    troubleshootTitle: '连接失败时按顺序检查：',
    troubleshoot:
      '1. 对端地址与端口是否正确、对端服务是否在运行；2. Windows 防火墙是否放行入站 TCP 8787（专用网络）；3. 内网明文 HTTP 是否在两台机器都设置了 SYNC_ALLOW_INSECURE=1；4. 对端令牌是否含 sync:read。',
  },

  /** 冲突仲裁 */
  conflict: {
    cardTitle: '冲突仲裁',
    cardDesc:
      '供应商、网关设置与 Agent 连接方式在本地与远端都被改过时，保留两个版本由你选择，不会静默覆盖。',
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
    readOnlyHintTail:
      '，只能查看同步状态与冲突，不能仲裁。请让管理员授予 sync:write。',
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
