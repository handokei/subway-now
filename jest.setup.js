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

// @sentry/react-native 글로벌 모킹: ESM + 네이티브 모듈로 jest transform 미지원.
// - logger → breadcrumb wire가 SDK를 import (#1040)
// - sentryInit이 init/close 호출 (#1038, #1084 opt-in 토글)
// 개별 테스트가 필요시 jest.mock으로 덮어쓴다.
jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  close: jest.fn(),
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

const i18next = require('i18next');
const { initReactI18next } = require('react-i18next');
const { LANGUAGE_REGISTRY, FALLBACK_LANGUAGE } = require('./src/shared/i18n/types');

// react-native-safe-area-context 모킹: 컴포넌트 테스트가 SafeAreaProvider 없이도
// useSafeAreaInsets / SafeAreaView를 호출할 수 있게. inset은 0(노치 없는 환경)으로 가정.

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    SafeAreaProvider: ({ children }) => React.createElement(React.Fragment, null, children),
    SafeAreaView: ({ children, ...props }) => React.createElement(View, props, children),
    useSafeAreaInsets: () => inset,
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  };
});

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
