import { readFileSync } from 'fs';
import { join } from 'path';
import { act } from '@testing-library/react-native';
import * as RN from 'react-native';
import { BackendDegradedBanner } from '../BackendDegradedBanner';
import { useRegisterHealthStore } from '../../store/useRegisterHealthStore';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { lightColors, darkColors } from '../../../../shared/theme';
import koLocale from '../../../../shared/i18n/locales/ko.json';
import enLocale from '../../../../shared/i18n/locales/en.json';
import jaLocale from '../../../../shared/i18n/locales/ja.json';
import zhLocale from '../../../../shared/i18n/locales/zh.json';

const TITLE = '서버에 일시적인 문제가 있어요';
const BODY = '지금은 도착·환승 알림과 잠금화면 안내가 오지 않을 수 있어요. 복구되면 자동으로 다시 연결돼요.';

function flatten(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]));
}

describe('BackendDegradedBanner (#3006 PR-3)', () => {
  beforeEach(() => {
    act(() => useRegisterHealthStore.setState({ degraded: false }));
  });
  afterEach(() => jest.restoreAllMocks());

  it('E1 — degraded 아님 → null', () => {
    const { toJSON } = renderWithTheme(<BackendDegradedBanner tripActive />);
    expect(toJSON()).toBeNull();
  });

  it('E1 — trip 없음 → null (degraded여도)', () => {
    act(() => useRegisterHealthStore.setState({ degraded: true }));
    const { toJSON } = renderWithTheme(<BackendDegradedBanner tripActive={false} />);
    expect(toJSON()).toBeNull();
  });

  it('E2 — ko 문구·role alert·polite·testID·label', () => {
    act(() => useRegisterHealthStore.setState({ degraded: true }));
    const { getByTestId, getByText } = renderWithTheme(<BackendDegradedBanner tripActive />);
    const banner = getByTestId('backend-degraded-banner');
    expect(banner.props.accessibilityRole).toBe('alert');
    expect(banner.props.accessibilityLiveRegion).toBe('polite');
    expect(banner.props.accessibilityLabel).toBe(`${TITLE}. ${BODY}`);
    expect(getByText(TITLE)).toBeTruthy();
    expect(getByText(BODY)).toBeTruthy();
  });

  it.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)('E3 — %s 테마 토큰 색', (scheme, palette) => {
    jest.spyOn(RN, 'useColorScheme').mockReturnValue(scheme);
    act(() => useRegisterHealthStore.setState({ degraded: true }));
    const { getByText, getByTestId } = renderWithTheme(<BackendDegradedBanner tripActive />);
    expect(flatten(getByText(TITLE).props.style).color).toBe(palette.ink);
    expect(flatten(getByText(BODY).props.style).color).toBe(palette.muted);
    expect(flatten(getByTestId('backend-degraded-dot').props.style).backgroundColor).toBe(palette.warn);
  });

  it('E4 — 4개 언어 title/body 존재', () => {
    for (const locale of [koLocale, enLocale, jaLocale, zhLocale]) {
      const { backendDegraded } = (locale as { home: { backendDegraded?: { title?: string; body?: string } } }).home;
      expect(backendDegraded?.title).toBeTruthy();
      expect(backendDegraded?.body).toBeTruthy();
    }
  });

  it('E5 — HomeScreen: ScrollView 직후, effectiveOrigin 분기 앞에 배너', () => {
    const src = readFileSync(join(__dirname, '../../../../screens/HomeScreen.tsx'), 'utf8');
    expect(src).toMatch(
      /<ScrollView[\s\S]*?<BackendDegradedBanner tripActive=\{destination != null\} \/>\s*\{effectiveOrigin \?/,
    );
  });
});
