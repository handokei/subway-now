import { renderHook } from '@testing-library/react-native';
import * as Localization from 'expo-localization';
import i18next from 'i18next';
import { resolveLanguage, useApplyLocale } from '../useApplyLocale';
import { useAppStore } from '../../store/useAppStore';
import type { LocalePreference } from '../../store/useAppStore';

jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageCode: 'ko' }]),
  useLocales: jest.fn(() => [{ languageCode: 'ko' }]),
}));

describe('resolveLanguage', () => {
  it.each([
    ['ko', 'en', 'ko'],
    ['en', 'ko', 'en'],
    ['auto', 'ko', 'ko'],
    ['auto', 'en', 'en'],
    ['auto', 'ja', 'en'],
    ['auto', null, 'en'],
  ] as const)('resolveLanguage(%s, %s) === %s', (preference, os, expected) => {
    expect(resolveLanguage(preference as LocalePreference, os)).toBe(expected);
  });
});

describe('useApplyLocale', () => {
  const useLocalesMock = Localization.useLocales as jest.Mock;
  let changeLanguageSpy: jest.SpyInstance;
  let originalLanguageDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    useAppStore.setState({ localePreference: 'auto' });
    useLocalesMock.mockReturnValue([{ languageCode: 'ko' }]);
    changeLanguageSpy = jest.spyOn(i18next, 'changeLanguage').mockResolvedValue(undefined as never);
    originalLanguageDescriptor = Object.getOwnPropertyDescriptor(i18next, 'language');
  });

  afterEach(() => {
    changeLanguageSpy.mockRestore();
    if (originalLanguageDescriptor) {
      Object.defineProperty(i18next, 'language', originalLanguageDescriptor);
    }
  });

  function arrange(opts: { current: string; preference: LocalePreference; os?: string }) {
    Object.defineProperty(i18next, 'language', { value: opts.current, configurable: true });
    useLocalesMock.mockReturnValue([{ languageCode: opts.os ?? 'ko' }]);
    useAppStore.setState({ localePreference: opts.preference });
    renderHook(() => useApplyLocale());
  }

  it('localePreference=ko이고 현재 언어가 en이면 changeLanguage(ko) 호출', () => {
    arrange({ current: 'en', preference: 'ko' });
    expect(changeLanguageSpy).toHaveBeenCalledWith('ko');
  });

  it('현재 i18next.language와 동일한 언어면 changeLanguage 호출 안 함', () => {
    arrange({ current: 'ko', preference: 'ko' });
    expect(changeLanguageSpy).not.toHaveBeenCalled();
  });

  it('auto + OS가 en이면 changeLanguage(en) 호출', () => {
    arrange({ current: 'ko', preference: 'auto', os: 'en' });
    expect(changeLanguageSpy).toHaveBeenCalledWith('en');
  });

  it('auto + OS 미지원이면 fallback(en) 적용', () => {
    arrange({ current: 'ko', preference: 'auto', os: 'fr' });
    expect(changeLanguageSpy).toHaveBeenCalledWith('en');
  });

  it('changeLanguage가 reject돼도 throw하지 않는다', () => {
    changeLanguageSpy.mockRejectedValue(new Error('boom'));
    expect(() => arrange({ current: 'ko', preference: 'en' })).not.toThrow();
  });
});
