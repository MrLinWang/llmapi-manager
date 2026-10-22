import type { ProviderRecord } from './provider';

export const AGENT_IDS = ['codex', 'claude-code'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export type AgentFileRole = 'config' | 'auth';

export interface AgentFileSpec {
  /** 逻辑角色：config 是主配置，auth 是凭据文件 */
  role: AgentFileRole;
  /** 相对解析出的 Agent 根目录的文件名，可含子目录 */
  relativePath: string;
  format: 'json' | 'toml';
}

export interface AgentDefinition {
  id: AgentId;
  name: string;
  description: string;
  /** 由 AgentPathResolver 使用的根目录名，如 .codex */
  homeDirName: string;
  files: AgentFileSpec[];
}

/** 我们写入某个文件的键值快照：还原时只撤销仍然是这些值的键。 */
export interface WrittenFileSnapshot {
  role: AgentFileRole;
  path: string;
  /** 扁平键路径 → 写入值，如 "env.ANTHROPIC_BASE_URL" */
  values: Record<string, string>;
  /**
   * 该文件是否是本次应用时由我们创建的（应用前不存在）。
   * 还原时用于删除空壳文件，避免在家目录留下空的 config.toml。
   */
  created?: boolean;
}

export interface AgentBindingState {
  agentId: AgentId;
  appliedAt: string;
  appliedBy: string;
  files: WrittenFileSnapshot[];
}

export interface AgentsData {
  bindings: Partial<Record<AgentId, AgentBindingState>>;
}

export interface PreviewEntry {
  key: string;
  next: string;
  current: string | null;
  /** 当前值既不等于我们的目标值，也非空时标出，供 UI 提示 */
  differs: boolean;
}

export interface AgentFilePreview {
  role: AgentFileRole;
  path: string;
  exists: boolean;
  entries: PreviewEntry[];
}

export interface AgentPreview {
  agentId: AgentId;
  name: string;
  applied: boolean;
  appliedAt?: string;
  gatewayBaseUrl: string;
  files: AgentFilePreview[];
}

export function defaultAgentsData(): AgentsData {
  return { bindings: {} };
}

export function findProviderForAgent(
  providers: readonly ProviderRecord[],
  apiType: ProviderRecord['apiType'],
): ProviderRecord | undefined {
  return providers.find((item) => item.enabled && item.apiType === apiType);
}
