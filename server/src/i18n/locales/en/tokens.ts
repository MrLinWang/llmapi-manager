import type { zhTokens } from '../zh/tokens';

export const enTokens: typeof zhTokens = {
  scopes: {
    mustBeArray: 'scopes must be an array of permission names',
    unknown: 'Unknown permission {{scope}}; valid values: {{available}}',
    ungrantable: 'Permission {{permission}} cannot be granted to an API token',
    cannotGrantSelf: 'You cannot grant a permission you do not hold yourself ({{permission}})',
    empty: 'scopes cannot be empty — the token could not call any endpoint',
  },
  name: {
    required: 'name is required; it is how tokens are told apart in the list',
    tooLong: 'name must be at most {{max}} characters',
  },
  expiresAt: {
    mustBeString: 'expiresAt must be an ISO timestamp string or null',
    invalid: 'expiresAt is not a valid timestamp: {{value}}',
    mustBeFuture: 'expiresAt must be later than the current time',
  },
  sessionRequired: {
    create: 'API tokens cannot create new tokens; sign in with a session instead',
    revoke: 'API tokens cannot revoke tokens; sign in with a session instead',
  },
  notFound: 'No such token: {{id}}',
  gateway: {
    resetNotice:
      'This is the only time the full token is shown. Copy it now and update the Agent configurations already deployed.',
  },
};
