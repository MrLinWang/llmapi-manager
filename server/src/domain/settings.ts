export interface GatewayTokenMeta {
  /** 校验用：只保存 sha256 哈希 */
  tokenHash: string;
  /**
   * 下发 Agent 配置时需要用明文注入到客户端文件，因此额外保存
   * SecretCodec 编码后的密文（未配置加密密钥时等价于明文）。
   * 任何接口都不会返回它。
   */
  tokenCipher: string;
  prefix: string;
  tail: string;
  createdAt: string;
  /** 便于将来做按令牌的审计与吊销 */
  tenantId: string;
  createdBy: string;
}

export interface TenantSettings {
  defaultProviderId: string | null;
  defaultModel: string | null;
  gatewayToken: GatewayTokenMeta | null;
  /**
   * 下发 Codex 配置时是否写 `web_search = "disabled"`。
   *
   * 默认关闭（true）：多数聚合上游把 Responses 请求转成 Chat 线路时不支持
   * `web_search` 这个托管工具，会直接 400 `unsupported_tool`，症状像"模型不支持"。
   * 但如果供应商直连官方、支持托管工具，用户会希望保留联网搜索——所以做成开关。
   */
  disableCodexWebSearch: boolean;
  updatedAt: string;
}

export function defaultTenantSettings(): TenantSettings {
  return {
    defaultProviderId: null,
    defaultModel: null,
    gatewayToken: null,
    // 默认关闭：绝大多数聚合上游会因此报错，关掉才是能直接跑通的配置。
    disableCodexWebSearch: true,
    updatedAt: new Date().toISOString(),
  };
}
