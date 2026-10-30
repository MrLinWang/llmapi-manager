import { translate } from './i18n';
import { loadConfig, type AppConfig } from './config';
import { createLogger, logFilePath, type FileLogOptions, type Logger } from './logger';
import { createContext } from './context';
import { bootstrapIdentity } from './bootstrap';
import { buildApp } from './app';
import { getWarnings } from './resilience';

function fileLogOptions(config: AppConfig): FileLogOptions | undefined {
  if (!config.logDir) return undefined;
  return {
    dir: config.logDir,
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logOptions = fileLogOptions(config);
  const logger = createLogger(config.logLevel, {
    file: logOptions,
    language: config.logLanguage,
  });
  const ctx = createContext(config, logger);

  const { needsSetup, setupToken } = await bootstrapIdentity(
    config,
    ctx.paths,
    ctx.identity,
    logger,
    ctx.setup,
  );

  const app = await buildApp({ ctx });
  await app.listen({ host: config.host, port: config.port });

  const address = `${config.publicBaseUrl}`;
  logger.info('logs.startup.banner', {
    console: `http://${config.host}:${config.port}`,
    gateway: `${address}/v1`,
    dataDir: config.dataDir,
    logFile: logOptions ? logFilePath(logOptions) : '(console only)',
  });

  if (needsSetup && setupToken) {
    // 一次性初始化令牌：只在"首次生成"的那次启动打印，且不写进日志文件
    console.log('');
    console.log('============================================================');
    const banner = (key: string, params?: Record<string, string>): void =>
      console.log(`  ${translate(config.logLanguage, `logs.startup.${key}`, params)}`);
    banner('setupTokenTitle');
    banner('setupTokenOpen', { url: config.publicBaseUrl });
    console.log('');
    banner('setupTokenLabel');
    console.log(`  ${setupToken}`);
    console.log('');
    banner('setupTokenNote');
    banner('setupTokenMissing');
    banner('setupTokenReset');
    console.log('============================================================');
    console.log('');
  } else if (needsSetup) {
    logger.warn('logs.startup.setupPending');
  }

  if (config.sessionSecretGenerated) {
    logger.info('logs.startup.sessionSecretGenerated', { file: ctx.paths.instanceFile });
  }
  if (!config.encryptionKey) {
    logger.warn('logs.startup.noEncryptionKey');
  }

  for (const warning of getWarnings()) {
    logger.warn('logs.startup.warningLine', { code: warning.code, message: warning.message });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('logs.startup.shuttingDown', { signal });
    await app.close();
    logger.close?.();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows 上 Ctrl+Break / 关闭控制台窗口走 SIGBREAK；不注册的话 Node 默认直接退出，
  // 正在写的日志与 JSON 落盘没有机会收尾。非 Windows 平台没有这个信号，注册也无意义。
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  }
}

/**
 * 启动失败时也要落日志：此时 logger 可能还没建好（loadConfig 就可能抛），
 * 因此尽力构造一个文件日志；失败则退回 console.error。
 */
function reportFatal(error: unknown): void {
  let logger: Logger | undefined;
  try {
    const config = loadConfig();
    logger = createLogger('error', { file: fileLogOptions(config), language: config.logLanguage });
  } catch {
    logger = undefined;
  }
  if (logger) {
    logger.error('logs.startup.failed', error);
    logger.close?.();
    return;
  }
  console.error('startup failed:', error);
}

main().catch((error) => {
  reportFatal(error);
  process.exit(1);
});
