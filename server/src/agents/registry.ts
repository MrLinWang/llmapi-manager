import os from 'node:os';
import path from 'node:path';
import type { AgentDefinition, AgentFileRole, AgentId } from '../domain/agent';

export const AGENT_DEFINITIONS: Record<AgentId, AgentDefinition> = {
  codex: {
    id: 'codex',
    name: 'Codex CLI',
    // 描述只存键：registry 是模块级静态数据，构造时没有请求语言。
    // 渲染发生在路由层（见 routes/agents.ts 的 GET /api/agents）。
    descriptionKey: 'agents.description.codex',
    homeDirName: '.codex',
    files: [
      { role: 'config', relativePath: 'config.toml', format: 'toml' },
      { role: 'auth', relativePath: 'auth.json', format: 'json' },
      // 模型目录：Codex 的模型切换列表读它。虽然我们也写了 model_catalog_url 指向网关
      // /v1/models，但 config.toml 顶层给了 model_catalog_json 时 Codex 直接用这份静态
      // 目录（StaticModelsManager），不再去拉远程列表。内容整体由我们生成 → generated=true。
      { role: 'catalog', relativePath: 'llmapi-model-catalog.json', format: 'json', generated: true },
    ],
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    descriptionKey: 'agents.description.claudeCode',
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

  resolve(agentId: AgentId, input: ResolveInput, role: AgentFileRole): string {
    const definition = AGENT_DEFINITIONS[agentId];
    const spec = definition.files.find((item) => item.role === role);
    if (!spec) throw new Error(`Agent ${agentId} does not declare a ${role} file`);
    return path.join(this.agentRoot(agentId, input), spec.relativePath);
  }
}
