import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import type { AppContext } from './context';
import { RouteRegistry } from './http/routeRegistry';
import { registerApiGuard, defineRoute } from './http/guard';
import { AppError } from './http/errors';
import { resolveRequestLanguage, resolveAnonymousLanguage } from './i18n/language';
import { translate } from './i18n';
import { getWarningsFor } from './resilience';
import { ProviderService } from './services/providers';
import { registerAuthRoutes } from './routes/auth';
import { registerProviderRoutes } from './routes/providers';
import { registerModelRoutes } from './routes/models';
import { registerLogRoutes } from './routes/logs';
import { registerAgentRoutes } from './routes/agents';
import { registerApiTokenRoutes } from './routes/apiTokens';
import { registerApiInfoRoutes } from './routes/apiInfo';
import { registerDiagnosticsRoutes } from './routes/diagnostics';
import { registerSyncRoutes } from './routes/sync';
import { registerNetworkingRoutes } from './routes/networking';
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
    // 只信任来自本机回环的 X-Forwarded-* 头（nginx 回源的常态）。
    // **不能设成 true**：那会让任何客户端伪造 `X-Forwarded-Proto: https`，
    // 从而绕过下面的 HTTPS 检查——同步快照里是上游 Key 的明文。
    trustProxy: ctx.config.trustProxy,
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
    // 语言按"租户设置 → Accept-Language → 中文"解析（见 i18n/language.ts）。
    // 日志仍固定中文：日志是给部署者排查看的，不该随请求语言变化，
    // 否则同一故障在不同客户端下会长得不一样、难以 grep。
    const language = resolveRequestLanguage(request, ctx);

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        ctx.logger.error('logs.app.apiError', {
          method: request.method,
          url: request.url,
          code: error.code,
          message: error.message,
        });
      }
      reply.code(error.statusCode).send(error.toBody(language));
      return;
    }
    // Fastify 自己的校验错误（schema 不匹配、JSON 解析失败）：
    // 文案由框架产生、无法本地化，原样透传比硬翻译更诚实。
    if ((error as { validation?: unknown }).validation) {
      reply.code(400).send({
        error: { code: 'bad_request', message: error.message, messageKey: 'errors.framework' },
      });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 400) {
      reply.code(400).send({
        error: { code: 'bad_request', message: error.message, messageKey: 'errors.framework' },
      });
      return;
    }
    ctx.logger.error('logs.app.unhandled', { method: request.method, url: request.url });
    const key = 'errors.internal';
    reply.code(500).send({
      error: {
        code: 'internal_error',
        message: translate(language, key),
        messageKey: key,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/v1/')) {
      const key = 'errors.apiRouteMissing';
      const params = { method: request.method, url: request.url };
      reply.code(404).send({
        error: {
          code: 'not_found',
          message: translate(resolveAnonymousLanguage(request), key, params),
          messageKey: key,
          details: params,
        },
      });
      return;
    }
    // SPA fallback：非接口路径交给前端路由
    const indexPath = `${ctx.config.webDistDir}/index.html`;
    if (fs.existsSync(indexPath)) {
      reply.type('text/html').send(fs.readFileSync(indexPath));
      return;
    }
    // 走到这里说明 `web/dist` 不存在：这是部署事故，且**只有打开浏览器的人会看到**，
    // 所以要本地化。它不经过错误处理器（SPA 兜底是独立的 notFoundHandler）。
    const key = 'errors.frontendNotBuilt';
    reply.code(404).send({
      error: {
        code: 'not_found',
        message: translate(resolveAnonymousLanguage(request), key),
        messageKey: key,
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
    // 告警在收集时只有"键 + 参数"，这里按请求语言渲染：它会显示在控制台顶栏，
    // 而启动期拿不到 Request，只能延迟到响应阶段本地化。
    async (request) => ({
      ok: true,
      warnings: getWarningsFor(resolveRequestLanguage(request, ctx)),
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
  registerSyncRoutes(app, ctx, registry, repos);
  registerNetworkingRoutes(app, ctx, registry, repos);
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
