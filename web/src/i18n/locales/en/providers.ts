import type { zhProviders } from '../zh/providers';

export const enProviders: typeof zhProviders = {
  header: {
    eyebrow: 'Configuration',
    description:
      'Manage each LLM API. Enabled providers take part in alias aggregation and gateway routing; a smaller priority value is picked first.',
  },
  actions: {
    create: 'Add provider',
    test: 'Test',
    moveUp: 'Raise priority',
    moveDown: 'Lower priority',
    enable: 'Enable',
    disable: 'Disable',
  },
  status: {
    enabled: 'Enabled',
    disabled: 'Disabled',
  },
  test: {
    ok: 'Connected',
    fail: 'Failed',
  },
  removeConfirm: 'Delete provider “{{name}}”? This cannot be undone.',
  list: {
    title: 'Providers',
    desc: 'Sorted by priority: a smaller number takes precedence in gateway routing.',
    count_one: '{{count}} provider',
    count_other: '{{count}} providers',
    empty:
      'No providers yet. Add one first, then go to “Model aggregation” to generate a gateway token.',
  },
  table: {
    name: 'Name / alias prefix',
    apiType: 'Protocol',
    baseUrl: 'Base URL',
    models: 'Models',
    key: 'Key',
    lastTest: 'Last test',
    actions: 'Actions',
  },
};
