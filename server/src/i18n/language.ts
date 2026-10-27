import type { FastifyRequest } from 'fastify';
import type { Principal } from '../domain/identity';
import { normalizeUiLanguage, type UiLanguage } from '../domain/settings';
import type { AppContext } from '../context';

/**
 * 决定"这次请求的报错该用哪种语言"。
 *
 * 优先级（从高到低）：
 * 1. 已登录的租户设置 `language`（用户在控制台里显式选的那一项）；
 * 2. `Accept-Language` 请求头；
 * 3. 中文兜底。
 *
 * 为什么租户设置优先于 `Accept-Language`：用户已经在控制台里明确选过语言了，
 * 这时候报错还跟着浏览器语言走，会出现"界面英文、报错中文"的割裂——而控制台
 * 就是我们自己的客户端，它的选择应该说话最响。
 *
 * 为什么还要 `Accept-Language`：未登录时（401、首次初始化、`/api/info`）
 * 读不到租户设置，此时请求头是唯一线索。
 */
export function resolveRequestLanguage(
  request: Pick<FastifyRequest, 'headers' | 'principal'>,
  ctx: AppContext,
): UiLanguage {
  const principal = request.principal as Principal | undefined;
  if (principal) {
    try {
      const language = ctx.store.forTenant(principal.tenantId).settings.read().language;
      // `null` = 用户选择"跟随浏览器"，此时继续往下看 Accept-Language
      const explicit = normalizeUiLanguage(language);
      if (explicit) return explicit;
    } catch {
      // 读设置失败不该让错误响应本身变成 500：继续用请求头兜底
    }
  }
  return languageFromHeader(request.headers['accept-language']);
}

/**
 * 从 `Accept-Language` 挑一个支持的语言。
 *
 * 只看"是否认识中/英"，不实现完整的 q-value 权重排序：本服务只支持两种语言，
 * 按出现顺序取第一个认识的就够了，而完整实现（解析 q、处理通配符）带来的
 * 复杂度换不来任何实际差别。
 */
/** 只包含通配符与 q 值、没有具体语言标签。 */
const WILDCARD_ONLY = /^[\s*q=0-9.,;]*$/;

export function languageFromHeader(header: unknown): UiLanguage {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || raw === '') return 'zh';
  for (const part of raw.split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? '';
    // `*` 是"什么语言都行"，等于没表态。必须当成没有偏好，而不是"不认识"——
    // 否则 curl / 脚本（它们常发 `Accept-Language: *`）会拿到英文，
    // 而同一台机器上不带这个头时却是中文，行为前后不一致。
    if (tag === '') continue;
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  // 认了但一个都不认识（如 fr-FR）：用英文——非中文环境默认英文比默认中文更有用。
  // 注意这里要区分"全是通配符"（没表态，走上面的 zh 兜底）与此处（明确要了别的语言）。
  return WILDCARD_ONLY.test(raw) ? 'zh' : 'en';
}

/**
 * 给"不需要登录的"路由用：没有 principal 可查，只看请求头。
 */
export function resolveAnonymousLanguage(request: Pick<FastifyRequest, 'headers'>): UiLanguage {
  return languageFromHeader(request.headers['accept-language']);
}

/** 服务端内部（日志、CLI、启动横幅）固定用中文：受众是部署者与运维。 */
export const SERVER_LOG_LANGUAGE: UiLanguage = 'zh';
