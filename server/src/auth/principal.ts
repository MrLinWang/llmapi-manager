import type { FastifyRequest } from 'fastify';
import { SESSION_COOKIE, verifySession } from './session';
import type { Principal } from '../domain/identity';
import type { IdentityRepo } from '../store/identityRepo';

/**
 * 从会话 Cookie 解析 Principal。
 * 每次请求都回表核对用户状态与 authVersion：改口令、停用账号后旧会话立即失效。
 */
export function resolvePrincipalFromSession(
  request: FastifyRequest,
  secret: string,
  identityRepo: IdentityRepo,
): Principal | null {
  const token = request.cookies?.[SESSION_COOKIE];
  const session = verifySession(secret, token);
  if (!session) return null;

  const data = identityRepo.read();
  const user = data.users.find((item) => item.id === session.userId);
  if (!user || user.status !== 'active') return null;
  if (user.tenantId !== session.tenantId) return null;
  if (user.authVersion !== session.authVersion) return null;
  if (user.role !== session.role) return null;

  const tenant = data.tenants.find((item) => item.id === user.tenantId);
  if (!tenant || tenant.status !== 'active') return null;

  return {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    via: 'session',
  };
}
