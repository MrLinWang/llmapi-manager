import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition, AgentId } from '../domain/agent';

export const AGENT_DEFINITIONS: Record<AgentId, AgentDefinition> = {
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    description: '写入 ~/.codex 下的 config.toml 与 auth.json，把请求指向本服务的网关。',
    homeDirName: '.codex',
    files: [
      { role: 'config', relativePath: 'config.toml', format: 'toml' },
      { role: 'auth', relativePath: 'auth.json', format: 'json' },
    ],
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    description: '写入 ~/.claude/settings.json 的 env 段，把 Anthropic 请求指向本服务。',
    homeDirName: '.claude',
    files: [{ role: 'config', relativePath: 'settings.json', format: 'json' }],
  },
};

export function getAgentDefinition(agentId: string): AgentDefinition | undefined {
  return (AGENT_DEFINITIONS as Record<string, AgentDefinition | undefined>)[agentId];
}

export function listAgentDefinitions(): AgentDefinition[] {
  return Object.values(AGENT_DEFINITIONS);
}

export interface ResolveInput {
  tenantId: string;
  userId: string;
}

/**
 * Agent 物理路径解析。
 *
 * 本期：所有租户/用户都落在服务进程所属 OS 用户的家目录（与 cc-switch 桌面端一致）。
 * 将来多租户时只需替换这里的实现（例如 data/tenants/<id>/home 或容器卷），
 * 上层调用与 API 契约保持不变。
 */
export class AgentPathResolver {
  constructor(
    private readonly homeDir: string = os.homedir(),
    private readonly tenantBaseDirs: Map<string, string> = new Map(),
  ) {}

  /** 为某个租户注册独立工作区根目录（多租户预留入口）。 */
  registerTenantWorkspace(tenantId: string, dir: string): void {
    this.tenantBaseDirs.set(tenantId, dir);
  }

  agentRoot(agentId: AgentId, input: ResolveInput): string {
    const definition = AGENT_DEFINITIONS[agentId];
    const tenantRoot = this.tenantBaseDirs.get(input.tenantId);
    const base = tenantRoot ?? this.homeDir;
    return path.join(base, definition.homeDirName);
  }

  resolve(agentId: AgentId, input: ResolveInput, role: 'config' | 'auth'): string {
    const definition = AGENT_DEFINITIONS[agentId];
    const spec = definition.files.find((item) => item.role === role);
    if (!spec) throw new Error(`Agent ${agentId} 未声明 ${role} 文件`);
    return path.join(this.agentRoot(agentId, input), spec.relativePath);
  }
}
