import 'i18next';
import type { zh } from './locales/zh';

/**
 * 让 `t()` 的键名有编译期检查。
 *
 * 以中文为键的唯一来源：`typeof zh` 是"键 → string"的结构，i18next 据此推导出
 * 合法键的联合类型，于是 `t('providers.tabel.name')` 这类拼写错误在 `tsc` 阶段
 * 就报错，而不是等到界面上显示出一串键名。
 *
 * 英文侧靠 `en/locales` 每个区域文件声明 `typeof zhXxx` 来保证键集一致——
 * 少一个键同样编译不过，因此漏译不会静默上线。
 *
 * 这个文件靠 `include: ["src"]` 被纳入编译；**不要**改成单独的 tsconfig，
 * 否则类型增强不生效、`t()` 会静默退回接受任意字符串。
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof zh };
  }
}
