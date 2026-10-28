import { zh } from './zh';
import { en } from './en';
import type { MessageCatalog } from '..';

/**
 * 把嵌套的区域字典摊平成 `'errors.notFound' → '资源不存在'` 的单层表。
 *
 * 摊平在加载时做一次，查找就是一次 `Map` 命中；不做的话每次翻译都要按 `.` 拆开逐层下钻，
 * 而报错路径本来就是低频但"必须可靠"的代码，没必要在那里做重复解析。
 */
function flatten(value: unknown, prefix: string[] = [], out: MessageCatalog = {}): MessageCatalog {
  if (typeof value === 'string') {
    out[prefix.join('.')] = value;
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, [...prefix, key], out);
    }
  }
  return out;
}

export const catalogs = {
  zh: flatten(zh),
  en: flatten(en),
};
