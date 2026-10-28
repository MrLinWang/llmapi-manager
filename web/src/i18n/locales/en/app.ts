import type { zhApp } from '../zh/app';

export const enApp: typeof zhApp = {
  brand: 'LLM API Manager',
  tagline: 'Self-hosted gateway console',
  footer: 'LLM API Manager · Self-hosted LLM API console',
  nav: {
    groupConsole: 'Console',
    groupConfig: 'Configuration',
    overview: 'Overview',
    providers: 'Providers',
    models: 'Model aggregation',
    agents: 'Agent config',
    sync: 'Config sync',
    settings: 'Settings',
  },
  notLoggedIn: 'Not signed in',
  logout: 'Sign out',
  openMenu: 'Open menu',
  closeMenu: 'Close menu',
  preparing: 'Preparing…',
  checkingSession: 'Checking sign-in status…',
  serviceOk: 'Service healthy',
  startupWarnings_one: '{{count}} startup warning',
  startupWarnings_other: '{{count}} startup warnings',
  language: {
    label: 'Interface language',
    auto: 'Follow browser',
    saveFailed: 'Failed to save the interface language; reverted to the previous setting',
    readOnly: 'Changing the language requires the settings:write permission',
  },
  selfHostedNote: 'Self-hosted · single process · data stays on this machine',
};
