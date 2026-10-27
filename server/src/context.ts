import type { AppConfig } from './config';
import { installCatalogs } from './i18n/install';
import type { Logger } from './logger';
import { StorePaths } from './store/paths';
import { createIdentityRepo, type IdentityRepo } from './store/identityRepo';
import { createStore, type Store } from './store/tenantScope';
import { createSetupRepo, type SetupRepo } from './store/setupRepo';
import { createSecretCodec, type SecretCodec } from './crypto/secretCodec';

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  paths: StorePaths;
  identity: IdentityRepo;
  /** 首次初始化状态（一次性 setup token 与完成标记） */
  setup: SetupRepo;
  store: Store;
  secrets: SecretCodec;
}

export function createContext(config: AppConfig, logger: Logger): AppContext {
  // 装载服务端文案字典（幂等）。放在这里而不是模块顶层：错误处理器、
  // 启动流程与测试都要保证"能翻译之前字典已在"，而 AppContext 是它们的共同入口。
  installCatalogs();
  const paths = new StorePaths(config.dataDir);
  const identity = createIdentityRepo(paths, logger);
  const setup = createSetupRepo(paths, logger);
  const store = createStore(paths, identity, logger);
  const secrets = createSecretCodec(config.encryptionKey);
  return { config, logger, paths, identity, setup, store, secrets };
}
