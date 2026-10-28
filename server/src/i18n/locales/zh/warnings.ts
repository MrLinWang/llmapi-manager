/**
 * 启动期告警。
 *
 * 这些告警收集于启动时、显示在控制台顶栏，因此在 `/api/health` 响应阶段
 * 按请求语言渲染（见 `resilience.ts`）。
 */
export const zhWarnings = {
  setupPending: '尚未设置管理员账号：打开控制台首页，用启动日志里的一次性初始化令牌完成设置。',
  plaintextCredentials:
    '未设置 DATA_ENCRYPTION_KEY，供应商 API Key 将以明文保存在 data 目录，建议仅用于单机自托管。',
  credentialDecryptFailed:
    '存在无法解密的供应商凭据，通常是 DATA_ENCRYPTION_KEY 变更所致，请重新填写该供应商的 API Key。',
  corruptFileQuarantined:
    '数据文件 {{file}} 无法解析，已隔离为 {{target}} 并以空数据启动。',
  corruptFileNotQuarantined: '数据文件 {{file}} 无法解析且无法隔离。',
};
