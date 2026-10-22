import { loadConfig } from './config';
import { createLogger } from './logger';
import { createContext } from './context';
import { bootstrapIdentity } from './bootstrap';
import { buildApp } from './app';
import { getWarnings } from './resilience';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const ctx = createContext(config, logger);

  const { initialPassword } = await bootstrapIdentity(
    config,
    ctx.paths,
    ctx.identity,
    logger,
  );

  const app = await buildApp({ ctx });
  await app.listen({ host: config.host, port: config.port });

  const address = `${config.publicBaseUrl}`;
  logger.info('LLM API Manager 已启动', {
    console: `http://${config.host}:${config.port}`,
    gateway: `${address}/v1`,
    dataDir: config.dataDir,
  });

  if (initialPassword) {
    // 只在首次创建账号时打印一次，且不写日志文件
    console.log('');
    console.log('============================================================');
    console.log('  初始管理员账号');
    console.log(`  用户名: ${config.adminUsername}`);
    console.log(`  口  令: ${initialPassword}`);
    console.log('  该口令只显示这一次，请立即保存并在登录后修改。');
    console.log('============================================================');
    console.log('');
  }

  if (config.sessionSecretGenerated) {
    logger.info(`已生成会话签名密钥并保存到 ${ctx.paths.instanceFile}`);
  }
  if (!config.encryptionKey) {
    logger.warn(
      '未设置 DATA_ENCRYPTION_KEY：供应商 API Key 与网关令牌将以明文保存在 data 目录。',
    );
  }

  for (const warning of getWarnings()) {
    logger.warn(`启动告警 [${warning.code}] ${warning.message}`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`收到 ${signal}，正在关闭服务`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('启动失败：', error);
  process.exit(1);
});
