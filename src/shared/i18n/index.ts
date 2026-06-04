import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import * as Localization from 'expo-localization';

import { createLogger } from '../../utils/logger';
import {
  FALLBACK_LANGUAGE,
  LANGUAGE_REGISTRY,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
  type TranslationResources,
} from './types';

const logger = createLogger('i18n');

const RESOURCE_ENTRIES: [SupportedLanguage, { translation: TranslationResources }][] =
  LANGUAGE_REGISTRY.map(({ code, translation }) => [code, { translation }]);
const RESOURCES = Object.fromEntries(RESOURCE_ENTRIES) as Record<
  SupportedLanguage,
  { translation: TranslationResources }
>;

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
export { LANGUAGE_REGISTRY, SUPPORTED_LANGUAGES, FALLBACK_LANGUAGE };
export type { SupportedLanguage };
