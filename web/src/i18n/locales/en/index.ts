import { enApp } from './app';
import { enCommon } from './common';
import { enLabels } from './labels';
import { enLogin } from './login';
import { enSetup } from './setup';
import { enOverview } from './overview';
import { enProviders } from './providers';
import { enProviderForm } from './providerForm';
import { enModels } from './models';
import { enAgents } from './agents';
import { enSettings } from './settings';
import { enTokens } from './tokens';

/**
 * 英文字典。
 *
 * 每个区域的 `en*` 都声明成 `typeof zh*`，因此**漏译或多键会直接编译失败**，
 * 不需要靠人工比对两份文件。这是英文侧唯一的完整性保证渠道，别把这层类型去掉。
 */
export const en = {
  app: enApp,
  common: enCommon,
  labels: enLabels,
  login: enLogin,
  setup: enSetup,
  overview: enOverview,
  providers: enProviders,
  providerForm: enProviderForm,
  models: enModels,
  agents: enAgents,
  settings: enSettings,
  tokens: enTokens,
};
