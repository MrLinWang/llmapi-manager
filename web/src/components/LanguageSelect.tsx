import { useTranslation } from 'react-i18next';
import { applyLanguage } from '../i18n';
import { UI_LANGUAGES, type UiLanguage } from '../i18n/language';

/**
 * 语言选择器。
 *
 * 三态而不是两态：`''`（跟随浏览器）/ `zh` / `en`。少了"跟随浏览器"这一项，
 * 用户一旦选过就再也回不到"我换台机器就自动用系统语言"的状态。
 *
 * 语言名用各自的原生写法（简体中文 / English）且**不参与翻译**：界面是英文时，
 * 中文选项仍要写成"简体中文"，否则读中文的人反而认不出该选哪个。
 */
export function LanguageSelect({
  value,
  disabled = false,
  onChange,
  className = 'input',
}: {
  value: UiLanguage | null;
  disabled?: boolean;
  /** 由调用方决定是否持久化；不传则只切界面（用于登录前页面） */
  onChange?: (language: UiLanguage | null) => void | Promise<void>;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation();

  const handle = (raw: string): void => {
    const next = raw === '' ? null : (raw as UiLanguage);
    // 先切界面再落盘：网络失败时用户至少立刻看到自己选的语言，
    // 而不是"点了没反应、等一秒后报错"。
    applyLanguage(next);
    if (onChange) void onChange(next);
  };

  return (
    <select
      className={className}
      aria-label={t('app.language.label')}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => handle(event.target.value)}
    >
      <option value="">{t('app.language.auto')}</option>
      {UI_LANGUAGES.map((language: UiLanguage) => (
        <option key={language} value={language}>
          {language === 'zh' ? '简体中文' : 'English'}
        </option>
      ))}
    </select>
  );
}
