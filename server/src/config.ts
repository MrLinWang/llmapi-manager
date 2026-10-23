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
   * 运行日志目录。为 undefined 时不落盘，只输出到控制台。
   * 默认是仓库根的 log/ —— 注意它刻意不放在 DATA_DIR 下：
   * 日志属于运行产物而非租户业务数据，数据目录整体迁移时不该被一起带走。
   */
  logDir: string | undefined;
  /** 单个日志文件的滚动阈值（字节） */
  logMaxBytes: number;
  /** 保留的滚动文件个数（不含当前写入的 app.log） */
  logMaxFiles: number;
  /**
   * 是否开放 `/api/diagnostics/*` 诊断接口。默认关闭，需显式设
   * `ENABLE_DIAGNOSTICS=1` 才开。
   *
   * 默认关闭的理由：这些接口会回显"转换后的上游请求体"，里面有用户 prompt 片段，
   * 还能发起真实上游调用。它不是日常运维需要的，而是排查"跨协议转发到底有没有生效"
   * 这类问题时临时打开的东西。默认开着等于给生产环境多一个探测面。
   */
  enableDiagnostics: boolean;
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

/**
 * 解析日志目录。
 * 默认落在仓库根的 log/（与 web/dist 用同一套 __dirname 推导，server/src 与 server/dist 都成立），
 * 这样 npm workspaces 把 cwd 切到 server/ 后，日志仍然只在一个固定位置。
 * `LOG_DIR=off`（或 none/空串的显式写法）可关闭落盘，只保留控制台输出。
 */
function resolveLogDir(repoRoot: string): string | undefined {
  const raw = optionalEnv('LOG_DIR');
  if (raw && ['off', 'none', 'false', '0'].includes(raw.toLowerCase())) return undefined;
  return path.resolve(repoRoot, raw ?? 'log');
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  const repoRoot = path.resolve(__dirname, '..', '..');
  // 下发给 Agent 的地址：优先显式配置，否则按监听地址推导（0.0.0.0 对客户端无意义，回落本机）
  const publicBaseUrl =
    optionalEnv('PUBLIC_BASE_URL')?.replace(/\/+$/, '') ??
    `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${resolvedPort}`;

  return {
    host,
    port: resolvedPort,
    publicBaseUrl,
    dataDir,
    webDistDir: path.resolve(repoRoot, 'web', 'dist'),
    adminUsername: optionalEnv('ADMIN_USERNAME') ?? 'admin',
    adminPassword: optionalEnv('ADMIN_PASSWORD'),
    sessionSecret: secret,
    sessionSecretGenerated: generated,
    encryptionKey: optionalEnv('DATA_ENCRYPTION_KEY'),
    logLevel: LOG_LEVELS.includes(level) ? level : 'info',
    logDir: resolveLogDir(repoRoot),
    logMaxBytes: positiveInt(optionalEnv('LOG_MAX_BYTES'), 5 * 1024 * 1024),
    logMaxFiles: positiveInt(optionalEnv('LOG_MAX_FILES'), 5),
    enableDiagnostics: optionalEnv('ENABLE_DIAGNOSTICS') === '1',
    agentHomeDir: optionalEnv('AGENT_HOME_DIR'),
  };
}
