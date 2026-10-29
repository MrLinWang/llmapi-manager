import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { badRequest } from '../http/errors';
import { NetworkingRuntime, type NetworkingIdentityStore } from '../networking/runtime';
import { defaultNetworkingConfig } from '../domain/networking';

/** 把落盘的密文密钥解得明文再交给原生模块。对外一律不返回明文。 */
function readConfig(repos: TenantRepos, secrets: AppContext['secrets']) {
  const stored = repos.settings.read().networking ?? defaultNetworkingConfig();
  return {
    ...stored,
    // 存储形态是密文；原生模块需要明文
    networkSecret: stored.networkSecret ? secrets.decode(stored.networkSecret) : '',
  };
}

/** 对外视图：密钥打码，只留末尾 4 位用于确认"是不是我设的那个"。 */
function toView(config: ReturnType<typeof readConfig>) {
  const secret = config.networkSecret;
  return {
    ...config,
    networkSecret: secret === '' ? '' : `${'*'.repeat(Math.max(0, secret.length - 4))}${secret.slice(-4)}`,
    networkSecretSet: secret !== '',
  };
}

/**
 * 组网身份的持久化实现：落在 `identity.json` 的 `networkingIdentity` 字段。
 *
 * 私钥用 `ctx.secrets.encode()` 加密——它是网络的准入门槛之一（知道它 +
 * 网络密钥就能冒充本机），不能明文落盘。读取时解不开（换了
 * `DATA_ENCRYPTION_KEY`）就返回 null 并重新生成，同时留日志：此时对端
 * 的钉扎必然失效，用户需要知道原因。
 */
function buildIdentityStore(ctx: AppContext): NetworkingIdentityStore {
  return {
    load: () => {
      const data = ctx.store.identity.read();
      const stored = data.networkingIdentity;
      if (stored === undefined) return null;
      try {
        return {
          peerId: stored.peerId,
          staticPrivateKeyBase64: ctx.secrets.decode(stored.staticPrivateKeyEnc),
        };
      } catch (cause) {
        ctx.logger.warn('组网身份的私钥解不开（DATA_ENCRYPTION_KEY 可能已更换），将重新生成', cause);
        return null;
      }
    },
    save: (identity) => {
      const data = ctx.store.identity.read();
      ctx.store.identity.write({
        ...data,
        networkingIdentity: {
          peerId: identity.peerId,
          staticPrivateKeyEnc: ctx.secrets.encode(identity.staticPrivateKeyBase64),
        },
      });
    },
  };
}

export function registerNetworkingRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  // 每台机器一个稳定的组网身份，跨重启不变
  const runtime = new NetworkingRuntime(ctx.logger, buildIdentityStore(ctx));

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/networking/status', access: 'settings:read' },
    async () => {
      const config = readConfig(repos, ctx.secrets);
      return {
        config: toView(config),
        status: await runtime.status(config),
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/networking/peers', access: 'settings:read' },
    async () => ({ peers: await runtime.peers() }),
  );

  defineRoute(
    app,
    registry,
    { method: 'PATCH', url: '/api/networking/config', access: 'settings:write' },
    async (request) => {
      const body = (request.body ?? {}) as {
        engine?: unknown;
        enabled?: unknown;
        networkName?: unknown;
        networkSecret?: unknown;
        peers?: unknown;
        hostname?: unknown;
        ipv4?: unknown;
        listenPort?: unknown;
      };
      const settings = repos.settings.read();
      const current = readConfig(repos, ctx.secrets);
      const next = { ...current };

      if (body.engine !== undefined) {
        if (body.engine !== 'builtin' && body.engine !== 'native') {
          throw badRequest('networking.engine.invalid');
        }
        // 切引擎必须重启组网才生效；这里只落配置，不改运行中的实例
        next.engine = body.engine;
      }
      if (body.listenPort !== undefined) {
        const port = body.listenPort;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw badRequest('networking.listenPort.invalid');
        }
        next.listenPort = port;
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw badRequest('networking.enabled.mustBeBoolean');
        next.enabled = body.enabled;
      }
      if (body.networkName !== undefined) {
        if (typeof body.networkName !== 'string' || body.networkName.trim() === '') {
          throw badRequest('networking.networkName.required');
        }
        next.networkName = body.networkName.trim();
      }
      if (body.networkSecret !== undefined) {
        if (typeof body.networkSecret !== 'string') throw badRequest('networking.networkSecret.mustBeString');
        // 前端提交打码值时表示"不修改"——否则用户一保存就会把密钥改成星号
        if (!body.networkSecret.includes('*')) {
          next.networkSecret = body.networkSecret;
        }
      }
      if (body.peers !== undefined) {
        if (!Array.isArray(body.peers) || body.peers.some((p) => typeof p !== 'string')) {
          throw badRequest('networking.peers.mustBeStringArray');
        }
        next.peers = body.peers.map((p) => (p as string).trim()).filter((p) => p !== '');
      }
      if (body.hostname !== undefined) {
        if (typeof body.hostname !== 'string' || body.hostname.trim() === '') {
          throw badRequest('networking.hostname.required');
        }
        next.hostname = body.hostname.trim();
      }
      if (body.ipv4 !== undefined) {
        if (body.ipv4 === null || body.ipv4 === '') {
          next.ipv4 = null;
        } else if (typeof body.ipv4 !== 'string') {
          throw badRequest('networking.ipv4.mustBeStringOrNull');
        } else {
          next.ipv4 = body.ipv4.trim();
        }
      }

      // 落盘时加密密钥。空字符串保持为空，避免把空串也加密成一串密文
      repos.settings.write({
        ...settings,
        networking: {
          ...next,
          networkSecret: next.networkSecret ? ctx.secrets.encode(next.networkSecret) : '',
        },
        updatedAt: new Date().toISOString(),
      });
      return { config: toView(next) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/networking/start', access: 'settings:write' },
    async () => {
      const config = readConfig(repos, ctx.secrets);
      if (!config.enabled) {
        throw badRequest('networking.start.needEnable');
      }
      await runtime.start(config);
      return { status: await runtime.status(config) };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'POST', url: '/api/networking/stop', access: 'settings:write' },
    async () => {
      const config = readConfig(repos, ctx.secrets);
      await runtime.stop();
      return { status: await runtime.status(config) };
    },
  );
}
