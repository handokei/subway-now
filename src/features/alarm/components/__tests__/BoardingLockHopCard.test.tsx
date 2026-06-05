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
});
