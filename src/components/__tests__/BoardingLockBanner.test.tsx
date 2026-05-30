import { fireEvent } from '@testing-library/react-native';
import { BoardingLockBanner } from '../BoardingLockBanner';
import { renderWithTheme } from '../../testUtils/renderWithTheme';
import type { BoardingLock } from '../../types/boardingLock';

const lock: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-100',
  boardingStationId: 'stn-A',
  boardingLine: '2',
  boardedAt: 1_700_000_000_000,
  expectedDurationMs: 600_000,
};

describe('BoardingLockBanner', () => {
  it('탑승 라벨 + 노선 배지 렌더 (trainCode raw 식별자는 노출 안 함 — #667)', () => {
    const { getByText, getByTestId, queryByText } = renderWithTheme(
      <BoardingLockBanner lock={lock} onRelease={() => {}} />,
    );
    expect(getByTestId('boarding-lock-banner')).toBeTruthy();
    expect(getByText('탑승')).toBeTruthy();
    expect(queryByText('T-100')).toBeNull();
  });

  it('#625 탑승 시각(boardedAt)을 HH:mm 절대 시각으로 표시', () => {
    const { getByTestId } = renderWithTheme(
      <BoardingLockBanner lock={lock} onRelease={() => {}} />,
    );
    const d = new Date(1_700_000_000_000);
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(getByTestId('boarding-lock-time').props.children).toBe(expected);
  });

  it('하차 버튼 탭 시 onRelease 호출', () => {
    const onRelease = jest.fn();
    const { getByTestId } = renderWithTheme(
      <BoardingLockBanner lock={lock} onRelease={onRelease} />,
    );
    fireEvent.press(getByTestId('boarding-lock-release'));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

});
