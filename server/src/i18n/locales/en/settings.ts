import type { zhSettings } from '../zh/settings';

export const enSettings: typeof zhSettings = {
  validation: {
    numberOrNull: '{{field}} must be a number or null',
    integer: '{{field}} must be an integer',
    integerRange: '{{field}} must be an integer between {{min}} and {{max}}',
    integerRangeCodexTruncate:
      '{{field}} must be an integer between {{min}} and {{max}} (Codex silently truncates values above the maximum, so out-of-range input is rejected here)',
    boolean: '{{field}} must be a boolean',
    stringOrNull: '{{field}} must be a string or null',
  },
  default: {
    modelNotInProvider: 'Model {{model}} is not in the model list of provider {{name}}',
  },
  agentTarget: {
    unknown: 'No such Agent: {{id}}',
    modeInvalid: 'mode must be one of {{modes}}',
    providerDisabled: 'Provider "{{name}}" is disabled and cannot be used for direct connection',
    apiTypeMismatch:
      'Provider "{{name}}" uses a protocol that does not fit {{agent}}; {{needed}} is required',
  },
  language: {
    fieldRequired: 'The language field is required (use null to follow the browser)',
    invalid: 'language must be one of {{supported}}, or null',
  },
};
