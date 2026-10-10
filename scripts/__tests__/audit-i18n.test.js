/**
 * audit-i18n script — pure helper coverage + integration: ensure the
 * repository's locale files have no cross-locale or used-but-missing keys.
 */

const path = require('node:path');
const { flatten, loadLocales, diff, extractUsedKeys } = require('../audit-i18n');

describe('flatten', () => {
  it('flattens nested objects with dot-joined keys', () => {
    expect(flatten({ a: { b: { c: 1 }, d: 2 }, e: 3 })).toEqual({
      'a.b.c': 1,
      'a.d': 2,
      e: 3,
    });
  });

  it('treats arrays as leaves', () => {
    expect(flatten({ a: [1, 2, 3] })).toEqual({ a: [1, 2, 3] });
  });
});

describe('diff', () => {
  it('reports per-locale missing keys', () => {
    const locales = {
      ko: { 'common.ok': '확인' },
      en: { 'common.ok': 'OK', 'common.cancel': 'Cancel' },
      ja: { 'common.ok': 'OK' },
      zh: { 'common.ok': '确定' },
    };
    const { missingByLocale, allKeys } = diff(locales);
    expect(allKeys.size).toBe(2);
    expect(missingByLocale.ko).toEqual(['common.cancel']);
    expect(missingByLocale.en).toEqual([]);
    expect(missingByLocale.ja).toEqual(['common.cancel']);
    expect(missingByLocale.zh).toEqual(['common.cancel']);
  });
});

describe('repository i18n locales (integration)', () => {
  it('has no cross-locale missing keys', () => {
    const locales = loadLocales();
    const { missingByLocale } = diff(locales);
    expect(missingByLocale).toEqual({ ko: [], en: [], ja: [], zh: [] });
  });

  it('has no used-but-missing keys (accounting for i18next plural suffixes and template-literal prefixes)', () => {
    const locales = loadLocales();
    const { used, dynamicPrefixes } = extractUsedKeys();
    const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
    const LOCALES = ['ko', 'en', 'ja', 'zh'];
    const hasKey = (locale, key) => {
      if (key in locale) return true;
      for (const suf of PLURAL_SUFFIXES) if ((key + suf) in locale) return true;
      return false;
    };
    const missing = [];
    for (const key of used) {
      // Skip keys covered by a dynamic prefix (e.g. t(`lines.${n}`)).
      let underDynamic = false;
      for (const p of dynamicPrefixes) {
        if (key === p || key.startsWith(p + '.')) { underDynamic = true; break; }
      }
      if (underDynamic) continue;
      const missingIn = LOCALES.filter((loc) => !hasKey(locales[loc], key));
      if (missingIn.length > 0) missing.push({ key, missingIn });
    }
    expect(missing).toEqual([]);
  });
});
