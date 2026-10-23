import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiTokenRecord, ApiTokenView } from '../domain/apiToken';
import type { Permission } from '../domain/permissions';

/**
 * 前缀与网关令牌（`lam_`）刻意不同。
 *
 * 两者用途完全分离：`lam_` 只用于 `/v1/*` 推理转发，`api_` 只用于 `/api/*` 管理面。
 * 前缀分开让日志、文档、用户心智都能一眼区分——混用会让"这个令牌能干什么"说不清，
 * 出问题时也无法从日志判断是哪一类凭据泄露。
 */
export const API_TOKEN_PREFIX = 'api_';

/** 与网关令牌同一套做法：只存 sha256，比对用 timingSafeEqual */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createApiTokenRecord(input: {
  tenantId: string;
  name: string;
  scopes: Permission[];
  createdBy: string;
  expiresAt: string | null;
}): { token: string; record: ApiTokenRecord } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
  return {
    token,
    record: {
      id: `tok_${randomBytes(8).toString('hex')}`,
      tenantId: input.tenantId,
      name: input.name,
      tokenHash: hashApiToken(token),
      prefix: token.slice(0, 11),
      tail: token.slice(-4),
      scopes: input.scopes,
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      expiresAt: input.expiresAt,
      revokedAt: null,
    },
  };
}

/**
 * 校验令牌是否可用。
 *
 * 刻意不做成类型谓词：调用方在失败分支里仍需要读 record（例如区分"已吊销"
 * 与"已过期"来打日志），类型谓词会把 undefined 之外的信息收窄掉。
 */
export function verifyApiToken(
  token: string,
  record: ApiTokenRecord | undefined,
): boolean {
  if (!record) return false;
  if (record.revokedAt !== null) return false;
  if (record.scopes.length === 0) return false;
  if (record.expiresAt !== null && Date.parse(record.expiresAt) <= Date.now()) return false;

  const expected = Buffer.from(record.tokenHash, 'hex');
  const actual = Buffer.from(hashApiToken(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * 从 `Authorization: Bearer <token>` 取出令牌。
 *
 * 只认这个头、不认 query 参数：URL 会进访问日志、浏览器历史、Referer，
 * 令牌出现在那里等于长期泄漏。
 */
export function parseBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.startsWith(API_TOKEN_PREFIX) ? token : null;
}

/** 对外视图：剔除 tokenHash，其余原样。 */
export function toApiTokenView(record: ApiTokenRecord): ApiTokenView {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    tail: record.tail,
    scopes: record.scopes,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

/**
 * `lastUsedAt` 的更新节流：距上次更新不足 60 秒就跳过。
 *
 * 每次请求都写盘会让一个高频脚本把磁盘打得很难看（JSON 文件是整份重写）。
 * 这个字段只用于"这个令牌还在用吗"的判断，分钟级精度足够。
 */
export const LAST_USED_UPDATE_INTERVAL_MS = 60_000;

export function shouldUpdateLastUsed(record: ApiTokenRecord, now = Date.now()): boolean {
  if (record.lastUsedAt === null) return true;
  return now - Date.parse(record.lastUsedAt) >= LAST_USED_UPDATE_INTERVAL_MS;
}
