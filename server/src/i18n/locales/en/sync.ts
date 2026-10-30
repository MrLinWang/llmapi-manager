import type { zhSync } from '../zh/sync';

/**
 * 配置同步的英文接口文案。
 *
 * 声明成 `typeof zhSync`：漏译、多键、占位符名字写错都会直接编译失败。
 *
 * 两处刻意保留原样：
 *
 * - `api_` / `sync:read` / `schemaVersion` / `local` / `remote` / `master` /
 *   `follower` 是令牌前缀、权限键、字段名与枚举值，调用方要照抄或用来分支。
 * - HTTP 状态码与毫秒数用插值，不做任何本地化。
 */
export const enSync: typeof zhSync = {
  scopes: {
    mustBeArray: 'scopes must be an array',
    unknown: 'Unknown sync scope {{value}}; available: {{available}}',
    emptyForExport:
      'No sync scope selected. Check the items to sync under “Sync scope” (blank means nothing is synced).',
    emptyForPull:
      'No sync scope selected. Check the items to sync under “Sync scope” first (blank means nothing is synced).',
  },
  masterUrl: {
    invalid: 'Invalid peer URL: {{value}}',
    mustBeHttp: 'Peer URL must use http or https: {{value}}',
    requiredForFollower: 'A peer URL is required when selecting the follower role',
    requiredForPeer:
      'A peer URL is required when selecting the peer role (each side must fill in the other side’s address)',
    mustBeStringOrNull: 'masterUrl must be a string or null',
    insecure:
      'The peer URL uses plaintext HTTP ({{value}}); pulling would expose the API token and upstream keys. Use https, or (on a trusted network only) set SYNC_ALLOW_INSECURE=1.',
  },
  role: {
    unknown: 'role must be one of {{available}}',
    mustBeMasterToExport:
      'This role cannot serve a snapshot: the master or peer role is required',
    mustBeFollowerToPull: 'This role cannot pull: the follower or peer role is required',
    mustBeMasterToServe:
      'This role cannot serve a snapshot: the master or peer role is required',
  },
  pull: {
    noMasterUrl: 'No peer URL configured yet',
    tokenRequired: "An API token from the peer is required (api_ prefix with sync:read)",
    timeout: 'Pull timed out (30s); check the peer URL and network connectivity',
    failed: 'Pull failed: {{reason}}',
    badStatus: 'Peer returned {{status}}: {{reason}}',
    badPayload: 'Peer did not return a valid snapshot: {{reason}}',
  },
  conflict: {
    choiceInvalid: 'choice must be local or remote',
    unknown: 'Unknown conflict: {{id}}',
    alreadyResolved: 'This conflict was already handled; refresh and try again',
    undecodable: 'Conflict content cannot be decoded; this machine’s data key may have changed. Reason: {{reason}}',
  },
  snapshot: {
    mustUseHttps:
      'The sync snapshot contains upstream API keys in plaintext and must be served over HTTPS. Deploy a reverse proxy and set TRUST_PROXY=1 (the proxy must set X-Forwarded-Proto), or (on a trusted network only, e.g. inside an EasyTier tunnel) set SYNC_ALLOW_INSECURE=1.',
    malformed: 'Malformed snapshot: {{reason}}',
    futureSchema:
      "The snapshot's schemaVersion ({{remote}}) is newer than this machine's ({{local}}); refusing to apply",
  },
  summary: {
    applied: 'Applied {{count}} item(s)',
    conflicts: '{{count}} conflict(s) awaiting arbitration',
    unchanged: 'No changes',
    elapsed: ' ({{ms}}ms)',
    masterChanged:
      'Note: the master instance id changed — it may be a different machine, so double-check the config',
  },
};
