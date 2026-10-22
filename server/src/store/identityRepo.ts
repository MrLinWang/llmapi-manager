import type { Logger } from '../logger';
import { createJsonFile } from './jsonFile';
import type { IdentityData } from '../domain/identity';
import type { StorePaths } from './paths';

export interface IdentityRepo {
  read(): IdentityData;
  write(data: IdentityData): void;
}

export function createIdentityRepo(paths: StorePaths, logger?: Logger): IdentityRepo {
  const file = createJsonFile<IdentityData>({
    filePath: paths.identityFile,
    schemaVersion: 1,
    defaultValue: () => ({ tenants: [], users: [] }),
    logger,
  });
  return {
    read: () => {
      const data = file.read();
      return {
        tenants: Array.isArray(data?.tenants) ? data.tenants : [],
        users: Array.isArray(data?.users) ? data.users : [],
      };
    },
    write: (data) => file.write(data),
  };
}
