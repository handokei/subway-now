import { useEffect } from 'react';
import * as Localization from 'expo-localization';
import i18next from 'i18next';
import { useAppStore, type LocalePreference } from '../../../store/useAppStore';
import { FALLBACK_LANGUAGE, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../../shared/i18n/types';

export function resolveLanguage(
  preference: LocalePreference,
  osLanguageCode: string | null | undefined,
): SupportedLanguage {
  if (preference === 'auto') {
    return SUPPORTED_LANGUAGES.find((lang) => lang === osLanguageCode) ?? FALLBACK_LANGUAGE;
  }
  return preference;
}

// 사용자 명시 선택(localePreference) + auto 모드의 OS 언어 변화에 반응해
// i18next 인스턴스의 활성 언어를 동기화한다.
export function useApplyLocale(): void {
  const localePreference = useAppStore((s) => s.localePreference);
  const locales = Localization.useLocales();
  const osLanguageCode = locales[0]?.languageCode;

  useEffect(() => {
    const next = resolveLanguage(localePreference, osLanguageCode);
    if (i18next.language !== next) {
      i18next.changeLanguage(next).catch(() => {});
    }
  }, [localePreference, osLanguageCode]);
}
