import { describe, expect, it } from 'vitest';
import { zh } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';

/**
 * 字典契约测试。
 *
 * 类型层面已经保证"英文每个区域对象与中文同形"，但类型挡不住三件事，
 * 它们都会在运行时表现为"界面出现 `{{count}}` 或空白"，所以必须显式测：
 *
 * 1. 插值变量不一致（英文漏写 `{{name}}`，或写错成 `{{name }}`）；
 * 2. 值是空字符串（类型上合法，界面上是一块空白）；
 * 3. 复数后缀不成对（只写了 `_one` 没写 `_other`，英文在特定数字下会显示键名）。
 */

type Tree = Record<string, unknown>;

function flatten(value: unknown, path: string[] = [], out = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') {
    out.set(path.join('.'), value);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Tree)) {
      flatten(child, [...path, key], out);
    }
  }
  return out;
}

/** 插值变量名，排序后用于比对（顺序不同不算差异）。 */
function interpolationVariables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

/** 去掉复数后缀，用于比较"两种语言的键集是否一致"。 */
function baseKey(key: string): string {
  return key.replace(/_one$|_other$|_zero$|_two$|_few$|_many$/, '');
}

const zhFlat = flatten(zh);
const enFlat = flatten(en);

describe('字典契约', () => {
  it('中英键集完全一致（复数后缀归一化后比较）', () => {
    const zhKeys = [...new Set([...zhFlat.keys()].map(baseKey))].sort();
    const enKeys = [...new Set([...enFlat.keys()].map(baseKey))].sort();
    expect(enKeys).toEqual(zhKeys);
  });

  it('复数键成对出现', () => {
    for (const [flat, name] of [
      [zhFlat, 'zh'],
      [enFlat, 'en'],
    ] as const) {
      for (const key of flat.keys()) {
        if (key.endsWith('_one')) {
          expect(flat.has(`${key.slice(0, -'_one'.length)}_other`), `${name} 缺少对应的 _other: ${key}`).toBe(true);
        }
        if (key.endsWith('_other')) {
          expect(flat.has(`${key.slice(0, -'_other'.length)}_one`), `${name} 缺少对应的 _one: ${key}`).toBe(true);
        }
      }
    }
  });

  it('没有空文案', () => {
    for (const [flat, name] of [
      [zhFlat, 'zh'],
      [enFlat, 'en'],
    ] as const) {
      const empty = [...flat.entries()].filter(([, text]) => text.trim() === '').map(([key]) => key);
      expect(empty, `${name} 里存在空文案`).toEqual([]);
    }
  });

  it('同一条文案的插值变量在两种语言中一致', () => {
    const mismatched: string[] = [];
    for (const [key, zhText] of zhFlat) {
      const enText = enFlat.get(key);
      if (enText === undefined) continue;
      if (interpolationVariables(zhText).join(',') !== interpolationVariables(enText).join(',')) {
        mismatched.push(key);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('useTranslation 的键在两种语言里都存在（抽样关键键）', () => {
    // 抽样而不是全量：全量已由上面的键集比对覆盖。这里挑的是"漏了会立刻
    // 让首屏显示键名"的那几组，失败信息也更直观。
    for (const key of [
      'app.nav.overview',
      'app.nav.providers',
      'app.nav.models',
      'app.nav.agents',
      'app.nav.settings',
      'common.loading',
      'common.copy',
      'labels.roles.owner',
      'labels.permissions.providersRead',
      'labels.apiTypes.openai.label',
      'login.submit',
      'settings.language.title',
    ]) {
      expect(zhFlat.has(key), `zh 缺少 ${key}`).toBe(true);
      expect(enFlat.has(key), `en 缺少 ${key}`).toBe(true);
    }
  });

  it('复数键在两种语言下都选对分支', async () => {
    const { default: i18n } = await import('../src/i18n');
    // 只比对键集是不够的：`key_one`/`key_other` 都存在、但调用时传错 count、
    // 或用了基名（此时 i18next 直接返回键名）都会在界面上暴露成 "demo.count_one"。
    await i18n.changeLanguage('en');
    expect(i18n.t('overview.logs.count', { count: 1 })).toBe('1 record');
    expect(i18n.t('overview.logs.count', { count: 3 })).toBe('3 records');
    expect(i18n.t('app.startupWarnings', { count: 1 })).toContain('1 startup warning');
    expect(i18n.t('app.startupWarnings', { count: 2 })).toContain('2 startup warnings');

    await i18n.changeLanguage('zh');
    // 中文两份文本相同，但同样要能解析（不能回落成键名）
    expect(i18n.t('overview.logs.count', { count: 1 })).toBe('1 条');
    expect(i18n.t('overview.logs.count', { count: 3 })).toBe('3 条');
    expect(i18n.t('app.startupWarnings', { count: 2 })).toBe('2 条启动告警');
  });

  it('未知键回显自身而不是抛错（供动态枚举回退使用）', async () => {
    const { default: i18n } = await import('../src/i18n');
    await i18n.changeLanguage('en');
    // 协议/角色等枚举的新值会先出现在服务端，前端字典可能还没来得及补。
    // 此时宁可显示标识符（openai），也不要抛错或显示空白。
    expect(i18n.t('labels.apiTypes.unknown' as never)).toBe('labels.apiTypes.unknown');
    await i18n.changeLanguage('zh');
  });
});
