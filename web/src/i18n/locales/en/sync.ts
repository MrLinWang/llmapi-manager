import type { zhSync } from '../zh/sync';

/**
 * 配置同步页的英文字典。
 *
 * 声明成 `typeof zhSync`：漏译、多键、占位符名字写错都会直接编译失败，
 * 不需要人工比对两份文件。
 *
 * 两处刻意保留原样：
 *
 * - `SYNC_ALLOW_INSECURE` / `sync:read` / `settings:write` / `/v1` / `api_` 是
 *   环境变量、权限键、路径与令牌前缀，用户要照抄，译了就没法用。
 * - `master` / `follower` 在产品语境里已经是固定术语，译成
 *   "primary/replica" 反而与接口字段 `role: 'master' | 'follower'` 对不上。
 */
export const enSync: typeof zhSync = {
  title: 'Config sync',
  eyebrow: 'Multi-device',
  description:
    'Set up providers and agent settings once, then let other devices follow — no re-entering config on each machine.',
  loading: 'Reading sync status…',

  role: {
    cardTitle: 'Role',
    cardDesc:
      'Determines this machine’s position in sync. The default is “not participating”, identical to the behaviour before this feature existed.',
    standalone: 'Not participating',
    standaloneDesc:
      'Configured independently. This is the default after upgrading, so behaviour is unchanged.',
    master: 'Master',
    masterDesc:
      'Other devices pull config from here. This machine serves a snapshot endpoint that contains upstream API keys.',
    follower: 'Follower',
    followerDesc:
      'Pulls from the master and applies it locally. Requires the master URL and an API token.',
    switched: 'Switched to “{{role}}”.',
    switchError: 'Operation failed',
    masterConfirm:
      'After switching to master, this machine will serve a sync snapshot endpoint containing upstream API keys in plaintext ' +
      '(the other side re-encrypts with its own key).\n\n' +
      'Please confirm:\n' +
      '1. HTTPS is configured (or you are on a trusted network with SYNC_ALLOW_INSECURE=1);\n' +
      '2. The token used for pulling is granted only the sync:read permission.\n\n' +
      'Switch now?',
    followerNeedsUrl: 'Fill in the master URL before selecting follower',
    masterWarning:
      'This machine is serving the snapshot endpoint. The snapshot contains upstream API keys in plaintext — expose it only over HTTPS',
    masterWarningTail:
      ' (or an explicitly allowed trusted network), and hand only a token with sync:read to followers.',
  },

  scope: {
    cardTitle: 'Sync scope',
    cardDesc:
      'Only checked items are synced; everything else is left untouched. Empty means nothing is synced.',
    providers: 'Providers and models',
    settings: 'Gateway settings',
    agentTargets: 'Agent connection mode',
    neverSyncedTitle: 'Never synced',
    neverSyncedTail:
      '. Each machine keeps its own copy — otherwise compromising one machine compromises them all.',
  },

  connection: {
    cardTitle: 'Connection',
    descFollower: 'Enter the master URL and its API token, then click “Sync now”.',
    descMaster:
      'This machine is the master; other devices pull from it. You only need to verify reachability here.',
    masterUrlLabel: 'Master URL',
    masterUrlPlaceholder: 'https://box.example.com:8787',
    saveUrl: 'Save URL',
    savingUrl: 'Saving…',
    urlSaved: 'Master URL saved.',
    urlEmpty: 'Master URL must not be empty',
    urlHint: 'Omit',
    urlHintTail: ', and no trailing slash. A non-loopback address must use',
    urlHintTail2: ' — the snapshot contains upstream keys in plaintext.',
    tokenLabel: "Master's API token",
    tokenPlaceholder: 'api_…',
    tokenHint: 'Create it under “Settings → API tokens” on the master with only the',
    tokenHintTail:
      ' permission. The token is not stored locally — enter it on each sync, or call the API from a script.',
    tokenRequired: 'Enter the master’s API token (api_ prefix, requires sync:read)',
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    refresh: 'Refresh status',
    lastPull: 'Last pull',
    lastResult: 'Last result',
    neverPulled: 'Never synced',
  },

  conflict: {
    cardTitle: 'Conflict arbitration',
    cardDesc:
      'When an item was changed on both sides, both versions are kept and you choose — nothing is overwritten silently.',
    pending_one: '{{count}} pending',
    pending_other: '{{count}} pending',
    banner_one:
      '{{count}} item was changed on both sides and has not been arbitrated. Until it is resolved, these items will not be overwritten again.',
    banner_other:
      '{{count}} items were changed on both sides and have not been arbitrated. Until they are resolved, these items will not be overwritten again.',
    loading: 'Reading conflicts…',
    none: 'No conflicts to arbitrate. Unchanged local items are merged automatically during sync.',
    detectedAt: 'Detected',
    changedFields: 'Changed fields:',
    localVersion: 'Local version',
    remoteVersion: 'Remote version',
    updatedAt: 'Updated',
    useLocal: 'Use local',
    useRemote: 'Use remote',
    resolved: 'Resolved “{{label}}”: kept the {{choice}} version.',
    choiceLocal: 'local',
    choiceRemote: 'remote',
    readOnlyHint: 'This account lacks',
    readOnlyHintTail:
      ', so it can view sync status and conflicts but cannot change config.',
  },

  value: {
    missing: '(absent)',
    empty: '(empty)',
    modelCount_one: '{{count}} model',
    modelCount_other: '{{count}} models',
    enabled: 'enabled',
    disabled: 'disabled',
    emptyScalar: 'empty',
    separator: ' · ',
    pairSeparator: ', ',
    keyValueSeparator: '=',
  },
};
