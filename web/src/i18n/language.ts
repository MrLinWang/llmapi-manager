/**
 * 界面语言的定义与探测。
 *
 * 单独成文件（不含 i18next 初始化）的原因：`types.ts` / 测试等只需要类型和探测函数，
 * 引入它们时不该顺带执行一次全局 i18n 初始化。有副作用的初始化留在 `index.ts`。
 */

/**
 * 取值必须与服务端 `UI_LANGUAGES`（`server/src/domain/settings.ts`）一致：
 * 服务端存的就是这两个字符串，前端多一个值会导致"设置保存成功但界面不认"。
 */
export const UI_LANGUAGES = ['zh', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && (UI_LANGUAGES as readonly string[]).includes(value);
}

/**
 * 浏览器语言探测。
 *
 * 只在两种情况下使用：没有登录（读不到租户设置），或设置是 `null`（用户选择"跟随浏览器"）。
 * 已经登录且有显式设置时**不**调用它——否则服务端设置会被浏览器语言悄悄覆盖。
 *
 * 认得出 `zh*` 用中文、认得出其它语言用英文（英文比中文更通用），
 * 完全没有语言信息时才回落到中文（部署者默认是中文环境）。
 */
export function detectBrowserLanguage(): UiLanguage {
  if (typeof navigator === 'undefined') return 'zh';
  const candidates = [navigator.language, ...(navigator.languages ?? [])].filter(
    (item): item is string => typeof item === 'string' && item !== '',
  );
  for (const raw of candidates) {
    const tag = raw.toLowerCase();
    if (tag.startsWith('zh')) return 'zh';
    if (tag.startsWith('en')) return 'en';
  }
  return candidates.length > 0 ? 'en' : 'zh';
}
