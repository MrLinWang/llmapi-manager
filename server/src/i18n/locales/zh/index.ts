import { zhAgents } from './agents';
import { zhAuth } from './auth';
import { zhDiagnostics } from './diagnostics';
import { zhErrors } from './errors';
import { zhGateway } from './gateway';
import { zhProviders } from './providers';
import { zhSettings } from './settings';
import { zhTokens } from './tokens';
import { zhSync } from './sync';
import { zhNetworking } from './networking';
import { zhLogs } from './logs';
import { zhWarnings } from './warnings';

/**
 * 服务端简体中文字典（键的唯一来源）。
 *
 * 与前端一样按区域拆文件：一个区域改文案只动自己的文件。
 * 区域前缀就是键的第一段，新增区域时这里与 `en/index.ts` 各加一行。
 */
export const zh = {
  errors: zhErrors,
  gateway: zhGateway,
  diagnostics: zhDiagnostics,
  providers: zhProviders,
  agents: zhAgents,
  auth: zhAuth,
  tokens: zhTokens,
  sync: zhSync,
  networking: zhNetworking,
  settings: zhSettings,
  warnings: zhWarnings,
  logs: zhLogs,
};
