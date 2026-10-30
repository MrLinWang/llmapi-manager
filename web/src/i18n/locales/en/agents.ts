import type { zhAgents } from '../zh/agents';

/** English 侧声明成 `typeof zhAgents`：少一个键、多一个键都编译不过。 */
export const enAgents: typeof zhAgents = {
  header: {
    eyebrow: 'Local integrations',
    description:
      'Write the aggregated gateway URL and token into each agent config file. Only keys owned by this system are touched, and every file is backed up before writing.',
    count_one: '{{count}} agent',
    count_other: '{{count}} agents',
  },
  empty: 'No agents available',
  status: {
    applied: 'Managed',
    notApplied: 'Not managed',
  },
  card: {
    appliedAt: 'Last applied: {{time}}',
  },
  actions: {
    preview: 'Preview',
    previewing: 'Loading preview…',
    apply: 'Apply config',
    applying: 'Writing…',
    reapply: 'Re-apply',
    revert: 'Revert',
    reverting: 'Reverting…',
    stop: 'Stop Codex processes',
    stopping: 'Stopping…',
    stopTitle:
      'Stop the Codex processes running on this machine (TUI and managed daemon) so they reload the config and model catalog',
    toggling: 'Updating…',
  },
  connection: {
    label: 'Connection mode',
    gateway: {
      label: 'Via gateway',
      desc: 'Requests go through this service, which can switch upstreams, fall back, and log every request.',
    },
    direct: {
      label: 'Direct upstream',
      desc: 'Write the upstream URL and key straight into the config; works even when this service is not running.',
    },
    providerLabel: 'Direct provider',
    providerPlaceholder: 'Select a provider…',
    providerOption_one: '{{name}} ({{apiType}}) · {{count}} model',
    providerOption_other: '{{name}} ({{apiType}}) · {{count}} models',
    noCandidates: 'No usable provider: this agent needs a provider using the {{apiType}} protocol.',
    hint: 'Selecting a provider writes its URL and key into the config. Remember to click "Apply config" after switching providers.',
  },
  approval: {
    label: 'Model used by Approve for me',
    none: 'Not mapped (follow Codex default)',
    option: '{{model}} — via {{providerName}} ({{providerKey}}/{{apiType}}, {{tag}})',
    direct: 'direct',
    convert: 'converted',
    sharedWith: '{{base}}; also declared by {{names}}',
    description:
      'Codex hardcodes the approval model to <code>gpt-5.6-luna</code>; no configuration can change it. When requests go through the gateway, this service recognises the approval request (<code>turn_trigger=guardian_review</code>) and replaces the model name with the one selected here. Only effective in gateway mode.',
    legend:
      'Each option names the provider it will go to: <strong>direct</strong> means the protocol matches and no conversion happens; <strong>converted</strong> means cross-protocol conversion (with information loss). When several providers declare the same model name, the gateway prefers the protocol-matching one — only the model name is pinned here, not the provider.',
  },
  conversion: {
    label: 'Cross-protocol forwarding (Responses → Chat)',
    description:
      'When enabled, requests to <code>/v1/responses</code> may land on an "OpenAI compatible (Chat)" provider, with the gateway converting the request, response, and streaming events (including tool calls). When disabled, protocol mismatches always return 501. Conversion loses information: hosted tools (such as <code>web_search</code>) have no Chat equivalent and are dropped, and fields that rely on conversation state fail outright.',
    hint: 'No enabled provider currently speaks the "Responses" protocol. A "Chat" provider exists, so the next request will automatically enable cross-protocol forwarding with gateway-side conversion; you can also tick the switch below now.',
  },
  webSearch: {
    label: 'Disable web search (web_search = "disabled")',
    description:
      'By default Codex attaches <code>web_search</code> to the request as a Responses hosted tool. Most aggregating upstreams do not support it on their Chat routes and return <code>unsupported_tool</code>. Disable this option when connecting directly to an official upstream to keep web search working.',
  },
  stream: {
    retriesLabel: 'Streaming reconnect limit',
    retriesPlaceholder: '5 (Codex default)',
    retriesHint: 'Unit: times, 0–100 allowed. Leave empty to omit the key and use the Codex default of 5.',
    idleLabel: 'Streaming idle timeout',
    idlePlaceholder: '300000 (Codex default)',
    idleHint:
      'Unit: milliseconds, 1000–3600000 allowed. Leave empty to use the Codex default of 300000 (5 minutes).',
    note: 'When an upstream or reverse proxy cuts an idle connection after roughly 60 seconds, raising the reconnect limit reduces "the whole turn fails once retries are exhausted", but it <strong>cannot eliminate reconnects</strong> — it only makes reattaching more likely after each cut. The idle timeout only relaxes <code>Codex\'s own criterion</code>; it cannot stop the peer from closing the connection.',
  },
  messages: {
    applied:
      'Config written. If this agent is running, restart it to load the new config.',
    appliedWithRunning_one:
      'Config written, but {{count}} {{agent}} process is still running. It keeps the old config and must be restarted before the changes take effect.',
    appliedWithRunning_other:
      'Config written, but {{count}} {{agent}} processes are still running. They keep the old config and must be restarted before the changes take effect.',
    reopenCodexHint:
      'Reopen Codex to load the latest config. You can also end leftover processes manually: on Windows use Task Manager or <code>taskkill /F /IM codex.exe</code>; on Linux/macOS run <code>pkill -9 -f codex</code>.',
    manualKillHint:
      'You can also end leftover processes manually: on Windows use Task Manager or <code>taskkill /F /IM codex.exe</code>; on Linux/macOS run <code>pkill -9 -f codex</code>.',
    webSearchOff: 'Web search disabled and the config was re-applied. Codex no longer sends the web_search tool.',
    webSearchOn: 'Web search enabled and the config was re-applied. Upstreams that do not support the tool will report unsupported_tool.',
    streamCleared:
      'Streaming options cleared (Codex defaults apply). Config re-applied. Restart Codex for it to take effect.',
    streamSaved: 'Streaming options saved and the config was re-applied. Restart Codex for it to take effect.',
    streamInvalid: 'Streaming options must be numbers, or left empty to use the defaults',
    approvalSet: 'Saved: gpt-5.6-luna in approval requests will be replaced with {{model}}.',
    approvalCleared: 'Approval model mapping cleared; approvals follow the Codex default behaviour.',
    conversionOn:
      'Cross-protocol forwarding enabled: Responses requests are converted to Chat before being sent upstream. Hosted tools (such as web_search) have no equivalent and will be dropped.',
    conversionOff: 'Cross-protocol forwarding disabled: requests with a protocol mismatch return 501.',
    directProviderSet:
      'Direct provider selected and written into the config. It keeps working when this service is not running.',
    directProviderCleared: 'Direct provider selection cleared.',
    reverted_one: 'Reverted {{count}} key',
    reverted_other: 'Reverted {{count}} keys',
    conflictsKept_one: '{{count}} key was kept because it was edited manually: {{keys}}',
    conflictsKept_other: '{{count}} keys were kept because they were edited manually: {{keys}}',
  },
  preview: {
    title: '{{name}} · Config preview',
    gatewayBaseUrl: 'Gateway URL: {{url}}',
    close: 'Close preview',
    exists: 'Exists',
    willCreate: 'Will be created',
    emptyFile: 'Nothing to write to this file',
    currentUnset: '(not set)',
    columns: {
      key: 'Key',
      current: 'Current value',
      next: 'Will write',
    },
    differs: 'Differs from the current value',
  },
  separators: {
    sentence: '. ',
    list: '; ',
    enumeration: ', ',
  },
};
