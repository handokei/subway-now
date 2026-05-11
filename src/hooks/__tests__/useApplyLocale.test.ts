import { renderHook } from '@testing-library/react-native';
import * as Localization from 'expo-localization';
import i18next from 'i18next';
import { resolveLanguage, useApplyLocale } from '../useApplyLocale';
import { useAppStore } from '../../store/useAppStore';

jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageCode: 'ko' }]),
  useLocales: jest.fn(() => [{ languageCode: 'ko' }]),
}));

describe('resolveLanguage', () => {
  it('preference=ko면 ko 반환', () => {
    expect(resolveLanguage('ko', 'en')).toBe('ko');
  });

  it('preference=en이면 en 반환', () => {
    expect(resolveLanguage('en', 'ko')).toBe('en');
  });

  it('auto + OS가 ko면 ko 반환', () => {
    expect(resolveLanguage('auto', 'ko')).toBe('ko');
  });

  it('auto + OS가 en이면 en 반환', () => {
    expect(resolveLanguage('auto', 'en')).toBe('en');
  });

  it('auto + OS가 미지원 언어면 fallback(en) 반환', () => {
    expect(resolveLanguage('auto', 'ja')).toBe('en');
  });

  it('auto + OS가 null이면 fallback(en) 반환', () => {
    expect(resolveLanguage('auto', null)).toBe('en');
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

  function setI18nLanguage(lang: string) {
    Object.defineProperty(i18next, 'language', { value: lang, configurable: true });
  }

  it('localePreference=ko이고 현재 언어가 en이면 changeLanguage(ko) 호출', () => {
    setI18nLanguage('en');
    useAppStore.setState({ localePreference: 'ko' });
    renderHook(() => useApplyLocale());
    expect(changeLanguageSpy).toHaveBeenCalledWith('ko');
  });

  it('현재 i18next.language와 동일한 언어면 changeLanguage 호출 안 함', () => {
    setI18nLanguage('ko');
    useAppStore.setState({ localePreference: 'ko' });
    renderHook(() => useApplyLocale());
    expect(changeLanguageSpy).not.toHaveBeenCalled();
  });

  it('auto + OS가 en이면 changeLanguage(en) 호출', () => {
    setI18nLanguage('ko');
    useLocalesMock.mockReturnValue([{ languageCode: 'en' }]);
    useAppStore.setState({ localePreference: 'auto' });
    renderHook(() => useApplyLocale());
    expect(changeLanguageSpy).toHaveBeenCalledWith('en');
  });

  it('auto + OS 미지원이면 fallback(en) 적용', () => {
    setI18nLanguage('ko');
    useLocalesMock.mockReturnValue([{ languageCode: 'fr' }]);
    useAppStore.setState({ localePreference: 'auto' });
    renderHook(() => useApplyLocale());
    expect(changeLanguageSpy).toHaveBeenCalledWith('en');
  });

  it('changeLanguage가 reject돼도 throw하지 않는다', () => {
    setI18nLanguage('ko');
    changeLanguageSpy.mockRejectedValue(new Error('boom'));
    useAppStore.setState({ localePreference: 'en' });
    expect(() => renderHook(() => useApplyLocale())).not.toThrow();
  });
});
