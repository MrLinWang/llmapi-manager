import { enAgents } from './agents';
import { enAuth } from './auth';
import { enDiagnostics } from './diagnostics';
import { enErrors } from './errors';
import { enGateway } from './gateway';
import { enProviders } from './providers';
import { enSettings } from './settings';
import { enTokens } from './tokens';
import { enLogs } from './logs';
import { enWarnings } from './warnings';

/** 服务端英文字典。各区域声明成 `typeof zhXxx`，漏键编译不过。 */
export const en = {
  errors: enErrors,
  gateway: enGateway,
  diagnostics: enDiagnostics,
  providers: enProviders,
  agents: enAgents,
  auth: enAuth,
  tokens: enTokens,
  settings: enSettings,
  warnings: enWarnings,
  logs: enLogs,
};
