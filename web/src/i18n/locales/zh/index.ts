import { zhApp } from './app';
import { zhCommon } from './common';
import { zhLabels } from './labels';
import { zhLogin } from './login';
import { zhSetup } from './setup';
import { zhOverview } from './overview';
import { zhProviders } from './providers';
import { zhProviderForm } from './providerForm';
import { zhModels } from './models';
import { zhAgents } from './agents';
import { zhSettings } from './settings';
import { zhTokens } from './tokens';
import { zhSync } from './sync';

/**
 * 简体中文字典（键的唯一来源）。
 *
 * 按区域拆文件而不是一个大 JSON：一个页面改文案只动自己的文件，review 与合并都更小；
 * 同时 `web/src/i18n/index.ts` 里仍合成单一的 `translation` 命名空间，
 * 因此 `t('providers.title')` 这种写法不受拆分影响。
 *
 * 区域前缀（`app` / `common` / `labels` / 各页面）就是键的第一段，
 * 新增区域时这里与 `locales/en/index.ts` 各加一行。
 */
export const zh = {
  app: zhApp,
  common: zhCommon,
  labels: zhLabels,
  login: zhLogin,
  setup: zhSetup,
  overview: zhOverview,
  providers: zhProviders,
  providerForm: zhProviderForm,
  models: zhModels,
  agents: zhAgents,
  settings: zhSettings,
  tokens: zhTokens,
  sync: zhSync,
};
