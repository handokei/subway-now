import i18next from 'i18next';

// i18next.language 를 일시적으로 덮어써 언어 의존 로직을 테스트하기 위한 헬퍼.
// 호출하는 테스트 파일에서 `installLanguageRestoreHook()`을 파일 최상단에서 한 번 호출하면
// 모든 it 사이에서 자동으로 원래 언어로 복원된다.

export function setLang(lang: string): void {
  Object.defineProperty(i18next, 'language', { value: lang, configurable: true });
}

export function installLanguageRestoreHook(): void {
  // jest.setup.js가 i18next.init()으로 language descriptor를 항상 설치하므로 non-null 단언.
  let original: PropertyDescriptor;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(i18next, 'language')!;
  });
  afterEach(() => {
    Object.defineProperty(i18next, 'language', original);
  });
}
