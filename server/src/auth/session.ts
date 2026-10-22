import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Principal } from '../domain/identity';

export interface SessionPayload {
  sid: string;
  userId: string;
  tenantId: string;
  role: Principal['role'];
  authVersion: number;
  exp: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'llmapi_session';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function issueSession(
  secret: string,
  input: Omit<SessionPayload, 'sid' | 'exp'> & { sid?: string },
): { token: string; payload: SessionPayload } {
  const payload: SessionPayload = {
    sid: input.sid ?? randomBytes(12).toString('base64url'),
    userId: input.userId,
    tenantId: input.tenantId,
    role: input.role,
    authVersion: input.authVersion,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = base64url(JSON.stringify(payload));
  return { token: `${body}.${sign(secret, body)}`, payload };
}

export function verifySession(secret: string, token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(secret, body);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.userId !== 'string' ||
    typeof payload.tenantId !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp < Date.now()
  ) {
    return null;
  }
  return payload;
}

export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;
