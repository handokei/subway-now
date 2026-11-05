import { fireEvent } from '@testing-library/react-native';
import { BoardingLockHopCard } from '../BoardingLockHopCard';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { LINE_COLORS, LINE_NAMES } from '../../../../shared/constants/lineColors';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const baseLock: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-100',
  boardingStationId: 'stn-A',
  boardingLine: '7',
  boardedAt: 1_700_000_000_000,
  expectedDurationMs: 600_000,
};

describe('BoardingLockHopCard (#758)', () => {
  it('"탑승 · 노선 · HH:mm" 메타 + 호선색 stripe 렌더', () => {
    const { getByTestId } = renderWithTheme(
      <BoardingLockHopCard lock={baseLock} onRelease={() => {}} />,
    );
    const card = getByTestId('boarding-lock-hop-card');
    expect(card).toBeTruthy();
    const stripeStyle = Array.isArray(card.props.style)
      ? Object.assign({}, ...card.props.style)
      : card.props.style;
    expect(stripeStyle.borderLeftColor).toBe(LINE_COLORS['7']);
    expect(stripeStyle.borderLeftWidth).toBeGreaterThan(0);

    const d = new Date(baseLock.boardedAt);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const meta = getByTestId('boarding-lock-hop-meta');
    expect(meta.props.children).toBe(`탑승 · ${LINE_NAMES['7']} · ${hhmm}`);
  });

  it('trainCode raw 식별자는 노출하지 않음 (#667 정신)', () => {
    const { queryByText } = renderWithTheme(
      <BoardingLockHopCard lock={baseLock} onRelease={() => {}} />,
    );
    expect(queryByText('T-100')).toBeNull();
  });

  it('하차 Pressable 탭 시 onRelease 호출', () => {
    const onRelease = jest.fn();
    const { getByTestId } = renderWithTheme(
      <BoardingLockHopCard lock={baseLock} onRelease={onRelease} />,
    );
    fireEvent.press(getByTestId('boarding-lock-hop-release'));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('다른 호선(lock.boardingLine 변경)이면 stripe 색이 바뀐다 — 노선 데이터 주도', () => {
    const { getByTestId } = renderWithTheme(
      <BoardingLockHopCard lock={{ ...baseLock, boardingLine: '2' }} onRelease={() => {}} />,
    );
    const card = getByTestId('boarding-lock-hop-card');
    const stripeStyle = Array.isArray(card.props.style)
      ? Object.assign({}, ...card.props.style)
      : card.props.style;
    expect(stripeStyle.borderLeftColor).toBe(LINE_COLORS['2']);
  });

  describe('#897 Seam A — 지연 칩', () => {
    const lockWithEta: BoardingLock = { ...baseLock, initialEtaSeconds: 120 };

    it('initialEtaSeconds 미설정 (레거시 lock) → 칩 미노출', () => {
      const { queryByTestId } = renderWithTheme(
        <BoardingLockHopCard lock={baseLock} onRelease={() => {}} currentEtaSeconds={600} />,
      );
      expect(queryByTestId('boarding-lock-hop-delay-chip')).toBeNull();
    });

    it('currentEtaSeconds 미전달 (lock train이 응답에 없음) → 칩 미노출', () => {
      const { queryByTestId } = renderWithTheme(
        <BoardingLockHopCard lock={lockWithEta} onRelease={() => {}} />,
      );
      expect(queryByTestId('boarding-lock-hop-delay-chip')).toBeNull();
    });

    it('차이 < 임계치(180s) → 칩 미노출', () => {
      const { queryByTestId } = renderWithTheme(
        <BoardingLockHopCard
          lock={lockWithEta}
          onRelease={() => {}}
          currentEtaSeconds={240}
        />,
      );
      expect(queryByTestId('boarding-lock-hop-delay-chip')).toBeNull();
    });

    it('차이 >= 임계치 → "+N분 지연" 칩 노출 (ceil)', () => {
      const { getByText } = renderWithTheme(
        <BoardingLockHopCard
          lock={lockWithEta}
          onRelease={() => {}}
          currentEtaSeconds={300}
        />,
      );
      // diff=180s → ceil(180/60)=3분.
      expect(getByText('+3분 지연')).toBeTruthy();
    });

    it('회귀 fixture — initial 90s에서 동일 90s 폴 → 칩 미노출', () => {
      const { queryByTestId } = renderWithTheme(
        <BoardingLockHopCard
          lock={{ ...baseLock, initialEtaSeconds: 90 }}
          onRelease={() => {}}
          currentEtaSeconds={90}
        />,
      );
      expect(queryByTestId('boarding-lock-hop-delay-chip')).toBeNull();
    });

    it('회귀 fixture — initial 90s에서 누적 +4분(240s) 지연 → "+4분 지연"', () => {
      // "1분 30초 → 1분 더 지연" 시나리오에서 추가 폴링까지 누적된 케이스.
      const { getByText } = renderWithTheme(
        <BoardingLockHopCard
          lock={{ ...baseLock, initialEtaSeconds: 90 }}
          onRelease={() => {}}
          currentEtaSeconds={330}
        />,
      );
      // diff=240s → ceil(240/60)=4분.
      expect(getByText('+4분 지연')).toBeTruthy();
    });

    it('initialEtaSeconds=0 (임박 열차 lock) → 칩 미노출 (baseline 0은 의미 없음)', () => {
      // useBoardingLockController가 arrivalSeconds=0 train 탭을 허용 → initialEtaSeconds=0 lock 가능.
      // baseline이 없는 상태에서 currentEta가 큰 값으로 잡혀도 false positive 차단.
      const { queryByTestId } = renderWithTheme(
        <BoardingLockHopCard
          lock={{ ...baseLock, initialEtaSeconds: 0 }}
          onRelease={() => {}}
          currentEtaSeconds={300}
        />,
      );
      expect(queryByTestId('boarding-lock-hop-delay-chip')).toBeNull();
    });
  });
});
