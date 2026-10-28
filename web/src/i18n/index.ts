import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zh } from './locales/zh';
import { en } from './locales/en';
import { detectBrowserLanguage, isUiLanguage, UI_LANGUAGES, type UiLanguage } from './language';

/** `<html lang>` 用的 BCP 47 标签：i18next 的 `zh` 太笼统，声明成 zh-CN 更准确。 */
const HTML_LANG: Record<UiLanguage, string> = { zh: 'zh-CN', en: 'en' };

i18next.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: detectBrowserLanguage(),
  // 字典是内联的，没有后端加载；关掉 initAsync 才能让首帧同步翻译，
  // 否则第一次 render 会拿到键名、下一帧才变成文案（测试里也会看到键名）。
  initAsync: false,
  // 缺键时回落到中文而不是英文：中文是键的唯一来源、永远最全，
  // 英文某个区域漏翻时会显示中文而不是一串点号键名。
  fallbackLng: 'zh',
  supportedLngs: [...UI_LANGUAGES],
  // React 已默认转义；这里再转义会把 <Trans> 里的内联标记写成字面量。
  interpolation: { escapeValue: false },
  react: {
    // 字典同步可用，不需要 Suspense；开着会让首屏在没有 Suspense 边界时抛错。
    useSuspense: false,
  },
  returnNull: false,
});

/** 当前界面语言（`i18next.language` 可能是 zh-CN 之类的变体，这里收敛回两值）。 */
export function currentLanguage(): UiLanguage {
  return isUiLanguage(i18next.language) ? i18next.language : 'zh';
}

/**
 * 应用一个语言。
 *
 * `null` = 跟随浏览器：每次调用都重新探测，不复用上一次的结果——
 * 用户从"中文"切回"跟随浏览器"时，期望的正是"回到我系统语言"。
 */
export function applyLanguage(language: UiLanguage | null): void {
  const next = language ?? detectBrowserLanguage();
  if (i18next.language !== next) void i18next.changeLanguage(next);
}

function syncHtmlLang(language: string): void {
  if (typeof document === 'undefined') return;
  const tag = isUiLanguage(language) ? HTML_LANG[language] : HTML_LANG.zh;
  document.documentElement.lang = tag;
}

i18next.on('languageChanged', syncHtmlLang);
syncHtmlLang(i18next.language);

export { i18next, isUiLanguage, detectBrowserLanguage };
export type { UiLanguage };
export default i18next;
