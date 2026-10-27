import { currentLanguage, type UiLanguage } from '.';

const DATE_LOCALE: Record<UiLanguage, string> = { zh: 'zh-CN', en: 'en-US' };

/**
 * 按当前界面语言格式化时间。
 *
 * 不能用 `toLocaleString()` 的默认行为：它跟随**浏览器**语言，与用户在本控制台里
 * 选的语言可能不同，于是会出现"界面是英文、时间却是中文格式"的割裂。
 */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(DATE_LOCALE[currentLanguage()]);
}

export function formatTime(value: string | number | Date): string {
  return new Date(value).toLocaleTimeString(DATE_LOCALE[currentLanguage()]);
}

/** 固定宽度的时间戳（令牌过期、最后使用等场景），避免各页面自行 slice ISO 串。 */
export function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(DATE_LOCALE[currentLanguage()], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
