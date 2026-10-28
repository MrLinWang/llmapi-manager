import type { zhCommon } from '../zh/common';

/** English 侧声明成 `typeof zhCommon`：少一个键、多一个键都编译不过。 */
export const enCommon: typeof zhCommon = {
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  delete: 'Delete',
  edit: 'Edit',
  refresh: 'Refresh',
  copy: 'Copy',
  copied: 'Copied',
  loading: 'Loading…',
  notSet: 'Not set',
  none: '(not set)',
  loadFailed: 'Failed to load. Try again.',
  requestFailed: 'Request failed (HTTP {{status}})',
  saveFailed: 'Save failed',
  actionFailed: 'Action failed',
  deleteFailed: 'Delete failed',
  sortFailed: 'Reorder failed',
  testFailed: 'Test failed',
  loginFailed: 'Sign-in failed',
  setupFailed: 'Setup failed',
  updateFailed: 'Update failed',
  createFailed: 'Create failed',
  revokeFailed: 'Revoke failed',
  fetchModelsFailed: 'Failed to fetch model list',
};
