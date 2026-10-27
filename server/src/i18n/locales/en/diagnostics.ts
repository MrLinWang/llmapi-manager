import type { zhDiagnostics } from '../zh/diagnostics';

export const enDiagnostics: typeof zhDiagnostics = {
  disabled: 'Diagnostics are disabled. Set ENABLE_DIAGNOSTICS=1 and restart',
  pathNotString: 'path must be a string',
  pathNotSupported: 'path must be one of {{paths}}',
  modelEmpty: 'model must not be empty',
  bodyNotObject: 'body must be a JSON object',
  selectionFailed: 'Routing failed: {{reason}}',

  route: {
    conversionHint:
      'If you only have openai (Chat) providers, enabling protocolConversion lets the gateway turn Responses into Chat',
    wouldReject: 'The real gateway would return 501: the path needs {{required}}, but the primary provider is {{apiType}}',
  },

  chain: {
    convertFailed: 'Conversion failed (internal error)',
    convertFailedSummary: 'Request conversion failed; a real request would return 400',
    convertSkipped: 'No conversion needed (path needs {{required}}, provider is {{apiType}})',
    convertNotTriggered: 'Not triggered',
    upstreamFailed: 'Upstream request failed',
    upstreamFailedSummary: 'Upstream unreachable; a real request would return 502',
    upstreamEmptySummary: 'Upstream returned an empty response',
    streamSkipped:
      'The request is streaming (stream:true) and the upstream returned SSE. This endpoint does not parse streams — doing so would report a working setup as a JSON parse failure. Pass a body with stream:false to verify the conversion mapping.',
    responseConvertFailed: 'Response conversion failed',
    responseConvertHint:
      'The upstream may not actually be Chat Completions compatible; check whether the provider apiType is wrong',
    allOkSummary: 'End to end OK: a real request would be forwarded along the path above',
    partialFailSummary: 'A step failed; see the error fields in steps',
  },

  converter: {
    note: 'These are pure-function mapping checks; no network or settings involved',
    textName: 'Text: input string → messages',
    textFailName: 'Text',
    toolsName: 'Tool definition: flat → nested',
    toolsFailName: 'Tool definition',
    customName: 'custom tool → single-argument function',
    customFailName: 'custom tool',
    statefulName: 'Stateful features must be rejected (previous_response_id)',
    statefulNotRejected:
      'No error was raised — the conversion is lossy yet silently continued, handing Codex the wrong context',
    responseName: 'Response: choices → output[]',
    responseFailName: 'Response conversion',
  },

  check: {
    codexProtocolName: 'Codex has a usable upstream protocol',
    codexProtocolOk: '{{responses}} responses provider(s)',
    codexProtocolOkWithConversion:
      '{{responses}} responses provider(s), {{openai}} openai provider(s) (via conversion)',
    codexProtocolFail: 'No enabled responses provider, and cross-protocol forwarding is off',
    codexProtocolFix: 'Add a responses provider, or enable protocolConversion',

    catalogName: 'The Codex catalog contains no unusable protocols',
    catalogMissing: 'Never applied; the catalog file does not exist (Codex falls back to its built-in model list)',
    catalogAllUsable: '{{count}} entries in the catalog, all protocols usable',
    catalogUnusable: '{{count}} entries are currently unusable: {{names}}',
    catalogFix:
      'Re-apply the Codex config; if the catalog contains openai aliases you want to use, enable protocolConversion',

    approvalDirectName: 'The review model mapping has no effect in direct mode',
    approvalDirectDetail:
      'Codex is in direct mode, so requests bypass the gateway and approvalReviewModel can never apply',
    approvalDirectFix: 'Switch back to gateway mode, or clear approvalReviewModel',
    approvalOkName: 'Conditions for the review model mapping',
    approvalConfigured: 'Configured {{model}}; effective in gateway mode',
    approvalNotConfigured: 'Not configured (Codex uses its hardcoded placeholder)',

    aliasName: 'All aliases point to existing providers',
    aliasOk: '{{count}} alias(es), all valid',
    aliasStale: '{{count}} alias(es) point to deleted providers',
  },
};
