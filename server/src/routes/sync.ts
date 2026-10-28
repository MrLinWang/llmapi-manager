import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import type { TenantRepos } from '../store/tenantScope';
import { defineRoute, getPrincipal } from '../http/guard';
import type { RouteRegistry } from '../http/routeRegistry';
import { badRequest, forbidden } from '../http/errors';
import { SyncSealedUnavailableError, SyncService } from '../services/sync';
import {
  SYNC_SCOPES,
  SYNC_SCOPE_LABELS,
  defaultSyncConfig,
  type SyncRole,
  type SyncScope,
} from '../domain/sync';
import { translate } from '../i18n';
import type { UiLanguage } from '../domain/settings';

const ROLES: readonly SyncRole[] = ['standalone', 'master', 'follower'];

function parseScopes(raw: unknown): SyncScope[] {
  if (!Array.isArray(raw)) throw badRequest('sync.scopes.mustBeArray');
  const out: SyncScope[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !(SYNC_SCOPES as readonly string[]).includes(item)) {
      throw badRequest('sync.scopes.unknown', {
        value: String(item),
        available: SYNC_SCOPES.join(', '),
      });
    }
    if (!out.includes(item as SyncScope)) out.push(item as SyncScope);
  }
  return out;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * 判断 Host 是否指向本机。
 *
 * 注意 Fastify 的 `request.hostname` **带端口**（`127.0.0.1:8787`），
 * 直接和 `127.0.0.1` 做相等比较会永远为 false——这个坑让回环访问被误拦过一次。
 * 所以先剥掉端口再比。
 */
function isLoopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.includes(bare);
}

/**
 * 校验一次请求是否走了加密链路。
 *
 * **必须看实际协议，不能看配置。** 早先的实现检查的是 `ctx.config.publicBaseUrl`
 * 这个字符串，有两个致命问题：
 * 1. 该值在未配置时由监听地址推导，`HOST=0.0.0.0` 会得到 `http://127.0.0.1:8787`，
 *    看起来是回环、于是被当成本机访问放行——而服务其实对外监听，明文请求照样能取走全部上游 Key。
 * 2. 即便显式配了 `https://…`，那也只是用户的自我声明，与实际链路是否加密无关。
 *
 * 现在改为读 `request.protocol`（Fastify 会按 `trustProxy` 决定是否采信
 * `X-Forwarded-Proto`）。上面 `app.ts` 里 `trustProxy` 只信任回环来源，
 * 因此外部客户端无法伪造该头绕过。
 */
function assertSecureTransport(request: FastifyRequest, ctx: AppContext): void {
  if (ctx.config.syncAllowInsecure) return;

  // 真正的本机访问允许明文：请求没有离开这台机器，不存在抓包面。
  // 判据取 Host 而不是 X-Forwarded-*，因为后者可被伪造。
  if (isLoopbackHost(request.hostname)) return;

  // 非回环访问必须能证明链路是加密的。两种可信证据：
  // 1. 请求本身是 https（TLS 由本进程终止）
  // 2. 显式信任反代（TRUST_PROXY=1）且反代声称是 https
  //
  // **为什么默认不信 (2) 的证据**：`X-Forwarded-Proto` 是普通请求头，
  // 任何能直连本服务的人都能自己加一个 `https`。只有部署者明确声明
  // "我前面确实有反代、并且它会覆盖这个头"（TRUST_PROXY=1）时才采信——
  // 此时 `trustProxy` 也只信任回环来源的转发头。
  //
  // 早先版本用 `publicBaseUrl` 配置值判断，那是纯自我声明，且默认推导值
  // （HOST=0.0.0.0 → http://127.0.0.1）会被当成"回环所以安全"，
  // 导致对外监听的服务明文就能取走全部上游 Key。
  if (ctx.config.trustProxy !== false && request.protocol === 'https') return;

  throw forbidden('sync.snapshot.mustUseHttps');
}

/**
 * 校验 follower 要连的 master 地址。
 *
 * 与上面的检查互补：上面管"我导出时链路是否加密"，这里管"我拉取时链路是否加密"。
 * 少了后者，follower 会把 master 的 API 令牌与拉回的明文 Key 走明文 HTTP 送出去。
 */
function assertMasterUrlAllowed(masterUrl: string, allowInsecure: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(masterUrl);
  } catch {
    throw badRequest('sync.masterUrl.invalid', { value: masterUrl });
  }
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') {
    throw badRequest('sync.masterUrl.mustBeHttp', { value: masterUrl });
  }
  if (isLoopbackHost(parsed.hostname)) return;
  if (allowInsecure) return;
  throw forbidden('sync.masterUrl.insecure', { value: masterUrl });
}

/**
 * 拼出"上次拉取结果"摘要。
 *
 * 这段文案会落进 `settings.sync.lastPullResult` 并显示在同步页的「上次结果」里，
 * 所以要走字典——不能直接拼中文，否则英文界面下会看到中文摘要。
 *
 * 语言取 `LOG_LANGUAGE` 之外的语言不存在：拉取是后台动作，没有"当前请求"的语境，
 * 这里用租户设置的语言（`resolveRequestLanguage` 需要 Request，不适用）。
 */
