import type { FastifyRequest } from 'fastify';
import type { Principal } from '../domain/identity';
import { translate } from '../i18n';
import type { Store } from '../store/tenantScope';
import type { Logger } from '../logger';
import { DEFAULT_TENANT_ID } from '../domain/identity';
import {
  hashApiToken,
  parseBearerToken,
  shouldUpdateLastUsed,
  verifyApiToken,
} from './apiToken';

/**
 * 用 API 令牌解析 Principal，供 `/api/*` 管理面使用。
 *
 * 与网关令牌（`/v1/*`）是完全独立的一条鉴权路径：那条只证明"可以转发推理请求"，
 * 这条要证明"可以调管理接口"。两者的校验、权限模型、存储都不共用。
 *
 * `tenantId` 取自令牌记录本身，而不是请求方声明——请求方说自己属于哪个租户不算数。
 */
export function resolvePrincipalFromApiToken(
  request: FastifyRequest,
  store: Store,
  logger: Logger,
): Principal | null {
  const token = parseBearerToken(request.headers.authorization);
  if (!token) return null;

  // 令牌按租户分文件存放，鉴权时还不知道属于哪个租户。
  // 当前只有默认租户，所以直接查它；做多租户时需要一张全局 hash → tenant 索引，
  // 否则必须遍历所有租户（见 docs/security.md 的说明）。
  const repo = store.forTenant(DEFAULT_TENANT_ID).apiTokens;

  const record = repo.findByHash(hashApiToken(token));
  if (!record || !verifyApiToken(token, record)) {
    // 对外一律 401，但内部记一条 warn：区分"不存在"与"已失效"能让用户
    // 从日志看出"令牌被吊销了"还是"根本找错地方了"。
    if (record) {
      logger.warn(
        'logs.tokens.invalidated',
        {
          prefix: record.prefix,
          tail: record.tail,
          reason: translate(
            'zh',
            record.revokedAt ? 'logs.tokens.revoked' : 'logs.tokens.expired',
          ),
        },
      );
    }
    return null;
  }

  // lastUsedAt 节流更新，失败不影响请求——它只是展示信息
  if (shouldUpdateLastUsed(record)) {
    try {
      repo.saveAll(
        repo
          .list()
          .map((item) =>
            item.id === record.id ? { ...item, lastUsedAt: new Date().toISOString() } : item,
          ),
      );
    } catch (error) {
      logger.warn('logs.tokens.lastUsedUpdateFailed', error);
    }
  }

  return {
    // 令牌背后没有"某个真人在操作"，但审计需留痕：记创建者，
    // 同时用 via 标明这不是本人会话（据此可拒绝改口令等敏感操作）。
    userId: record.createdBy,
    tenantId: record.tenantId,
    // 角色给最小 member：真正的判定走 scopes，role 只在 scopes 缺席时才生效，
    // 而令牌一定有 scopes（空数组在 verifyApiToken 里已被拒绝）。
    role: 'member',
    via: 'api-token',
    scopes: record.scopes,
  };
}
