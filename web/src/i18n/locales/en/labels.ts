import type { zhLabels } from '../zh/labels';

export const enLabels: typeof zhLabels = {
  apiTypes: {
    openai: { label: 'OpenAI-compatible (Chat Completions)', short: 'Chat' },
    responses: { label: 'OpenAI-compatible (Responses)', short: 'Responses' },
    anthropic: { label: 'Anthropic-compatible (Messages)', short: 'Messages' },
  },
  roles: {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
  },
  permissions: {
    providersRead: 'Read providers',
    providersWrite: 'Create, update and delete providers',
    gatewayRead: 'Read gateway URL and token status',
    gatewayWrite: 'Reset the gateway token',
    agentsRead: 'Read agent configuration',
    agentsApply: 'Apply and revert agent configuration',
    logsRead: 'Read request logs and stats',
    settingsRead: 'Read settings',
    settingsWrite: 'Change settings',
    usersManage: 'Manage users',
    tenantsManage: 'Manage tenants',
  },
};
