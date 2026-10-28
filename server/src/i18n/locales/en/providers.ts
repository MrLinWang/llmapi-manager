import type { zhProviders } from '../zh/providers';

/** 服务端英文字典（providers 区域）。声明成 `typeof zhProviders`，漏键/多键编译不过。 */
export const enProviders: typeof zhProviders = {
  validation: {
    nameType: 'name must be a string',
    baseUrlType: 'baseUrl must be a string',
    modelsType: 'models must be an array of strings',
    modelsItems: 'models may only contain strings',
    modelCapabilitiesType: 'modelCapabilities must be an object',
    idsType: 'ids must be an array of strings',
    enabledType: 'enabled must be a boolean',
    apiTypeInvalid: 'apiType must be one of {{types}}',
    nameRequired: 'Provider name is required',
    apiTypeUnsupported: 'Unsupported API type: {{apiType}}',
    priorityType: 'priority must be a number',
    baseUrlBlank: 'baseUrl must not be empty',
    baseUrlEmpty: 'Base URL is required',
    baseUrlInvalid: 'Base URL is not a valid URL: {{url}}',
    baseUrlProtocol: 'Base URL must use http or https',
  },
  notFound: 'Provider {{id}} not found',
  nameTaken: 'A provider with this name already exists: {{name}}',
  unknownProvider: 'Unknown provider {{id}}',
  defaultModel: {
    notInProvider: 'Model {{model}} is not in the model list of provider {{provider}}',
  },
  models: {
    apiKeyRequired: 'No API key provided, and no saved key available to reuse',
  },
  probe: {
    noModels: 'This provider has no models to probe',
    unsupportedProtocol: 'The {{apiType}} protocol has no reasoning-effort concept',
    allRejected: 'The upstream rejected every candidate effort level',
  },
  test: {
    timeout: 'Request timed out ({{seconds}}s)',
    invalidJson: 'Response is not valid JSON: {{detail}}',
    noModelList:
      'Connected, but the response has no recognizable model list (expected data[] or models[]): {{detail}}',
    httpError: 'HTTP {{status}}: {{detail}}',
  },
};
