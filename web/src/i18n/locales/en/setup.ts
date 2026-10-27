import type { zhSetup } from '../zh/setup';

export const enSetup: typeof zhSetup = {
  title: 'Set up the administrator account',
  description: 'This is the first startup. Choose your own username and password, then sign in.',
  token: {
    label: 'Setup token',
    placeholder: 'setup_…',
    hint: 'Printed to the server console on first startup. The token only claims the administrator account and is invalidated as soon as setup finishes. Cannot find it? Delete <code>data/setup.json</code> and restart the service to regenerate it.',
  },
  username: {
    label: 'Username',
    rules: '{{min}}–{{max}} characters; letters, digits, dots, underscores and hyphens only.',
  },
  password: {
    label: 'Password',
    tooShort_one: 'Password must be at least {{count}} character',
    tooShort_other: 'Password must be at least {{count}} characters',
  },
  confirm: {
    label: 'Confirm password',
    mismatch: 'The two passwords do not match',
  },
  submit: 'Create administrator and sign in',
  submitting: 'Creating…',
  securityNote: 'Only a scrypt hash of the password is stored; the server cannot recover the plaintext. The setup token is invalidated once setup finishes.',
  statusFailed: 'Failed to read the setup status. Make sure the service is running.',
};
