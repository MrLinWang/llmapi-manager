import type { zhSync } from '../zh/sync';

/**
 * 配置同步页的英文字典。
 *
 * 声明成 `typeof zhSync`：漏译、多键、占位符名字写错都会直接编译失败，
 * 不需要人工比对两份文件。
 *
 * 两处刻意保留原样：
 *
 * - `SYNC_ALLOW_INSECURE` / `sync:read` / `sync:write` / `settings:write` /
 *   `/v1` / `api_` 是环境变量、权限键、路径与令牌前缀，用户要照抄，译了就没法用。
 * - `master` / `follower` / `peer` 在产品语境里已经是固定术语，译成
 *   "primary/replica" 反而与接口字段 `role: 'master' | 'follower' | 'peer'` 对不上。
 */
export const enSync: typeof zhSync = {
  title: 'Config sync',
  eyebrow: 'Multi-device',
  description:
    'Copy config between two devices. The role decides the direction: serve snapshots, pull, or both. Nothing happens until you click “Sync now”.',
  loading: 'Reading sync status…',

  role: {
    cardTitle: 'Role',
    cardDesc:
      'Determines this machine’s position in sync: serve snapshots, pull, or both. The default is “not participating”, identical to the behaviour before this feature existed.',
    standalone: 'Not participating',
    standaloneDesc:
      'Configured independently. This is the default after upgrading, so behaviour is unchanged.',
    master: 'Master',
    masterDesc:
      'Serves snapshots to other devices and never pulls. This machine exposes an endpoint that contains upstream API keys.',
    follower: 'Follower',
    followerDesc:
      'Pulls from a peer and applies it locally; it does not serve snapshots. Requires the peer URL and an API token.',
    peer: 'Peer (bidirectional)',
    peerDesc:
      'Serves snapshots to the peer and pulls from it at the same time. Both sides must be peer, each holding a token with sync:read for the other.',
    switched: 'Switched to “{{role}}”.',
    switchError: 'Operation failed',
    readOnlyHint: 'This account lacks',
    readOnlyHintTail:
      ', so it can view sync status but cannot switch roles or change sync scope.',
    masterConfirm:
      'After switching to master, this machine will serve a sync snapshot endpoint containing upstream API keys in plaintext ' +
      '(the other side re-encrypts with its own key).\n\n' +
      'Please confirm:\n' +
      '1. HTTPS is configured (or you are on a trusted network with SYNC_ALLOW_INSECURE=1);\n' +
      '2. The token used for pulling is granted only the sync:read permission.\n\n' +
      'Switch now?',
    peerConfirm:
      'After switching to peer (bidirectional), this machine will both serve a sync snapshot endpoint (containing upstream API keys in plaintext) ' +
      'and pull from the peer.\n\n' +
      'Please confirm:\n' +
      '1. Both sides are set to peer and each has the other’s URL;\n' +
      '2. Both sides have HTTPS configured (or use SYNC_ALLOW_INSECURE=1 on a trusted network);\n' +
      '3. Each side gives the other a token with sync:read, and this account also needs sync:write to pull.\n\n' +
      'Switch now?',
    followerNeedsUrl: 'Fill in the peer URL before selecting follower',
    peerNeedsUrl: 'Fill in the peer URL before selecting peer',
    masterWarning:
      'This machine is serving the snapshot endpoint. The snapshot contains upstream API keys in plaintext — expose it only over HTTPS',
    masterWarningTail:
      ' (or an explicitly allowed trusted network), and hand only a token with sync:read to the other side.',
    peerWarning:
      'This machine both serves and pulls snapshots, so both machines expose the endpoint. The snapshot contains upstream API keys in plaintext — both sides must expose it only over HTTPS',
    peerWarningTail:
      ' (or an explicitly allowed trusted network), and each must hand only a token with sync:read to the other.',
  },

  scope: {
    cardTitle: 'Sync scope',
    cardDesc:
      'Only checked items are synced; everything else is left untouched. Empty means nothing is synced.',
    providers: 'Providers and models',
    settings: 'Gateway settings',
    agentTargets: 'Agent connection mode',
    deletionNote:
      'Deletions do not propagate: a record deleted on one side is not deleted on the other; merging only covers items present on both sides.',
    neverSyncedTitle: 'Never synced',
    neverSyncedTail:
      '. Each machine keeps its own copy — otherwise compromising one machine compromises them all.',
  },

  connection: {
    cardTitle: 'Connection',
    descFollower: 'Enter the peer URL and its API token, then click “Sync now”.',
    descMaster:
      'This machine is the master: it serves snapshots but never pulls. This section explains how the other side connects.',
    descPeer:
      'This machine both serves snapshots to the peer and pulls from it. Both sides must be peer, each holding a token with sync:read for the other.',
    masterUrlLabel: 'Peer URL',
    masterUrlPlaceholder: 'https://box.example.com:8787',
    saveUrl: 'Save URL',
    savingUrl: 'Saving…',
    urlSaved: 'Peer URL saved.',
    urlEmpty: 'Peer URL must not be empty',
    urlHint: 'Omit',
    urlHintTail: ', and no trailing slash. A non-loopback address must use',
    urlHintTail2:
      ' — the snapshot contains upstream keys in plaintext. For plain HTTP on a trusted LAN, both sides must explicitly set SYNC_ALLOW_INSECURE=1.',
    tokenLabel: "Peer's API token",
    tokenPlaceholder: 'api_…',
    tokenHint: 'Create it under “Settings → API tokens” on the peer with only the',
    tokenHintTail:
      ' permission. The token is not stored locally — enter it on each sync, or call the API from a script.',
    tokenRequired: 'Enter the peer’s API token (api_ prefix, requires sync:read)',
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    refresh: 'Refresh status',
    lastPull: 'Last pull',
    lastResult: 'Last result',
    neverPulled: 'Never synced',
    serveTitle: 'Snapshot export (for the peer to pull)',
    serveDesc:
      'The peer calls GET /api/sync/snapshot with a token that has sync:read. The snapshot contains upstream API keys in plaintext, so it is served only over HTTPS or on an explicitly allowed trusted network.',
    serveMissingPermission:
      'This account lacks sync:read, so it cannot export snapshots. Ask an administrator to create a token with sync:read under “Settings → API tokens” and hand it to the peer, or grant this account the permission.',
    peerHintTitle: 'Two things peer mode requires',
    peerHint:
      '1. Set both sides to peer and enter each other’s URL; 2. Create a token with sync:read on each side and hand it to the other. If either side’s URL, firewall, or token is wrong, pulling in that direction fails.',
    pullMissingPermission:
      'This account lacks sync:write, so it cannot pull or arbitrate conflicts. Ask an administrator to grant it under “Settings → API tokens”, or create an API token with sync:write.',
    troubleshootTitle: 'If the connection fails, check in order:',
    troubleshoot:
      '1. Whether the peer URL and port are correct and the peer is running; 2. Whether Windows Firewall allows inbound TCP 8787 (Private profile); 3. Whether plain HTTP on the LAN has SYNC_ALLOW_INSECURE=1 set on both machines; 4. Whether the peer token has sync:read.',
  },

  conflict: {
    cardTitle: 'Conflict arbitration',
    cardDesc:
      'When a provider, gateway setting, or agent connection mode was changed on both sides, both versions are kept and you choose — nothing is overwritten silently.',
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
      ', so it can view sync status and conflicts but cannot arbitrate. Ask an administrator to grant sync:write.',
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
