import en from './locales/en.json';
import ko from './locales/ko.json';

// 지원 언어를 한 곳에서 관리한다. 새 언어 추가 시 이 배열에 한 줄을 추가하고
// 로케일 JSON 파일을 import 하면 RESOURCES/SUPPORTED_LANGUAGES/SupportedLanguage가
// 자동으로 따라온다. nativeName은 화면 언어와 무관하게 그 언어 사용자가 자기 언어를
// 알아볼 수 있도록 native name으로 표기한다 (예: ja → 日本語).
export const LANGUAGE_REGISTRY = [
  { code: 'ko', nativeName: '한국어', translation: ko },
  { code: 'en', nativeName: 'English', translation: en },
] as const;

export const SUPPORTED_LANGUAGES = LANGUAGE_REGISTRY.map(
  (l) => l.code,
) as readonly SupportedLanguage[];
export type SupportedLanguage = (typeof LANGUAGE_REGISTRY)[number]['code'];

export const FALLBACK_LANGUAGE: SupportedLanguage = 'en';

export type TranslationResources = typeof en;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: TranslationResources;
    };
  }
}
