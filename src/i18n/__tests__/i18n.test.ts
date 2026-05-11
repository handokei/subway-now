import * as Localization from 'expo-localization';

jest.mock('expo-localization', () => ({
  getLocales: jest.fn(() => [{ languageCode: 'en' }]),
}));

import {
  detectDeviceLanguage,
  handleInitError,
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES,
  i18n,
} from '../index';

const mockGetLocales = Localization.getLocales as jest.Mock;

describe('detectDeviceLanguage', () => {
  afterEach(() => {
    mockGetLocales.mockReturnValue([{ languageCode: 'en' }]);
  });

  it('returns ko when device language is ko', () => {
    mockGetLocales.mockReturnValueOnce([{ languageCode: 'ko' }]);
    expect(detectDeviceLanguage()).toBe('ko');
  });

  it('returns en when device language is en', () => {
    mockGetLocales.mockReturnValueOnce([{ languageCode: 'en' }]);
    expect(detectDeviceLanguage()).toBe('en');
  });

  it('returns ja when device language is ja', () => {
    mockGetLocales.mockReturnValueOnce([{ languageCode: 'ja' }]);
    expect(detectDeviceLanguage()).toBe('ja');
  });

  it('falls back when device language is unsupported', () => {
    mockGetLocales.mockReturnValueOnce([{ languageCode: 'fr' }]);
    expect(detectDeviceLanguage()).toBe(FALLBACK_LANGUAGE);
  });

  it('falls back when locale list is empty', () => {
    mockGetLocales.mockReturnValueOnce([]);
    expect(detectDeviceLanguage()).toBe(FALLBACK_LANGUAGE);
  });

  it('falls back when languageCode is null', () => {
    mockGetLocales.mockReturnValueOnce([{ languageCode: null }]);
    expect(detectDeviceLanguage()).toBe(FALLBACK_LANGUAGE);
  });
});

describe('handleInitError', () => {
  it('logs the error without throwing', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => handleInitError(new Error('boom'))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('i18n instance', () => {
  afterEach(async () => {
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });

  it('initializes with a supported language', () => {
    expect(SUPPORTED_LANGUAGES).toContain(i18n.language);
  });

  it('resolves English translations', async () => {
    await i18n.changeLanguage('en');
    expect(i18n.t('common.retry')).toBe('Retry');
    expect(i18n.t('common.close')).toBe('Close');
  });

  it('resolves Korean translations', async () => {
    await i18n.changeLanguage('ko');
    expect(i18n.t('common.retry')).toBe('다시 시도');
    expect(i18n.t('common.close')).toBe('닫기');
  });
});
