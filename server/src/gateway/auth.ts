import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context';
import type { Principal } from '../domain/identity';
import { hashGatewayToken, tokenMatches } from './token';

function extractToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null;
  }
  const apiKey = request.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim() !== '') return apiKey.trim();
  return null;
}

/**
 * 网关令牌 → Principal。
 * 令牌哈希按租户保存，所以需要遍历租户查找归属（租户数量极少）。
 * 命中后返回 member 角色：只有网关消费能力，不能碰管理接口。
 */
export function resolveGatewayPrincipal(
  request: FastifyRequest,
  ctx: AppContext,
): Principal | null {
  const token = extractToken(request);
  if (!token) return null;

  const identity = ctx.identity.read();
  for (const tenant of identity.tenants) {
    if (tenant.status !== 'active') continue;
    const settings = ctx.store.forTenant(tenant.id).settings.read();
    if (!tokenMatches(token, settings.gatewayToken)) continue;
    return {
      userId: settings.gatewayToken?.createdBy ?? 'gateway',
      tenantId: tenant.id,
      role: 'member',
      via: 'gateway-token',
    };
  }
  return null;
}

export function tokenFingerprint(token: string): string {
  return hashGatewayToken(token).slice(0, 12);
}
