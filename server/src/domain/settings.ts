import type { AgentId } from './agent';

/**
 * Codex 在 API Key 认证下使用的审批模型名（`model-provider/src/provider.rs` 的
 * `API_KEY_APPROVAL_REVIEW_PREFERRED_MODEL`）。它会作为 `model` 出现在
 * 「Approve for me」触发的请求体里。
 *
 * 这是硬编码值，用户改不了：`ModelInfo.auto_review_model_override` 会被
 * `ModelInfo → ModelPreset` 的转换丢弃，`review_model` 只给 `/review` 用。
 * 走网关时把它当占位名映射到别的模型，是唯一可行的做法。
 */
export const APPROVAL_REVIEW_MODEL_NAME = 'gpt-5.6-luna';

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

/**
 * Agent 配置的连接方式。
 *
 * - `gateway`：base_url 指向本服务网关，请求经网关转发（可换供应商、有请求日志、可回退）。
 * - `direct` ：base_url 直接指向上游供应商，Key 用上游自己的 Key。
 *              配置写好后即使本服务没在运行，Codex 也能正常使用——这是它的用途。
 */
export type AgentConnectionMode = 'gateway' | 'direct';

export const AGENT_CONNECTION_MODES: readonly AgentConnectionMode[] = ['gateway', 'direct'];

/**
 * 单个 Agent 的下发偏好。
 *
 * Codex 与 Claude Code 各存一份、互不影响：两者协议不同（responses / anthropic）、
 * 用途也可能不同（比如 Codex 想直连某个官方上游、Claude Code 仍走聚合）。
 */
export interface AgentTargetPreference {
  /** 走网关还是直连上游 */
  mode: AgentConnectionMode;
  /**
   * 直连时指定用哪家供应商。
   *
   * 网关模式下这个字段不参与选路（网关有自己的默认供应商与别名解析）；
   * 直连模式必须能明确指定——否则多供应商时用户无从选择，只能被动接受
   * pickProvider 的优先级排序结果。
   */
  directProviderId: string | null;
  /** 直连时指定用哪个模型；null 表示用该供应商的第一个模型 */
  directModel: string | null;
}

export interface TenantSettings {
  defaultProviderId: string | null;
  defaultModel: string | null;
  /**
   * 「Approve for me」自动审批请求的模型名 → 实际要用的模型。
   *
   * Codex 在 API Key 认证下把审批模型硬编码成 `APPROVAL_REVIEW_MODEL_NAME`（`gpt-5.6-luna`），
   * 没有任何配置项能改（`ModelInfo.auto_review_model_override` 会被 `ModelInfo → ModelPreset`
   * 的转换丢弃，`review_model` 只给 `/review` 用）。但走网关时这个名字会原样出现在请求体里，
   * 于是网关可以把它当成一个"占位名"，换成用户真正想用的模型。
   *
   * null 表示不映射，按普通裸模型名处理。
   */
  approvalReviewModel: string | null;
  /**
   * 是否允许跨协议转发（目前只做 Responses → Chat）。
   *
   * 默认 false：协议不匹配继续 501，这是原有行为，变更需要用户明确同意。
   * 打开后，发往 `/v1/responses` 的请求可以落到 `openai`（Chat）供应商上，
   * 由网关双向转换请求与响应（含工具调用与流式）。
   *
   * 转换有信息损失（托管工具如 web_search 没有等价物），所以不做静默兜底：
   * 关着的时候必须让用户知道"是配置问题"，而不是收到一个被改写的结果。
   */
  protocolConversion: boolean;
  gatewayToken: GatewayTokenMeta | null;
  /**
   * 下发 Codex 配置时是否写 `web_search = "disabled"`。
   *
   * 默认关闭（true）：多数聚合上游把 Responses 请求转成 Chat 线路时不支持
   * `web_search` 这个托管工具，会直接 400 `unsupported_tool`，症状像"模型不支持"，
   * 而根因是工具而非模型。
   * 但如果供应商直连官方、支持托管工具，用户会希望保留联网搜索——所以做成开关。
   */
  disableCodexWebSearch: boolean;
  /**
   * 按 Agent 分开的下发偏好。键是 AgentId（codex / claude-code）。
   *
   * 分开存是必要的：Codex 与 Claude Code 协议不同、用途也可能不同，
   * 一个全局开关会强迫两者同步切换。
   */
  agentTargets: Partial<Record<AgentId, AgentTargetPreference>>;
  updatedAt: string;
}

export function defaultTenantSettings(): TenantSettings {
  return {
    defaultProviderId: null,
    defaultModel: null,
    approvalReviewModel: null,
    protocolConversion: false,
    gatewayToken: null,
    // 默认关闭：绝大多数聚合上游会因此报错，关掉才是能直接跑通的配置。
    disableCodexWebSearch: true,
    agentTargets: {},
    updatedAt: new Date().toISOString(),
  };
}
