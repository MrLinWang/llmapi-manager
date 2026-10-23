import type { ProviderRecord } from './provider';
import type { AgentConnectionMode } from './settings';

export const AGENT_IDS = ['codex', 'claude-code'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/**
 * config：主配置文件（TOML/JSON，按键打补丁）
 * auth  ：凭据文件
 * catalog：模型目录文件（整份由我们生成，同样记录快照以便还原）
 */
export type AgentFileRole = 'config' | 'auth' | 'catalog';

export interface AgentFileSpec {
  /**
   * 逻辑角色：config 是主配置、auth 是凭据文件，二者按键打补丁；
   * catalog 是整份生成的模型目录，内容整体覆盖而非按键合并，语义与上两者不同。
   */
  role: AgentFileRole;
  /** 相对解析出的 Agent 根目录的文件名，可含子目录 */
  relativePath: string;
  format: 'json' | 'toml';
  /**
   * catalog 角色专用：内容由我们从网关的模型列表整体生成，不做按键合并。
   * 仍然走"写前备份 + 还原时只删自己创建的文件"那套规则。
   */
  generated?: boolean;
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
  /**
   * 应用配置时探测到的、仍在运行的该 Agent 进程数。
   * 大于 0 表示这些进程仍在用内存里的旧配置，需要重启才能生效。
   */
  runningProcesses?: number;
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
  /** 本次会按走网关还是直连上游来写配置 */
  connectionMode: AgentConnectionMode;
  /** 直连时实际写入 base_url 的上游地址；网关模式为 undefined */
  directBaseUrl?: string;
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
