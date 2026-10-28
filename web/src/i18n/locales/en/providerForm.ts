import type { zhProviderForm } from '../zh/providerForm';

export const enProviderForm: typeof zhProviderForm = {
  header: {
    titleEdit: 'Edit provider',
    titleCreate: 'Add provider',
    desc: 'Takes part in model aggregation and gateway routing as soon as you save.',
    close: 'Close form',
  },
  sections: {
    basic: 'Basics',
    connection: 'Connection',
    models: 'Models & notes',
  },
  basic: {
    name: 'Name',
    namePlaceholder: 'e.g. PackyCode',
    aliasPrefix: 'Alias prefix: lam-{{key}}/',
    apiType: 'Protocol type',
    protocolHintPrefix: 'Requests for this protocol go to',
    protocolHintSuffix:
      '; it must match the API the upstream actually supports, otherwise the gateway returns 501 by default. Exception: Codex only sends Responses requests — with “protocol conversion” enabled the gateway converts Responses to Chat and sends it to “Chat Completions” providers.',
  },
  connection: {
    baseUrl: 'Base URL',
    baseUrlHint: 'A trailing /v1 is optional — the server adds it when missing and keeps it as-is when present.',
    apiKey: 'API Key',
    apiKeyKeep: '(leave blank to keep the current key)',
    apiKeyHint: 'Credentials are stored encrypted; the API only returns the first 3 and last 4 characters, masked.',
  },
  models: {
    label: 'Models',
    fetch: 'Fetch models from upstream',
    fetching: 'Fetching…',
    fetchTitleEmpty: 'Fill in the Base URL first',
    fetchTitle: 'Query the upstream for available models using the protocol and URL entered above',
    placeholder: 'Type a model name and press Enter, e.g. gpt-5.1',
    remove: 'Remove model {{model}}',
    hint: 'Press Enter or comma to add, click × on a chip to remove; you can also paste several (comma or newline separated).',
    emptyList: 'The upstream returned an empty list. Check whether this provider exposes a model list endpoint.',
    fetchFailed: 'Could not fetch the model list',
    fetched_one: 'Upstream returned {{count}} model ({{latencyMs}}ms). Select the ones to use.',
    fetched_other: 'Upstream returned {{count}} models ({{latencyMs}}ms). Select the ones to use.',
    withCapabilities_one: ' {{count}} of them reports a context window and is saved along with the provider.',
    withCapabilities_other: ' {{count}} of them report a context window and are saved along with the provider.',
    candidatesHint: 'Click a model to enable it (click again to remove); selected models use the accent color.',
    selectAll: 'Select all',
    clearSelection: 'Clear selection',
    collapse: 'Collapse',
    website: 'Website (optional)',
    notes: 'Notes (optional)',
    requireOne: 'Enter at least one model name',
  },
};
