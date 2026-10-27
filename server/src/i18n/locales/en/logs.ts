import type { zhLogs } from '../zh/logs';

export const enLogs: typeof zhLogs = {
  startup: {
    banner: 'LLM API Manager started',
    onlyConsole: '(console only)',
    setupTokenTitle: 'First run: set up the admin account',
    setupTokenOpen: 'Open {{url}} to finish setup.',
    setupTokenLabel: 'Setup token (shown only once — do not share it):',
    setupTokenNote: 'The token only claims the admin account and expires once setup completes.',
    setupTokenMissing: 'If you do not see this notice, an account or token already exists;',
    setupTokenReset: 'to regenerate it, delete data/setup.json and restart.',
    setupPending:
      'No admin account yet, but the setup token was already generated on an earlier start; delete data/setup.json and restart to get a new one.',
    sessionSecretGenerated: 'Generated a session signing secret and saved it to {{file}}',
    noEncryptionKey:
      'DATA_ENCRYPTION_KEY is not set: provider API keys and gateway tokens will be stored in plaintext under data/.',
    warningLine: 'startup warning [{{code}}] {{message}}',
    shuttingDown: 'Received {{signal}}, shutting down',
    failed: 'Startup failed',
    adminCreated: 'Created the admin account from ADMIN_PASSWORD',
  },
  app: {
    apiError: 'API error {{method}} {{url}}',
    unhandled: 'Unhandled exception {{method}} {{url}}',
  },
  gateway: {
    autoEnabledConversion:
      'Automatically enabled cross-protocol forwarding: {{path}} needs a responses upstream, but only openai providers exist',
    logWriteFailed: 'Failed to write the request log',
    fallbackAttempted: 'Primary provider failed; trying a fallback',
    diagnosticsForward:
      'diagnostics forward: provider={{name}}({{id}}) status={{status}} latency={{latency}}ms by={{user}}',
  },
  store: {
    quarantined: 'Quarantined a corrupt data file',
    quarantineFailed: 'Failed to quarantine the corrupt file',
    readFailed: 'Failed to read the data file',
    parseFailed: 'JSON parse failed',
    versionTooNew: 'File version {{version}} is newer than the supported {{schemaVersion}}',
  },
  setup: {
    tokenRejected: 'Setup token verification failed',
    completed: 'First-time setup completed',
  },
  tokens: {
    revoked: 'revoked',
    expired: 'expired',
    invalidated: 'API token {{prefix}}…{{tail}} is no longer valid ({{reason}})',
    lastUsedUpdateFailed: 'Failed to update API token lastUsedAt',
  },
  cli: {
    dataDir: 'data directory: {{dir}}',
    mode: 'mode: {{mode}}',
    modeWrite: 'write',
    modeDryRun: 'dry run (pass --write to persist)',
    verifyEfforts: 'effort verification: on (makes real upstream requests, consumes a little quota)',
    sourcesUnavailable:
      'Both data sources are unavailable (network unreachable or unexpected response shape).\nExisting config is unaffected; on an intranet you can point MODELINFO_URL / MODELS_DEV_URL at a compatible mirror.',
    sourceStats: 'modelinfo.dev: {{info}} | models.dev: {{registry}}',
    countItems: '{{count}} entries',
    unavailable: 'unavailable',
    unknown: 'unknown',
    none: '(none)',
    effortRejected: '    {{model}}: upstream rejected efforts {{levels}}',
    effortChanged: 'efforts {{before}} → {{after}}',
    unchanged: '{{name}}: no change ({{count}} models)',
    changedCount: '{{name}}: {{changed}}/{{total}} models updated',
    verifiedRequests: 'effort verification made {{count}} upstream requests.',
    allUpToDate: 'All providers are up to date; nothing to write.',
    wroteProviders: 'Wrote {{count}} provider(s). Re-apply the Codex config so the catalog takes effect.',
    pendingProviders: '{{count}} provider(s) have updates. Pass --write once you have reviewed them.',
  },
};
