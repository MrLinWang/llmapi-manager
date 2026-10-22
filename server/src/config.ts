import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  host: string;
  port: number;
  /** 写进 Agent 配置的网关地址（不带 /v1） */
  publicBaseUrl: string;
  dataDir: string;
  webDistDir: string;
  adminUsername: string;
  adminPassword: string | undefined;
  sessionSecret: string;
  sessionSecretGenerated: boolean;
  encryptionKey: string | undefined;
  logLevel: LogLevel;
  /**
   * Agent 配置文件的根目录（其下是 .codex/.claude）。
   * 默认取当前 OS 用户家目录；测试或多租户场景可覆盖。
   */
  agentHomeDir: string | undefined;
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * 依次读取进程 cwd 与仓库根目录的 .env，先读到的值优先。
 *
 * npm workspaces 执行脚本时 cwd 是 server/，而 README 约定的 .env 在仓库根目录，
 * 因此需要回退到模块上两级目录（server/src 与 server/dist 均成立）。
 * 两处都存在时 server/.env 覆盖仓库根的 .env；进程环境变量始终优先。
 */
function readEnvFile(): void {
  const candidates = new Set([
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ]);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    applyEnvFile(fs.readFileSync(file, 'utf8'));
  }
}

function applyEnvFile(content: string): void {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 会话密钥必须跨重启稳定，否则每次重启都会把已登录会话踢下线。
 * 未通过环境变量提供时，生成一次并落到数据目录。
 */
function resolveSessionSecret(dataDir: string): {
  secret: string;
  generated: boolean;
} {
  const fromEnv = optionalEnv('SESSION_SECRET');
  if (fromEnv) return { secret: fromEnv, generated: false };

  const file = path.join(dataDir, 'instance.json');
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        sessionSecret?: string;
      };
      if (typeof parsed.sessionSecret === 'string' && parsed.sessionSecret.length >= 32) {
        return { secret: parsed.sessionSecret, generated: false };
      }
    }
  } catch {
    // 文件损坏时重新生成，instance.json 只是可重建的实例本地状态
  }

  const secret = randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ sessionSecret: secret }, null, 2), {
    mode: 0o600,
  });
  return { secret, generated: true };
}

export function loadConfig(): AppConfig {
  readEnvFile();

  const dataDir = path.resolve(
    process.cwd(),
    optionalEnv('DATA_DIR') ?? process.env.DATA_DIR?.trim() ?? 'data',
  );
  fs.mkdirSync(dataDir, { recursive: true });

  const { secret, generated } = resolveSessionSecret(dataDir);

  const level = (optionalEnv('LOG_LEVEL') ?? 'info') as LogLevel;
  const port = Number.parseInt(optionalEnv('PORT') ?? '8787', 10);
  const host = optionalEnv('HOST') ?? '127.0.0.1';
  const resolvedPort = Number.isFinite(port) ? port : 8787;
  // 下发给 Agent 的地址：优先显式配置，否则按监听地址推导（0.0.0.0 对客户端无意义，回落本机）
  const publicBaseUrl =
    optionalEnv('PUBLIC_BASE_URL')?.replace(/\/+$/, '') ??
    `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${resolvedPort}`;

  return {
    host,
    port: resolvedPort,
    publicBaseUrl,
    dataDir,
    webDistDir: path.resolve(__dirname, '..', '..', 'web', 'dist'),
    adminUsername: optionalEnv('ADMIN_USERNAME') ?? 'owner',
    adminPassword: optionalEnv('ADMIN_PASSWORD'),
    sessionSecret: secret,
    sessionSecretGenerated: generated,
    encryptionKey: optionalEnv('DATA_ENCRYPTION_KEY'),
    logLevel: LOG_LEVELS.includes(level) ? level : 'info',
    agentHomeDir: optionalEnv('AGENT_HOME_DIR'),
  };
}
