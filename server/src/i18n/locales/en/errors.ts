import type { zhErrors } from '../zh/errors';

export const enErrors: typeof zhErrors = {
  unauthorized: 'Sign-in required',
  forbidden: 'You do not have permission to perform this action',
  notFound: 'Resource not found',
  internal: 'Internal server error',
  routeNotDeclared: 'Route {{method}} {{url}} is not declared in the access registry',
  apiRouteMissing: 'No such endpoint: {{method}} {{url}}',
  framework: 'Malformed request',
};
