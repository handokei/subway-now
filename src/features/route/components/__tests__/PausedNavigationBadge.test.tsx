import React from 'react';
import { screen, act } from '@testing-library/react-native';
import { renderWithTheme } from '../../../../testUtils/renderWithTheme';
import { PausedNavigationBadge } from '../PausedNavigationBadge';
import { PAUSE_AUTO_END_MS } from '../../../../shared/constants/realtime';

describe('PausedNavigationBadge (#2293)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('일시정지됨 배지 렌더 + 남은 분 표시 (15분 전체)', () => {
    const onExpire = jest.fn();
    renderWithTheme(<PausedNavigationBadge pausedAt={1_000_000} onExpire={onExpire} />);
    expect(screen.getByTestId('paused-navigation-badge')).toBeTruthy();
    expect(screen.getByText('일시정지됨 · 경로 유지 · 15분 후 자동 종료')).toBeTruthy();
  });

  it('경과 시간에 따라 남은 분이 줄어듦', () => {
    const onExpire = jest.fn();
    // 5분 전 일시정지 → 10분 남음.
    renderWithTheme(
      <PausedNavigationBadge pausedAt={1_000_000 - 5 * 60_000} onExpire={onExpire} />,
    );
    expect(screen.getByText('일시정지됨 · 경로 유지 · 10분 후 자동 종료')).toBeTruthy();
  });

  it('PAUSE_AUTO_END_MS 경과 시 onExpire 1회 호출 (RED: cleanup chain 발사 트리거)', () => {
    const onExpire = jest.fn();
    renderWithTheme(<PausedNavigationBadge pausedAt={1_000_000} onExpire={onExpire} />);
    expect(onExpire).not.toHaveBeenCalled();

    act(() => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000_000 + PAUSE_AUTO_END_MS);
      jest.advanceTimersByTime(1_000);
    });

    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('만료 전에는 onExpire 호출 안 함', () => {
    const onExpire = jest.fn();
    renderWithTheme(<PausedNavigationBadge pausedAt={1_000_000} onExpire={onExpire} />);

    act(() => {
      jest.spyOn(Date, 'now').mockReturnValue(1_000_000 + PAUSE_AUTO_END_MS - 1_000);
      jest.advanceTimersByTime(1_000);
    });

    expect(onExpire).not.toHaveBeenCalled();
  });
});
