import type { Logger } from '../logger';
import type { ProvidersData, ProviderRecord } from '../domain/provider';
import type { TenantSettings } from '../domain/settings';
import { defaultTenantSettings } from '../domain/settings';
import type { AgentsData, AgentBindingState, AgentId } from '../domain/agent';
import { defaultAgentsData } from '../domain/agent';
import type { RequestLogRecord } from '../domain/requestLog';
import type { ApiTokenRecord } from '../domain/apiToken';
import { createJsonFile, appendJsonLine, readJsonLines, type JsonFile } from './jsonFile';
import type { StorePaths } from './paths';
import type { IdentityRepo } from './identityRepo';

export interface ProviderRepo {
  list(): ProviderRecord[];
  get(id: string): ProviderRecord | undefined;
  saveAll(providers: ProviderRecord[]): void;
}

export interface SettingsRepo {
  read(): TenantSettings;
  write(settings: TenantSettings): void;
}

export interface AgentRepo {
  read(): AgentsData;
  write(data: AgentsData): void;
  getBinding(agentId: AgentId): AgentBindingState | undefined;
  setBinding(binding: AgentBindingState): void;
  clearBinding(agentId: AgentId): void;
}

export interface ApiTokenRepo {
  list(): ApiTokenRecord[];
  get(id: string): ApiTokenRecord | undefined;
  /** 按 sha256 查找，供每次带令牌的请求使用 */
  findByHash(tokenHash: string): ApiTokenRecord | undefined;
  saveAll(tokens: ApiTokenRecord[]): void;
}

export interface RequestLogRepo {
  append(record: RequestLogRecord): void;
  recent(limit: number): RequestLogRecord[];
}

/** 绑定到某个租户的仓储集合。所有租户数据只能通过它访问。 */
export interface TenantRepos {
  readonly tenantId: string;
  readonly providers: ProviderRepo;
  readonly settings: SettingsRepo;
  readonly agents: AgentRepo;
  readonly requestLog: RequestLogRepo;
  readonly apiTokens: ApiTokenRepo;
}

export interface Store {
  readonly paths: StorePaths;
  readonly identity: IdentityRepo;
  forTenant(tenantId: string): TenantRepos;
}

export function createStore(
  paths: StorePaths,
  identity: IdentityRepo,
  logger: Logger,
): Store {
  const cache = new Map<string, TenantRepos>();

  const build = (tenantId: string): TenantRepos => {
    const providersFile: JsonFile<ProvidersData> = createJsonFile<ProvidersData>({
      filePath: paths.providersFile(tenantId),
      schemaVersion: 1,
      defaultValue: () => ({ providers: [] }),
      logger,
    });
    const settingsFile = createJsonFile<TenantSettings>({
      filePath: paths.settingsFile(tenantId),
      schemaVersion: 1,
      defaultValue: defaultTenantSettings,
      logger,
    });
    const agentsFile = createJsonFile<AgentsData>({
      filePath: paths.agentsFile(tenantId),
      schemaVersion: 1,
      defaultValue: defaultAgentsData,
      logger,
    });
    const logFile = paths.requestLogFile(tenantId);

    const providers: ProviderRepo = {
      list: () => providersFile.read().providers ?? [],
      get: (id) => (providersFile.read().providers ?? []).find((item) => item.id === id),
      saveAll: (next) => providersFile.write({ providers: next }),
    };

    const settings: SettingsRepo = {
      read: () => ({ ...defaultTenantSettings(), ...settingsFile.read() }),
      write: (next) => settingsFile.write(next),
    };

    const agents: AgentRepo = {
      read: () => {
        const data = agentsFile.read();
        return { bindings: data?.bindings ?? {} };
      },
      write: (data) => agentsFile.write(data),
      getBinding: (agentId) => (agentsFile.read().bindings ?? {})[agentId],
      setBinding: (binding) => {
        const data = agentsFile.read();
        data.bindings = { ...data.bindings, [binding.agentId]: binding };
        agentsFile.write(data);
      },
      clearBinding: (agentId) => {
        const data = agentsFile.read();
        const next = { ...data.bindings };
        delete next[agentId];
        agentsFile.write({ bindings: next });
      },
    };

    const apiTokensFile: JsonFile<{ tokens: ApiTokenRecord[] }> = createJsonFile({
      filePath: paths.apiTokensFile(tenantId),
      schemaVersion: 1,
      defaultValue: () => ({ tokens: [] }),
      logger,
    });

    const apiTokens: ApiTokenRepo = {
      list: () => apiTokensFile.read().tokens ?? [],
      get: (id) => (apiTokensFile.read().tokens ?? []).find((item) => item.id === id),
      findByHash: (tokenHash) =>
        (apiTokensFile.read().tokens ?? []).find((item) => item.tokenHash === tokenHash),
      saveAll: (next) => apiTokensFile.write({ tokens: next }),
    };

    const requestLog: RequestLogRepo = {
      append: (record) => appendJsonLine(logFile, record),
      recent: (limit) => readJsonLines<RequestLogRecord>(logFile, limit).reverse(),
    };

    return { tenantId, providers, settings, agents, requestLog, apiTokens };
  };

  return {
    paths,
    identity,
    forTenant(tenantId: string): TenantRepos {
      if (!tenantId) throw new Error('forTenant 需要显式 tenantId');
      const existing = cache.get(tenantId);
      if (existing) return existing;
      const created = build(tenantId);
      cache.set(tenantId, created);
      return created;
    },
  };
}
