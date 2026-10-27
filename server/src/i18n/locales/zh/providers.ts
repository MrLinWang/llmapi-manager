/**
 * 供应商 / 连通性测试 / 模型拉取的文案。
 *
 * 这一组文案都会**出现在 API 响应里**（`error.message` 或连通性结果的 `error` 字段），
 * 前端原样显示，所以必须走字典而不是硬编码中文。
 *
 * 不翻译的东西：字段名（`name` / `apiType` / `baseUrl` / `models`）、`apiType` 的机器值、
 * URL、模型名，以及上游返回的原始错误文本（那是上游的话，不是我们的）。
 */
export const zhProviders = {
  /** 入参形状校验：字段名保持原样，方便调用方对上自己的请求体 */
  validation: {
    nameType: 'name 必须是字符串',
    baseUrlType: 'baseUrl 必须是字符串',
    modelsType: 'models 必须是字符串数组',
    modelsItems: 'models 只能包含字符串',
    modelCapabilitiesType: 'modelCapabilities 必须是对象',
    idsType: 'ids 必须是字符串数组',
    enabledType: 'enabled 必须是布尔值',
    /** `{{types}}` 是服务器实际接受的协议清单，由 API_TYPES 拼出来，避免两处清单分叉 */
    apiTypeInvalid: 'apiType 只能是 {{types}}',
    nameRequired: '供应商名称不能为空',
    apiTypeUnsupported: '不支持的协议类型：{{apiType}}',
    priorityType: '优先级必须是数字',
    baseUrlBlank: 'baseUrl 不能为空',
    baseUrlEmpty: 'Base URL 不能为空',
    baseUrlInvalid: 'Base URL 不是合法地址：{{url}}',
    baseUrlProtocol: 'Base URL 只支持 http/https',
  },
  notFound: '供应商 {{id}} 不存在',
  nameTaken: '已存在同名供应商：{{name}}',
  /** 排序接口收到了不认识的供应商 id */
  unknownProvider: '未知供应商 {{id}}',
  /** 设置默认供应商 / 默认模型 */
  defaultModel: {
    notInProvider: '模型 {{model}} 不在供应商 {{provider}} 的模型列表中',
  },
  /** 按表单临时值拉取模型列表（`POST /api/providers/models`） */
  models: {
    apiKeyRequired: '尚未填写 API Key，且没有可沿用的已保存 Key',
  },
  /** 连通性测试 / 模型拉取失败时的说明，会显示在界面上 */
  test: {
    timeout: '请求超时（{{seconds}}s）',
    invalidJson: '响应不是合法 JSON：{{detail}}',
    /** 连上了但结构认不出来：明确说出来，别让界面显示空列表让人以为上游真没有模型 */
    noModelList: '连上了但响应里没有可识别的模型列表（期望 data[] 或 models[]）：{{detail}}',
    httpError: 'HTTP {{status}}: {{detail}}',
  },
};
