// expo 모듈이 import.meta를 사용하는 부분을 Jest 환경에서 모킹
global.__ExpoImportMetaRegistry = {};

// node 환경에서 누락된 타이머 함수 보완
if (typeof clearInterval === 'undefined') {
  global.clearInterval = () => {};
}
if (typeof setInterval === 'undefined') {
  global.setInterval = () => 0;
}

// i18n 자동 초기화: 컴포넌트/훅 테스트가 별도 setup 없이도
// useTranslation()을 사용할 수 있도록 함
// 테스트 기본 언어는 ko — 기존 한글 텍스트 기준 assertion 유지
jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'ko' }],
}));

const i18next = require('i18next');
const { initReactI18next } = require('react-i18next');
const { LANGUAGE_REGISTRY, FALLBACK_LANGUAGE } = require('./src/i18n/types');

i18next.use(initReactI18next).init({
  compatibilityJSON: 'v4',
  resources: Object.fromEntries(
    LANGUAGE_REGISTRY.map((lang) => [lang.code, { translation: lang.translation }]),
  ),
  lng: 'ko',
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: LANGUAGE_REGISTRY.map((lang) => lang.code),
  defaultNS: 'translation',
  interpolation: { escapeValue: false },
});
