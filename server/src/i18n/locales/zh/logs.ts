/**
 * 运行日志与 CLI 输出文案。
 *
 * 与接口文案分开：日志的读者是部署者与运维，语言由 `LOG_LANGUAGE` 决定
 * （默认中文），**不跟随请求语言**——同一故障在不同客户端下长得不一样，
 * 会让 `grep` 与排查看不出规律。
 *
 * 日志里出现的路径、主机名、字段名一律不翻译。
 */
export const zhLogs = {
  startup: {
    banner: 'LLM API Manager 已启动',
    onlyConsole: '(仅控制台)',
    setupTokenTitle: '首次启动：请设置管理员账号',
    setupTokenOpen: '打开 {{url}} 完成设置。',
    setupTokenLabel: '初始化令牌（本次唯一一次显示，请勿外传）：',
    setupTokenNote: '令牌只用于认领管理员账号，设置完成后立即失效。',
    setupTokenMissing: '若没有看到本提示，说明已有账号或令牌已生成过；',
    setupTokenReset: '忘记令牌可删除 data/setup.json 后重启重新生成。',
    setupPending:
      '尚未设置管理员账号，但初始化令牌已在之前的启动中生成；如需重新获取请删除 data/setup.json 后重启。',
    sessionSecretGenerated: '已生成会话签名密钥并保存到 {{file}}',
    noEncryptionKey: '未设置 DATA_ENCRYPTION_KEY：供应商 API Key 与网关令牌将以明文保存在 data 目录。',
    warningLine: '启动告警 [{{code}}] {{message}}',
    shuttingDown: '收到 {{signal}}，正在关闭服务',
    failed: '启动失败',
    adminCreated: '已按 ADMIN_PASSWORD 创建管理员账号',
  },
  app: {
    apiError: '接口错误 {{method}} {{url}}',
    unhandled: '未处理异常 {{method}} {{url}}',
  },
  gateway: {
    autoEnabledConversion: '已自动开启跨协议转发：{{path}} 需要 responses 上游，但当前只有 openai 供应商',
    logWriteFailed: '写入请求日志失败',
    fallbackAttempted: '主供应商失败，尝试回退',
    diagnosticsForward: '诊断转发：provider={{name}}({{id}}) status={{status}} latency={{latency}}ms by={{user}}',
  },
  store: {
    quarantined: '已隔离损坏的数据文件',
    quarantineFailed: '隔离损坏文件失败',
    readFailed: '读取数据文件失败',
    parseFailed: 'JSON 解析失败',
    versionTooNew: '文件版本 {{version}} 高于当前支持的 {{schemaVersion}}',
  },
  setup: {
    tokenRejected: '初始化令牌校验失败',
    completed: '已完成首次初始化',
  },
  providers: {
    probeFailed: '逐档实测失败：供应商 {{id}}（{{error}}）',
  },
  tokens: {
    revoked: '已吊销',
    expired: '已过期',
    invalidated: 'API 令牌 {{prefix}}…{{tail}} 已失效（{{reason}}）',
    lastUsedUpdateFailed: '更新 API 令牌 lastUsedAt 失败',
  },
  cli: {
    dataDir: '数据目录: {{dir}}',
    mode: '模式: {{mode}}',
    modeWrite: '写入',
    modeDryRun: '演练（加 --write 才落盘）',
    verifyEfforts: '档位校验: 开启（会真实请求上游，消耗少量额度）',
    sourcesUnavailable:
      '两个数据源都不可用（网络不可达或响应结构不符）。\n现有配置不受影响；内网可分别用 MODELINFO_URL / MODELS_DEV_URL 指向同构镜像。',
    sourceStats: 'modelinfo.dev: {{info}} | models.dev: {{registry}}',
    countItems: '{{count}} 条',
    unavailable: '不可用',
    unknown: '未知',
    none: '（无）',
    effortRejected: '    {{model}}: 上游拒绝档位 {{levels}}',
    effortChanged: '档位 {{before}} → {{after}}',
    unchanged: '{{name}}: 无变化（{{count}} 个模型）',
    changedCount: '{{name}}: {{changed}}/{{total}} 个模型有更新',
    verifiedRequests: '档位校验共发出 {{count}} 次上游请求。',
    allUpToDate: '全部供应商都已是最新，无需写入。',
    wroteProviders: '已写入 {{count}} 家供应商。记得重新「应用配置」让 Codex 目录生效。',
    pendingProviders: '共 {{count}} 家供应商待更新。确认无误后加 --write 落盘。',
  },
};
