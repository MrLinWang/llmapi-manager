import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import type { AppContext } from './context';
import { RouteRegistry } from './http/routeRegistry';
import { registerApiGuard, defineRoute } from './http/guard';
import { AppError } from './http/errors';
import { getWarnings } from './resilience';
import { ProviderService } from './services/providers';
import { registerAuthRoutes } from './routes/auth';
import { registerProviderRoutes } from './routes/providers';
import { registerModelRoutes } from './routes/models';
import { registerLogRoutes } from './routes/logs';
import { registerAgentRoutes } from './routes/agents';
import { registerApiTokenRoutes } from './routes/apiTokens';
import { registerApiInfoRoutes } from './routes/apiInfo';
import { registerDiagnosticsRoutes } from './routes/diagnostics';
import { registerGatewayRoutes } from './routes/gateway';
import { DEFAULT_TENANT_ID } from './domain/identity';

export interface BuildAppOptions {
  ctx: AppContext;
  /** 测试时可注入外部 RouteRegistry */
  registry?: RouteRegistry;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { ctx } = options;
  const registry = options.registry ?? new RouteRegistry();

  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
    disableRequestLogging: true,
  });

  await app.register(cookie);

  // 很多客户端（含浏览器 fetch 的常见写法）会带 JSON 头但不带 body。
  // Fastify 默认对空 body 抛 400，这里把空 body 当作 {}，避免无意义的失败。
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (typeof body !== 'string' || body.trim() === '') {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        ctx.logger.error(`接口错误 ${request.method} ${request.url}`, {
          code: error.code,
          message: error.message,
        });
      }
      reply.code(error.statusCode).send(error.toBody());
      return;
    }
    if ((error as { validation?: unknown }).validation) {
      reply.code(400).send({
        error: { code: 'bad_request', message: error.message },
      });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      reply.code(400).send({
        error: { code: 'bad_request', message: error.message },
      });
      return;
    }
    ctx.logger.error(`未处理异常 ${request.method} ${request.url}`, error);
    reply.code(500).send({
      error: { code: 'internal_error', message: '服务端内部错误' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/v1/')) {
      reply.code(404).send({
        error: { code: 'not_found', message: `接口不存在：${request.method} ${request.url}` },
      });
      return;
    }
    // SPA fallback：非接口路径交给前端路由
    const indexPath = `${ctx.config.webDistDir}/index.html`;
    if (fs.existsSync(indexPath)) {
      reply.type('text/html').send(fs.readFileSync(indexPath));
      return;
    }
    reply.code(404).send({
      error: {
        code: 'not_found',
        message: '前端尚未构建，请执行 npm run build（开发模式请访问 Vite 端口）',
      },
    });
  });

  // 健康检查要先注册，且不经过 /api 鉴权钩子（路径为 /api/health，故 access=public）
  registerApiGuard(app, ctx, registry);

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/health', access: 'public' },
    // 这是 public 接口，**不能**返回 dataDir：那是本机绝对路径，
    // 等于把部署结构告诉任何扫到这个端口的人。需要路径请查日志或配置文档。
    async () => ({
      ok: true,
      warnings: getWarnings(),
      gatewayBaseUrl: `${ctx.config.publicBaseUrl}/v1`,
    }),
  );

  registerAuthRoutes(app, ctx, registry);

  // 本期只有默认租户；将来按 Principal 动态选择，路由层代码不需要改
  const repos = ctx.store.forTenant(DEFAULT_TENANT_ID);
  const providerService = new ProviderService(repos, ctx.secrets);

  registerProviderRoutes(app, ctx, registry, repos);
  registerModelRoutes(app, ctx, registry, repos);
  registerLogRoutes(app, ctx, registry, repos);
  registerAgentRoutes(app, ctx, registry, repos);
  registerApiTokenRoutes(app, ctx, registry, repos);
  registerApiInfoRoutes(app, ctx, registry, repos);
  registerDiagnosticsRoutes(app, ctx, registry, repos);
  registerGatewayRoutes(app, ctx, providerService);

  registry.assertAllDeclared();

  if (fs.existsSync(ctx.config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: ctx.config.webDistDir,
      prefix: '/',
      wildcard: false,
    });
  }

  return app;
}
