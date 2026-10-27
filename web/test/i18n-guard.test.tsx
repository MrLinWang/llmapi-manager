import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import i18n, { applyLanguage } from '../src/i18n';

/**
 * 界面文案硬编码扫描。
 *
 * 这是"以后再加中文硬编码"的机械防线：i18n 的收益会随着时间被新加的
 * 硬编码文案一点点吃掉，而 code review 很容易漏。与其靠人盯，不如让测试红。
 *
 * 规则：`web/src` 下的源码里，`src/i18n/locales/**` 之外不允许出现中日韩字符，
 * 除非命中下方白名单。**注释里的中文是允许的**（仓库要求注释用中文），
 * 所以扫的是"去掉注释后的字符串字面量与 JSX 文本"——用简化的词法处理足够，
 * 宁可漏报也不要误报到把注释算进来。
 */

const SRC_DIR = path.resolve(__dirname, '../src');
const LOCALES_DIR = path.join(SRC_DIR, 'i18n', 'locales');

/**
 * 白名单：这些位置允许出现中文，且每一条都要能说出理由。
 *
 * 注意**不要**为了让测试变绿而往这里加页面文件——那等于关掉防线。
 */
const ALLOWED: Array<{ file: string; reason: string }> = [
  { file: 'main.tsx', reason: '开发者启动错误（缺少 #root 节点），不面向用户' },
  { file: 'lib/auth.tsx', reason: '开发者错误：useAuth 必须在 AuthProvider 内使用' },
  {
    file: 'components/LanguageSelect.tsx',
    reason: '语言名的原生写法「简体中文」必须保持中文，否则中文用户认不出该选项',
  },
];

/** 去注释：块注释与整行/行尾 `//` 注释，足够覆盖本仓库的写法。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/\s\/\/[^\n]*/g, ' ');
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('界面文案不得硬编码', () => {
  it('web/src 里除字典与白名单外没有中文字面量', () => {
    const offenders: string[] = [];

    for (const file of collectFiles(SRC_DIR)) {
      if (file.startsWith(LOCALES_DIR)) continue;
      if (file.endsWith('i18next.d.ts')) continue;

      const relative = path.relative(SRC_DIR, file).split(path.sep).join('/');
      if (ALLOWED.some((item) => item.file === relative)) continue;

      const source = stripComments(fs.readFileSync(file, 'utf8'));
      source.split('\n').forEach((line, index) => {
        if (CJK.test(line)) {
          offenders.push(`${relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }

    expect(
      offenders,
      `发现未走 i18n 的中文文案（注释不算，注释已在扫描前剔除）：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('白名单里的文件仍然存在（防止文件改名后白名单悄悄失效）', () => {
    for (const item of ALLOWED) {
      expect(fs.existsSync(path.join(SRC_DIR, item.file)), `${item.file} 不存在（${item.reason}）`).toBe(true);
    }
  });
});

describe('语言切换', () => {
  it('切换语言会更新 <html lang> 并立即反映到 t()', async () => {
    applyLanguage('en');
    await i18n.changeLanguage('en');
    expect(i18n.t('common.copy')).toBe('Copy');
    expect(document.documentElement.lang).toBe('en');

    applyLanguage('zh');
    await i18n.changeLanguage('zh');
    expect(i18n.t('common.copy')).toBe('复制');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('applyLanguage(null) 按浏览器语言探测，且识别 zh* 与其它语言', async () => {
    const original = navigator.language;
    try {
      Object.defineProperty(navigator, 'language', { value: 'en-GB', configurable: true });
      applyLanguage(null);
      expect(i18n.language).toBe('en');

      Object.defineProperty(navigator, 'language', { value: 'zh-TW', configurable: true });
      applyLanguage(null);
      expect(i18n.language).toBe('zh');
    } finally {
      Object.defineProperty(navigator, 'language', { value: original, configurable: true });
      applyLanguage('zh');
    }
  });
});
