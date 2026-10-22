import path from 'node:path';

/**
 * 所有落盘路径的唯一来源。路由与服务层不得自行拼接 data 目录。
 * 多租户的隔离边界就是 data/tenants/<tenantId>/ 这一层。
 */
export class StorePaths {
  constructor(readonly dataDir: string) {}

  get identityFile(): string {
    return path.join(this.dataDir, 'identity.json');
  }

  get instanceFile(): string {
    return path.join(this.dataDir, 'instance.json');
  }

  tenantDir(tenantId: string): string {
    return path.join(this.dataDir, 'tenants', tenantId);
  }

  settingsFile(tenantId: string): string {
    return path.join(this.tenantDir(tenantId), 'settings.json');
  }

  providersFile(tenantId: string): string {
    return path.join(this.tenantDir(tenantId), 'providers.json');
  }

  agentsFile(tenantId: string): string {
    return path.join(this.tenantDir(tenantId), 'agents.json');
  }

  requestLogFile(tenantId: string): string {
    return path.join(this.tenantDir(tenantId), 'requests.jsonl');
  }

  backupsDir(tenantId: string, agentId: string): string {
    return path.join(this.tenantDir(tenantId), 'backups', agentId);
  }
}
