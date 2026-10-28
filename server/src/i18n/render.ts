import { catalogs } from './locales';
import type { MessageKey, MessageParams } from '.';

/**
 * 直接渲染中文，**不经过 `registerCatalogs` 的可变状态**。
 *
 * 为什么单独一个模块：`domain/` 的纯函数（如别名解析）在任何上下文里都要能
 * 给出可读文案，包括单元测试直接 `import` 调用它的时候。若走 `CATALOGS`，
 * 就依赖 `createContext()` 是否已经跑过——测试里没跑，`reason` 就成了键名。
 *
 * 这里直接 import 静态字典，模块加载即就绪。`i18n/index.ts` 不 import 它，
 * 避免 `index ↔ locales ↔ render` 的循环依赖。
 */
export function renderZh(key: MessageKey, params?: MessageParams): string {
  const template = catalogs.zh[key];
  if (template === undefined) return key;
  if (!params) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}
