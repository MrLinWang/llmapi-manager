import { afterEach, describe, expect, it } from 'vitest';
import { catalogs } from '../src/i18n/locales';
import { languageFromHeader } from '../src/i18n/language';
import { registerCatalogs, translate, type MessageCatalog } from '../src/i18n';
import { installCatalogs, resetCatalogsForTest } from '../src/i18n/install';
import { AppError, badRequest, forbidden } from '../src/http/errors';

/**
 * 服务端文案契约。
 *
 * 与前端 `web/test/i18n.test.tsx` 同一个思路：类型层面能保证"区域对象同形"，
 * 但保证不了"键写了却没人用""两边键集漂移""插值变量对不上"。这些在运行时
 * 都会变成界面上的一句 `errors.someKey`，所以必须显式测。
 */

const zh = catalogs.zh;
const en = catalogs.en;

/** 插值变量名，排序后比对（顺序不同不算差异）。 */
function vars(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]).sort();
}

afterEach(() => {
  resetCatalogsForTest();
  installCatalogs();
});

describe('服务端字典契约', () => {
  it('中英键集完全一致', () => {
    // 不直接比整个数组：失败信息会变成 "expected 211 to equal 210"，
    // 看不出**哪个键**缺了。先算差集，报出具体键名。
    const onlyZh = Object.keys(zh).filter((key) => !(key in en)).sort();
    const onlyEn = Object.keys(en).filter((key) => !(key in zh)).sort();
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] });
  });

  it('没有空文案', () => {
    const emptyZh = Object.entries(zh).filter(([, v]) => v.trim() === '').map(([k]) => k);
    const emptyEn = Object.entries(en).filter(([, v]) => v.trim() === '').map(([k]) => k);
    expect(emptyZh).toEqual([]);
    expect(emptyEn).toEqual([]);
  });

  it('同一条文案的插值变量在两种语言中一致', () => {
    const mismatched: string[] = [];
    for (const [key, zhText] of Object.entries(zh)) {
      const enText = en[key];
      if (enText === undefined) continue;
      if (vars(zhText).join(',') !== vars(enText).join(',')) mismatched.push(key);
    }
    expect(mismatched).toEqual([]);
  });

  it('键名都带区域前缀（防止有人往顶层堆裸键）', () => {
    // 区域前缀是"改哪块文案只动哪个文件"的前提；没有前缀的键会逐渐长成杂物间。
    const bare = Object.keys(zh).filter((key) => !key.includes('.'));
    expect(bare).toEqual([]);
  });
});

describe('translate', () => {
  it('按语言取对应文案，并代入插值参数', () => {
    expect(translate('zh', 'errors.notFound')).toBe('资源不存在');
    expect(translate('en', 'errors.notFound')).toBe('Resource not found');
    expect(
      translate('en', 'errors.apiRouteMissing', { method: 'GET', url: '/api/x' }),
    ).toBe('No such endpoint: GET /api/x');
  });

  it('缺失的插值参数保持原样（不渲染成 undefined）', () => {
    // 渲染成 "undefined" 会在界面上出现一串英文单词，比留着占位符更难看出是漏传
    expect(translate('zh', 'errors.apiRouteMissing', { method: 'GET' })).toContain('{{url}}');
  });

  it('未知键回显键名而不是抛错', () => {
    // 文案缺失不该让一个请求变成 500
    expect(translate('zh', 'errors.doesNotExist')).toBe('errors.doesNotExist');
    expect(translate('en', 'errors.doesNotExist')).toBe('errors.doesNotExist');
  });

  it('字典未装载时也有兜底（不抛异常）', () => {
    resetCatalogsForTest();
    registerCatalogs({ zh: {}, en: {} });
    expect(translate('zh', 'errors.notFound')).toBe('errors.notFound');
  });
});

describe('AppError', () => {
  it('按语言渲染 message，同时给出 messageKey 供机读', () => {
    const error = badRequest('errors.framework');
    expect(error.toBody('zh').error.message).toBe('请求格式不正确');
    expect(error.toBody('en').error.message).toBe('Malformed request');
    // 调用方不该靠匹配文案来分支——文案会随语言变
    expect(error.toBody('en').error.messageKey).toBe('errors.framework');
  });

  it('Error.message 固定是中文（日志与堆栈的可读性）', () => {
    // 构造错误时通常没有 request 上下文，日志里必须始终是可读中文而不是键名
    expect(new AppError('not_found', 'errors.notFound').message).toBe('资源不存在');
  });

  it('保留 details（如 canEnableConversion 机读标记）', () => {
    // 注意第二参是**插值参数**、第三参才是 details：两者混用会让详情悄悄变成占位值
    const error = new AppError('forbidden', { key: 'errors.forbidden' }, { canEnableConversion: true });
    expect(error.toBody('zh').error.details).toEqual({ canEnableConversion: true });
    expect(forbidden().toBody('zh').error.details).toBeUndefined();
  });

  it('params 会代入两种语言', () => {
    const error = badRequest('errors.routeNotDeclared', { method: 'POST', url: '/api/x' });
    expect(error.toBody('zh').error.message).toContain('POST');
    expect(error.toBody('en').error.message).toContain('/api/x');
  });
});

describe('Accept-Language 解析', () => {
  it('认出 zh / en，含 q 值与多值', () => {
    expect(languageFromHeader('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh');
    expect(languageFromHeader('en-US,en;q=0.9')).toBe('en');
    expect(languageFromHeader('en')).toBe('en');
  });

  it('不认识的语言用英文兜底（比默认中文更有用）', () => {
    expect(languageFromHeader('fr-FR,fr;q=0.9')).toBe('en');
  });

  it('没有请求头时用中文', () => {
    expect(languageFromHeader(undefined)).toBe('zh');
    expect(languageFromHeader('')).toBe('zh');
  });

  it('通配符等于没表态，回落到中文而不是英文', () => {
    // curl 与不少 HTTP 客户端默认发 `Accept-Language: *`。若把它当成"不认识的语言"
    // 而回落到英文，同一台机器上"带默认头"与"不带这个头"会得到不同语言的报错——
    // 这种前后不一致极难排查。
    expect(languageFromHeader('*')).toBe('zh');
    expect(languageFromHeader('*,en;q=0.8')).toBe('en');
  });
});
