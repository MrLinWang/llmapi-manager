import type { zhAuth } from '../zh/auth';

export const enAuth: typeof zhAuth = {
  login: {
    missingCredentials: 'Username and password are required',
    invalidCredentials: 'Incorrect username or password',
    tenantDisabled: 'This tenant is disabled',
  },
  password: {
    oldAndNewRequired: 'Both the current and the new password are required',
    newTooShort: 'The new password must be at least {{min}} characters',
    oldIncorrect: 'The current password is incorrect',
    updated: 'Password updated — please sign in again',
  },
  permission: {
    tokenMissing: 'This API token is missing the {{permission}} permission',
    roleMissing: 'Role {{role}} is missing the {{permission}} permission',
  },
  setup: {
    tokenRequired: 'The setup token is required',
    usernameMustBeString: 'Username must be a string',
    passwordMustBeString: 'Password must be a string',
    alreadyCompleted: 'Setup is already complete and cannot be run again',
    invalidToken: 'The setup token is incorrect',
    usernameTaken: 'Username {{username}} already exists',
    usernameMin: 'Username must be at least {{min}} characters',
    usernameMax: 'Username must be at most {{max}} characters',
    usernamePattern: 'Username may only contain letters, digits, dots, underscores and hyphens',
    passwordMin: 'Password must be at least {{min}} characters',
  },
  guard: {
    sessionRequired: 'This endpoint requires a signed-in session; API tokens cannot call it',
    routeNotDeclared: 'Route {{method}} {{url}} is not declared in the access registry',
  },
};
