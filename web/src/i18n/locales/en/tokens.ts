import type { zhTokens } from '../zh/tokens';

export const enTokens: typeof zhTokens = {
  title: 'API tokens',
  desc: 'Lets scripts or CI call this service management API. Separate from gateway tokens (lam_); do not mix them up.',
  revealed: {
    title: 'Token created, <strong>you cannot view it again after closing</strong>',
    saved: 'I saved it',
    usage: 'How to call it: ',
    authorizationHeader: 'Authorization: Bearer <token>',
  },
  name: {
    label: 'Purpose',
    placeholder: 'e.g. CI deploy script',
    required: 'Enter a purpose',
  },
  expires: {
    label: 'Expires at (leave empty for no expiry)',
  },
  scopes: {
    label: 'Permissions',
    required: 'Select at least one permission',
    hint: 'You can only grant permissions you already hold — a token narrows access, it cannot escalate.',
    separator: ', ',
  },
  submit: 'Create token',
  submitting: 'Working…',
  empty: 'No tokens created yet.',
  status: {
    revoked: 'Revoked',
    expired: 'Expired',
    active: 'Active',
  },
  lastUsed: 'Last used {{time}}',
  neverUsed: 'Never used',
  revoke: 'Revoke',
  revokeConfirm: 'Revoke the token "{{name}}"? Scripts using it will stop working immediately.',
  revokeDone: 'Revoked "{{name}}"',
};
