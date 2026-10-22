import type { AppConfig } from './config';
import type { Logger } from './logger';
import { StorePaths } from './store/paths';
import { createIdentityRepo, type IdentityRepo } from './store/identityRepo';
import { createStore, type Store } from './store/tenantScope';
import { createSecretCodec, type SecretCodec } from './crypto/secretCodec';

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  paths: StorePaths;
  identity: IdentityRepo;
  store: Store;
  secrets: SecretCodec;
}

export function createContext(config: AppConfig, logger: Logger): AppContext {
  const paths = new StorePaths(config.dataDir);
  const identity = createIdentityRepo(paths, logger);
  const store = createStore(paths, identity, logger);
  const secrets = createSecretCodec(config.encryptionKey);
  return { config, logger, paths, identity, store, secrets };
}
