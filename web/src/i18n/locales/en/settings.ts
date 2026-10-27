import type { zhSettings } from '../zh/settings';

export const enSettings: typeof zhSettings = {
  header: {
    eyebrow: 'Account',
    description: 'Review your sign-in identity and permissions, or update your password.',
  },
  account: {
    title: 'Current account',
    desc: 'Sign-in identity, tenant and permission scope.',
    username: 'Username',
    tenant: 'Tenant',
    role: 'Role',
    permissionCount: 'Permissions',
    grantedPermissions: 'Granted permissions',
  },
  language: {
    title: 'Interface language',
    desc: 'The language preference is stored on the server and applies to every user in this tenant. Error messages returned by the server are still in Chinese and do not follow the interface language.',
    saved: 'Interface language saved',
  },
  password: {
    title: 'Change password',
    desc: 'Every signed-in session is invalidated immediately after the change; you will need to sign in again.',
    current: 'Current password',
    next: 'New password (at least 8 characters)',
    confirm: 'Confirm new password',
    mismatch: 'The two new passwords do not match',
    submit: 'Update password',
    submitting: 'Submitting…',
  },
  tenancy: {
    title: 'Multi-user and tenants',
    desc: 'The scope of the current version and how it extends.',
    body: 'This version is single-user: one tenant and one owner account. Data is already partitioned per tenant and permissions are decided centrally by role, so adding users or tenants will not require changes to the domain model or API contracts.',
  },
};
