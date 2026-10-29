import type { zhGateway } from '../zh/gateway';

export const enGateway: typeof zhGateway = {
  apiType: {
    openai: 'OpenAI-compatible (Chat Completions)',
    anthropic: 'Anthropic-compatible (Messages)',
    responses: 'OpenAI-compatible (Responses)',
  },
  auth: {
    /** `/v1/*` 的 401：调用方（Agent 脚本）会直接看到这句 */
    invalidToken: 'Gateway token is missing or invalid',
  },
  alias: {
    missingSeparator: 'Alias {{alias}} is missing the "/" separator',
    incomplete: 'Alias {{alias}} is incomplete',
    unknownProvider: 'Unknown provider key: {{key}}',
    providerDisabled: 'Provider {{name}} is disabled',
    modelNotDeclared: 'Provider {{name}} does not declare model {{model}}',
    modelIsNotImageModel:
      'Model {{model}} is in the chat model list of provider {{name}}, but image endpoints only accept image models — move it from "chat models" to "image models"',
  },
  selection: {
    providerDisabled: 'Disabled',
    protocolMismatch: 'Protocol mismatch: needs {{required}}, this one is {{apiType}}',
    protocolMismatchNoConversion:
      'Protocol mismatch: needs {{required}}, this one is {{apiType}} (conversion only supports responses→chat, and the switch is off or the direction does not apply)',
    noEnabledProviderOfType: 'No enabled {{required}} provider; add and enable one in the console first',
    noEnabledProvider: 'No enabled provider; add and enable one in the console first',
    noEnabledImageProvider:
      'No usable image provider; add and enable an OpenAI-compatible (Chat) or (Responses) provider first',
    approvalNeedsConversionOff:
      'Review model {{model}} belongs to provider {{name}} ({{apiType}}), but this request goes to {{path}} (needs {{required}}) and cross-protocol forwarding is off',
    approvalModelMissing:
      'The configured review model {{model}} is not declared by any enabled provider; check the provider config or pick another review model',
    providerGone: 'The provider this alias points to no longer exists',
    approvalNeedsConversion:
      'Review model {{model}} belongs to provider {{name}} ({{apiType}}), but this request needs an {{required}} upstream',
  },
  forward: {
    requestConvertFailed: 'The request cannot be converted to Chat format: {{detail}}',
    responseConvertFailed: 'The upstream response cannot be converted to the Responses format: {{detail}}',
    requestAborted: 'The request was aborted (client disconnected or timed out)',
    upstreamRequestFailed: 'Upstream request failed: {{detail}}',
    upstreamStatus: 'Upstream returned {{status}}',
    upstreamEmptyBody: 'The upstream returned no response body',

    conversionUnsupported:
      'Cannot convert {{path}} → {{apiType}}: only Responses → Chat is supported, and provider {{name}} is {{apiType}}',
    conversionDisabled:
      'Protocol conversion is off: {{path}} needs an {{required}} upstream, but provider {{name}} is {{apiType}}. Enable "cross-protocol forwarding" in Settings to let the gateway convert the Responses request into a Chat request',

    imageNeedsSupportedProvider:
      'Image endpoint {{path}} needs a {{accepted}} provider, but {{name}} is {{apiType}}. Add or enable a provider that implements the Images API',
    imageInlineFailed:
      'The upstream returned image URLs and the gateway could not download them ({{detail}})',
  },
  convert: {
    inputElementInvalid: 'Every element in the input array must be an object or a string',
    functionCallIncomplete: 'function_call is missing call_id or name',
    customToolCallIncomplete: 'custom_tool_call is missing call_id or name',
    customToolOutputNoCallId: 'custom_tool_call_output is missing call_id',
    functionOutputNoCallId: 'function_call_output is missing call_id',
    unsupportedRole: 'Unsupported role in input message: {{role}}',
    unsupportedInputType: 'Unsupported input item type: {{type}}',
    toolElementInvalid: 'Every element in tools must be an object',
    rawTextToolInput: 'raw text input for the tool',
    bodyNotObject: 'Request body must be a JSON object',
    inputNotStringOrArray: 'input must be a string or an array',
    noMessagesAfterConversion: 'No messages were produced by the conversion; check input and instructions',
    responseNotObject: 'Upstream response is not a JSON object',
    responseNoChoices: 'Upstream response is missing choices',
    responseChoiceInvalid: 'Upstream response choices[0] is not an object',
    upstreamError: 'Upstream returned an error',
    statelessFieldUnsupported:
      'Field {{field}} cannot be converted to Chat Completions: it carries conversation state, and a stateless Chat request would silently drop that meaning',
    responseShapeUnsupported: 'Upstream response cannot be mapped to the Responses format: {{detail}}',
    streamEventUnsupported: 'Upstream stream event cannot be converted: {{detail}}',
  },
  request: {
    modelRequired: 'The request body must include a model field',
  },
  notImplemented: {
    protocolMismatch:
      'Protocol conversion is off: {{path}} needs an {{required}} upstream, but provider {{name}} is {{apiType}}',
  },
};
