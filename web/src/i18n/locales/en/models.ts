import type { zhModels } from '../zh/models';

/** 英文侧声明成 `typeof zhModels`：漏键或多键都会编译失败。 */
export const enModels: typeof zhModels = {
  header: {
    eyebrow: 'Gateway',
    description:
      'Models from every enabled provider are aggregated into lam-<provider>/<model> aliases; requests without an alias use the default model below.',
    aliasCount_one: '{{count}} available alias',
    aliasCount_other: '{{count}} available aliases',
  },
  gateway: {
    title: 'Gateway access',
    desc: 'Point an Agent or any OpenAI / Anthropic client here.',
    baseUrl: 'Gateway URL',
    token: 'Gateway token',
    tokenMissing: 'No token generated yet',
    resetToken: 'Reset token',
    generateToken: 'Generate token',
    resetConfirm:
      'The old token stops working immediately after a reset, and applied Agent configs must be applied again. Continue?',
    newTokenNotice: 'This is the only time the full token is shown. Copy it now:',
  },
  default: {
    title: 'Default provider and model',
    desc: 'Handles requests that carry no lam- alias.',
    noProviders: 'No providers yet. Add one on the Providers page first.',
    providerLabel: 'Default provider',
    modelLabel: 'Default model',
    disabledSuffix: ' (disabled)',
    modelPlaceholder: 'Choose a provider first',
    saved: 'Default model saved',
  },
  aliases: {
    title: 'Aggregated aliases',
    desc: 'Only models of enabled providers are listed; copy an alias straight into a client.',
    count_one: '{{count}} alias',
    count_other: '{{count}} aliases',
    empty: 'No aliases yet. Enable a provider and declare its models first.',
    table: {
      alias: 'Alias',
      provider: 'Provider',
      apiType: 'Protocol',
      upstreamModel: 'Upstream model',
      actions: 'Actions',
    },
  },
};
