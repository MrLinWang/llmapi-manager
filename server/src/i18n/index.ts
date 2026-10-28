/**
 * 服务端文案的双语支持。
 *
 * 与前端不同，服务端不用 i18next，而是自己写一个几十行的实现。理由：
 * 1. 服务端只需要"取一条文案 + 代入变量"，不需要复数、context、命名空间、
 *    插值转义这些 i18next 的重型能力（前端的 `_one`/`_other` 机制在这里用不上）。
 * 2. 服务端已有的 `AppError` 体系是"抛异常 → 全局错误处理器统一出 body"，
 *    引 i18next 还得再包一层，反而多一步。
 * 3. 依赖越少，越不容易出现"服务端升级 i18next 导致启动失败"这种故障——
 *    这个服务是要长期自托管的。
 *
 * **翻译发生在边界，不在领域层。** 领域函数（`domain/`、`gateway/selection.ts`）
 * 返回的是 `MessageKey` + 参数，只有最外层（错误处理器、路由响应、启动横幅）
 * 才把它渲染成具体语言。这样领域层保持纯函数、不认识语言，也不需要 Request。
 */

import type { UiLanguage } from '../domain/settings';
import { catalogs } from './locales';

/**
 * 文案键。
 *
 * 命名与前端一致（`区域.名字`），但**不复用前端字典**：两边的受众不同——
 * 前端是"看界面的人"，服务端是"调 API 的脚本 + 看报错的人"。硬合会让
 * 前端改个界面文案就把 API 的报错文本顺带改掉。
 *
 * 值在 `server/src/i18n/locales/{zh,en}/` 下按区域定义。
 */
export type MessageKey = string;

/** 插值参数。值会被 `String()` 化，`undefined`/`null` 渲染成空串。 */
export type MessageParams = Record<string, string | number | null | undefined>;

export type MessageCatalog = Record<string, string>;

/** 缺键时的兜底：把键名原样返回，便于在测试与日志里立刻发现漏翻。 */
function missing(key: MessageKey): string {
  return key;
}

/**
 * 渲染一条文案。
 *
 * 插值用 `{{name}}`，与前端字典保持同一套写法——两边都在同一份仓库里，
 * 两种占位语法只会让人写错。
 *
 * 缺键**不抛异常**：文案缺失不该让一个请求变成 500。返回键名，
 * `web/test` 侧的字典契约测试与 `server/test/i18n.test.ts` 会把它抓出来。
 */
export function translate(
  language: UiLanguage,
  key: MessageKey,
  params?: MessageParams,
): string {
  const catalog = CATALOGS[language] ?? CATALOGS.zh;
  const template = catalog[key] ?? CATALOGS.zh[key];
  if (template === undefined) return missing(key);
  if (!params) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * 所有语言的字典。
 *
 * **默认就是打包进来的那份**，不需要谁先调 `installCatalogs()`：
 * 单测里直接 `import { translate }` 就该能用，而不是拿到一串键名。
 * `registerCatalogs` 只用于测试替换（验证"字典缺失时的兜底"）。
 */
export let CATALOGS: Record<UiLanguage, MessageCatalog> = catalogs;



/**
 * 注入字典。
 *
 * 单独一个函数而不是在模块顶层 import：`i18n/locales` 里有几百条字符串，
 * 测试想替换成"只含一条键"的假字典时，直接调它即可，不必去 mock 模块图。
 */
export function registerCatalogs(catalogs: Record<UiLanguage, MessageCatalog>): void {
  CATALOGS = catalogs;
}

/**
 * 解析一条本地化后的文本，供 `AppError` 携带。
 *
 * 返回值同时带 `key` 与 `params`：错误处理器可以据此重新按**另一种**语言渲染
 * （例如日志里固定用中文，响应里用请求语言），也让测试能直接断言键名。
 */
export interface LocalizedText {
  key: MessageKey;
  params?: MessageParams;
}

/** 由 `LocalizedText` 生成某个语言下的字符串。 */
export function render(language: UiLanguage, text: LocalizedText): string {
  return translate(language, text.key, text.params);
}
