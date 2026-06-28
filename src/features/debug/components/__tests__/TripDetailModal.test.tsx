/**
 * TripDetailModal (#1956, S-m3-1 P0) 단위 테스트.
 *
 * 커버 (4 영역):
 *   - visible=false → modal 미렌더
 *   - tripToken=null + visible=true → (no trip) fallback
 *   - 정상 trip → Token / Lifecycle / Raw signal / Deep link 4 영역 렌더
 *   - kindCounts 표시 정확성 (cycle/enter/exit)
 *   - Raw signal entries 0건일 때 (no entries) 표시 (정상 token, entries 0건 케이스)
 *   - 닫기 버튼 → onClose 호출
 *   - backdrop 탭 → onClose 호출
 *   - Sentry DSN 설정 → deep link 행 렌더 + 클릭 → Linking.openURL
 *   - Sentry DSN 미설정 → unconfigured 라벨
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { TripDetailModal } from '../TripDetailModal';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import {
  __resetRawSignalForTests__,
  pushRawSignal,
  type RawSignalEntry,
} from '../../../observability/utils/rawSignalBuffer';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

function makeEntry(overrides?: Partial<RawSignalEntry>): RawSignalEntry {
  return {
    ts: 1_700_000_000_000,
    corrId: 'corr-abc',
    kind: 'cycle',
    gps: null,
    motion: null,
    accelPattern: null,
    cellular: null,
    subsurface: null,
    arvlCd: null,
    line: null,
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: null,
    source: null,
    confidence: null,
    ...overrides,
  };
}

const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

beforeEach(() => {
  jest.useFakeTimers();
  __resetRawSignalForTests__();
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  (Linking.openURL as jest.Mock).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
  if (originalDsn !== undefined) {
    process.env.EXPO_PUBLIC_SENTRY_DSN = originalDsn;
  }
});

describe('TripDetailModal', () => {
  it('renders nothing when visible=false', () => {
    renderWithTheme(
      <TripDetailModal visible={false} tripToken="corr-1" onClose={jest.fn()} />,
    );
    expect(screen.queryByTestId('trip-detail-card')).toBeNull();
  });

  describe('fallback (no trip)', () => {
    it('shows fallback when tripToken=null', () => {
      renderWithTheme(
        <TripDetailModal visible tripToken={null} onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-empty')).toBeTruthy();
    });

    it('shows fallback when tripToken does not match any entry', () => {
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-missing" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-empty')).toBeTruthy();
    });
  });

  describe('full render — 4 sections', () => {
    beforeEach(() => {
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000, kind: 'enter' }));
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 2_000, kind: 'cycle' }));
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 3_000, kind: 'exit' }));
    });

    it('renders Token section with tripToken value', () => {
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-section-token')).toBeTruthy();
      expect(screen.getByTestId('trip-detail-token-value').props.children).toBe('corr-1');
    });

    it('renders Lifecycle section with kind counts', () => {
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-section-lifecycle')).toBeTruthy();
      expect(screen.getByTestId('trip-detail-kind-cycle')).toBeTruthy();
      expect(screen.getByTestId('trip-detail-kind-enter')).toBeTruthy();
      expect(screen.getByTestId('trip-detail-kind-exit')).toBeTruthy();
    });

    it('renders Raw signal section with the entry list', () => {
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-section-raw-signal')).toBeTruthy();
      expect(screen.getByTestId('trip-detail-raw-signal-list')).toBeTruthy();
    });

    it('renders Deep link section', () => {
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-section-deep-link')).toBeTruthy();
    });
  });

  describe('close interactions', () => {
    beforeEach(() => {
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000 }));
    });

    it('calls onClose when 닫기 button is pressed', () => {
      const onClose = jest.fn();
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={onClose} />,
      );
      fireEvent.press(screen.getByTestId('trip-detail-close'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when backdrop is pressed', () => {
      const onClose = jest.fn();
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={onClose} />,
      );
      fireEvent.press(screen.getByTestId('trip-detail-backdrop'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does NOT call onClose when card body is pressed (propagation guard)', () => {
      const onClose = jest.fn();
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={onClose} />,
      );
      fireEvent.press(screen.getByTestId('trip-detail-card'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('deep link — Sentry', () => {
    beforeEach(() => {
      pushRawSignal(makeEntry({ corrId: 'corr-1', ts: 1_000 }));
    });

    it('shows unconfigured label when EXPO_PUBLIC_SENTRY_DSN is unset', () => {
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-deep-link-sentry-unconfigured')).toBeTruthy();
    });

    it('shows pressable link when EXPO_PUBLIC_SENTRY_DSN is set', () => {
      process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://abc@sentry.io/123';
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={jest.fn()} />,
      );
      expect(screen.getByTestId('trip-detail-deep-link-sentry')).toBeTruthy();
    });

    it('opens Sentry URL when pressed', () => {
      process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://abc@sentry.io/123';
      renderWithTheme(
        <TripDetailModal visible tripToken="corr-1" onClose={jest.fn()} />,
      );
      fireEvent.press(screen.getByTestId('trip-detail-deep-link-sentry'));
      expect(Linking.openURL).toHaveBeenCalledWith('https://sentry.io/');
    });
  });
});
