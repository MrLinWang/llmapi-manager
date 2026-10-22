import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GatewayTokenMeta, TenantSettings } from '../domain/settings';
import type { SecretCodec } from '../crypto/secretCodec';

const TOKEN_PREFIX = 'lmm_';

export function hashGatewayToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createGatewayTokenMeta(
  tenantId: string,
  createdBy: string,
  secrets: SecretCodec,
): { token: string; meta: GatewayTokenMeta } {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  return {
    token,
    meta: {
      tokenHash: hashGatewayToken(token),
      tokenCipher: secrets.encode(token),
      prefix: token.slice(0, 8),
      tail: token.slice(-4),
      createdAt: new Date().toISOString(),
      tenantId,
      createdBy,
    },
  };
}

export function tokenMatches(token: string, meta: GatewayTokenMeta | null): boolean {
  if (!meta) return false;
  const expected = Buffer.from(meta.tokenHash, 'hex');
  const actual = Buffer.from(hashGatewayToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 仅用于下发 Agent 配置，不得出现在任何 HTTP 响应里。 */
export function revealGatewayToken(
  meta: GatewayTokenMeta | null,
  secrets: SecretCodec,
): string | null {
  if (!meta) return null;
  const token = secrets.decode(meta.tokenCipher);
  return token === '' ? null : token;
}

export function viewTokenMeta(settings: TenantSettings): {
  exists: boolean;
  prefix?: string;
  tail?: string;
  masked?: string;
  createdAt?: string;
} {
  const meta = settings.gatewayToken;
  if (!meta) return { exists: false };
  return {
    exists: true,
    prefix: meta.prefix,
    tail: meta.tail,
    masked: `${meta.prefix}${'*'.repeat(12)}${meta.tail}`,
    createdAt: meta.createdAt,
  };
}
