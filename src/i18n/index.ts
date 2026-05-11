import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';

import { createLogger } from '../utils/logger';
import en from './locales/en.json';
import ko from './locales/ko.json';
import {
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from './types';

const logger = createLogger('i18n');

const RESOURCES = {
  en: { translation: en },
  ko: { translation: ko },
} as const;

export function detectDeviceLanguage(): SupportedLanguage {
  const code = Localization.getLocales()[0]?.languageCode;
  return SUPPORTED_LANGUAGES.find((lang) => lang === code) ?? FALLBACK_LANGUAGE;
}

export function handleInitError(err: unknown): void {
  logger.error('init failed', err);
}

i18next
  .use(initReactI18next)
  .init({
    compatibilityJSON: 'v4',
    resources: RESOURCES,
    lng: detectDeviceLanguage(),
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    defaultNS: 'translation',
    interpolation: { escapeValue: false },
  })
  .catch(handleInitError);

// TODO: 앱 실행 중 OS 언어 변경 대응은 후속 Phase에서 처리
// (Localization.addLocaleListener 또는 AppState active 시점에 changeLanguage 호출)

export { default as i18n } from 'i18next';
export { SUPPORTED_LANGUAGES, FALLBACK_LANGUAGE };
export type { SupportedLanguage };
