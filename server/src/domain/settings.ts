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
  updatedAt: string;
}

export function defaultTenantSettings(): TenantSettings {
  return {
    defaultProviderId: null,
    defaultModel: null,
    gatewayToken: null,
    updatedAt: new Date().toISOString(),
  };
}