function buildPullSummary(input: {
  language: UiLanguage;
  applied: number;
  conflictCount: number;
  elapsedMs: number;
  masterChanged: boolean;
}): string {
  const parts: string[] = [];
  if (input.applied > 0) {
    parts.push(translate(input.language, 'sync.summary.applied', { count: input.applied }));
  }
  if (input.conflictCount > 0) {
    parts.push(
      translate(input.language, 'sync.summary.conflicts', { count: input.conflictCount }),
    );
  }
  if (parts.length === 0) parts.push(translate(input.language, 'sync.summary.unchanged'));

  let summary = parts.join('，');
  summary += translate(input.language, 'sync.summary.elapsed', { ms: input.elapsedMs });
  if (input.masterChanged) {
    summary += '。' + translate(input.language, 'sync.summary.masterChanged');
  }
  return summary;
}

export function registerSyncRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: RouteRegistry,
  repos: TenantRepos,
): void {
  const service = new SyncService(repos, ctx.secrets, ctx.config.instanceId);

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/sync/status', access: 'settings:read' },
    async () => {
      const config = service.readConfig();
      const conflicts = repos.syncConflicts.list();
      return {
        config,
        // 前端据此渲染勾选项，避免在两处维护范围清单与文案
        availableScopes: SYNC_SCOPES.map((scope) => ({
          scope,
          label: SYNC_SCOPE_LABELS[scope],
        })),
        conflictCount: conflicts.length,
        /** 明确告诉用户：登录口令与会话永远不同步 */
        neverSynced: ['登录口令', '会话 cookie', 'DATA_ENCRYPTION_KEY', '网关令牌'],
      };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'PATCH', url: '/api/sync/config', access: 'settings:write' },
    async (request) => {
      const body = (request.body ?? {}) as {
        role?: unknown;
        masterUrl?: unknown;
        scopes?: unknown;
      };
      const settings = repos.settings.read();
      const current = settings.sync ?? defaultSyncConfig();
      const next = { ...current };

      if (body.role !== undefined) {
        if (typeof body.role !== 'string' || !ROLES.includes(body.role as SyncRole)) {
          throw badRequest('sync.role.unknown', { available: ROLES.join(' / ') });
        }
        next.role = body.role as SyncRole;
      }

      if (body.masterUrl !== undefined) {
        if (body.masterUrl === null || body.masterUrl === '') {
          next.masterUrl = null;
        } else if (typeof body.masterUrl !== 'string') {
          throw badRequest('sync.masterUrl.mustBeStringOrNull');
        } else {
          // 去掉尾部斜杠，避免拼出双斜杠的接口地址
          next.masterUrl = body.masterUrl.trim().replace(/\/+$/, '');
          // 保存时就校验传输安全：等点"同步"才报错，用户会以为是网络问题
          assertMasterUrlAllowed(next.masterUrl, ctx.config.syncAllowInsecure);
        }
      }

      if (body.scopes !== undefined) next.scopes = parseScopes(body.scopes);

      // follower 必须有 master 地址，否则拉取时无从下手——在保存时就拦住，
      // 比等到点"同步"才报错更早暴露配置漏项
      if (next.role === 'follower' && !next.masterUrl) {
        throw badRequest('sync.masterUrl.requiredForFollower');
      }

      repos.settings.write({
        ...settings,
        sync: next,
        updatedAt: new Date().toISOString(),
      });
      return { config: next };
    },
  );

  /**
   * 导出快照（master 侧，供 follower 拉取）。
   *
   * 三个必须的防护，缺一不可：
   * 1. 独立权限 `sync:read`（不是 settings:*）——它能导出全部上游 Key 明文
   * 2. 强制 HTTPS（非回环时），否则明文凭据会进抓包范围
   * 3. `no-store` 且不记日志 body——响应体本身就是凭据
   */
  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/sync/snapshot', access: 'sync:read' },
    async (request, reply) => {
      const config = service.readConfig();
      if (config.role !== 'master') {
        throw badRequest('sync.role.mustBeMasterToExport');
      }

      assertSecureTransport(request, ctx);

      const query = request.query as { scopes?: string };
      const scopes = query.scopes ? parseScopes(query.scopes.split(',')) : config.scopes;

      // 空 scopes 表示"什么都不同步"，而不是"全部同步"。
      // 早先的实现把空数组当成全部范围——那等于"用户没勾选任何项，系统却擅自
      // 把全部上游 Key 导出"，是个危险的默认值。安全默认应当是什么都不做。
      if (scopes.length === 0) {
        throw badRequest('sync.scopes.emptyForExport');
      }

      const snapshot = service.exportSnapshot(scopes);

      // 响应体含明文凭据：禁止任何缓存层留存
      reply.raw.setHeader('cache-control', 'no-store');
      reply.raw.setHeader('pragma', 'no-cache');

      // 只记"谁导出了多少条"，绝不记内容
      const principal = getPrincipal(request);
      ctx.logger.info(
        // 审计留痕：这是唯一会把全部上游 Key 明文送出去的接口，
        // 必须能事后查出"谁、从哪、导了多少"。**不记内容**。
        `同步快照导出：by=${principal.userId} via=${principal.via} ` +
          `from=${request.ip} scopes=${scopes.join(',')} ` +
          `providers=${snapshot.providers?.length ?? 0} ` +
          `at=${snapshot.exportedAt}`,
      );

      return snapshot;
    },
  );

  /**
   * 主动拉取（follower 侧）。
   *
   * 由本机发起、用用户填的 API 令牌去调 master 的 snapshot 接口，
   * 再应用到本地。不走"master 推送"——推送需要 master 知道所有 follower 地址，
   * 那反而要求每个 follower 都对外可达，与"多设备互联"的初衷相反。
   */
  defineRoute(
    app,
    registry,
    // 用 sync:write 而不是 settings:write：拉取会把远端配置写进本地，
    // 与"改设置"是两件事，分开授权才能做到"给他改设置、但不许他拉同步"。
    { method: 'POST', url: '/api/sync/pull', access: 'sync:write' },
    async (request) => {
      const config = service.readConfig();
      if (config.role !== 'follower') {
        throw badRequest('sync.role.mustBeFollowerToPull');
      }
      if (!config.masterUrl) throw badRequest('sync.pull.noMasterUrl');
      // 保存时校验过，这里再校一次：配置可能是旧版本写入的，
      // 也可能 SYNC_ALLOW_INSECURE 在当前进程里被关掉了
      assertMasterUrlAllowed(config.masterUrl, ctx.config.syncAllowInsecure);

      const body = (request.body ?? {}) as { token?: unknown };
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!token.startsWith('api_')) {
        throw badRequest('sync.pull.tokenRequired');
      }

      // 与 snapshot 侧保持同一口径：空 scopes = 不同步，而不是全部
      const scopes = config.scopes;
      if (scopes.length === 0) {
        throw badRequest(
          'sync.scopes.emptyForPull',
        );
      }
      const url = `${config.masterUrl}/api/sync/snapshot?scopes=${scopes.join(',')}`;

      const startedAt = Date.now();
      let snapshot;
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          const text = await response.text();
          // 不要把整个响应体带进错误（可能是 master 的错误细节），只要前 200 字
          throw badRequest('sync.pull.badStatus', {
            status: response.status,
            // 只留前 200 字：整段响应可能是 master 的错误细节，可能很长
            reason: text.slice(0, 200) || '(empty response)',
          });
        }
        snapshot = (await response.json()) as Parameters<typeof service.applySnapshot>[0];
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'TimeoutError') {
          throw badRequest('sync.pull.timeout');
        }
        throw badRequest('sync.pull.failed', {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }

      const { applied, conflicts } = service.applySnapshot(snapshot);
      const masterChanged = service.takeMasterChanged();

      const settings = repos.settings.read();
      // 摘要会落进 `lastPullResult` 并显示在界面上，所以也要走字典。
      // 语言取租户设置：拉取是后台动作，没有「当前请求」的语境可用。
      const language = repos.settings.read().language ?? 'zh';
      const summary = buildPullSummary({
        language,
        applied,
        conflictCount: conflicts.length,
        elapsedMs: Date.now() - startedAt,
        masterChanged,
      });
      repos.settings.write({
        ...settings,
        sync: {
          ...settings.sync,
          lastPullAt: new Date().toISOString(),
          lastPullResult: summary,
          lastMasterId: snapshot.masterId,
        },
        updatedAt: new Date().toISOString(),
      });

      return { applied, conflicts, summary };
    },
  );

  defineRoute(
    app,
    registry,
    { method: 'GET', url: '/api/sync/conflicts', access: 'settings:read' },
    async () => ({
      // 剔除 `remoteValueSealed`：它是给服务端内部"选远端"时还原用的，
      // 前端并不需要（`SyncConflict` 类型里也没有这个字段）。留着它等于把
      // 一份可能是明文的凭据副本发给了只需 settings:read 的人。
      conflicts: repos.syncConflicts.list().map(({ remoteValueSealed: _sealed, ...rest }) => rest),
    }),
  );

  defineRoute(
    app,
    registry,
    {
      method: 'POST',
      url: '/api/sync/conflicts/:id/resolve',
      access: 'sync:write',
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { choice?: unknown };
      if (body.choice !== 'local' && body.choice !== 'remote') {
        throw badRequest('sync.conflict.choiceInvalid');
      }
      let ok: boolean;
      try {
        ok = service.resolveConflict(id, body.choice);
      } catch (cause) {
        // 区分"没有封存值"与"未知冲突"：前者要引导用户去配密钥，
        // 后者才是 id 写错了。混在一起说会让用户无从下手。
        if (cause instanceof SyncSealedUnavailableError) {
          throw badRequest(
            'sync.conflict.undecodable',
          );
        }
        throw cause;
      }
      if (!ok) throw badRequest('sync.conflict.unknown', { id });
      return { ok: true, conflictCount: repos.syncConflicts.list().length };
    },
  );
}
