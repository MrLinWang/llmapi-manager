import type { MessageKey, MessageParams } from './i18n';
import { renderZh } from './i18n/render';
import type { UiLanguage } from './domain/settings';
import { translate } from './i18n';

/**
 * 启动期告警（文件损坏、缺加密密钥、密钥自动生成等）。
 * 收集后由 `/api/health` 暴露，避免"启动日志刷过去了用户没看见"。
 *
 * 告警会显示在控制台顶栏，所以文案要能跟随界面语言——但**收集发生在启动期**，
 * 那时还没有任何请求、拿不到 Request 语言。因此这里存"键 + 参数"，
 * 由 `/api/health` 在响应阶段按请求语言渲染。
 *
 * `message` 仍保留中文渲染结果：既有日志与测试都在读它，且告警产生的瞬间
 * （写日志）需要一个可读字符串。
 */
export interface StartupWarning {
  code: string;
  /** 键（响应阶段据此本地化） */
  messageKey: MessageKey;
  params?: MessageParams;
  /** 中文渲染结果，供日志与既有调用方 */
  message: string;
}

const warnings: StartupWarning[] = [];

export function addWarning(code: string, messageKey: MessageKey, params?: MessageParams): void {
  if (warnings.some((item) => item.code === code)) return;
  warnings.push({ code, messageKey, params, message: renderZh(messageKey, params) });
}

/** 按语言渲染告警：给 `/api/health` 用。 */
export function getWarningsFor(language: UiLanguage): Array<{ code: string; message: string }> {
  return warnings.map((item) => ({
    code: item.code,
    message: translate(language, item.messageKey, item.params),
  }));
}

export function getWarnings(): StartupWarning[] {
  return [...warnings];
}

export function resetWarnings(): void {
  warnings.length = 0;
}
