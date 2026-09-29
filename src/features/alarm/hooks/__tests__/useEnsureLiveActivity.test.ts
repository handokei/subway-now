/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
/**
 * #2828 — LA가 트립 내내 안 뜸(START가 FG pre-lock 윈도우에서만 발생) fix. 새 FG ensure 훅이
 * "lock 이후 / BG 재개 시 아무도 LA를 start 안 하던" 갭을 채우는지 순수 JS 결정 레벨로 검증한다.
 */
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockIsLiveActivityEnabled = jest.fn();
const mockHasActiveLiveActivity = jest.fn();
const mockUpdateLiveActivity = jest.fn();

jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  hasActiveLiveActivity: () => mockHasActiveLiveActivity(),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
}));

const mockBuildLiveActivityData = jest.fn(() => ({ stationName: '강남', lineName: '2호선' }));
jest.mock('../../utils/stationNotification', () => ({
  buildLiveActivityData: (...args: unknown[]) => mockBuildLiveActivityData(...args),
}));

const mockWarn = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  }),
}));

import { useEnsureLiveActivity } from '../useEnsureLiveActivity';

const { gangnam, chungmuro } = MOCK_STATIONS;

const LOCK: BoardingLock = {
  trainCode: 'T001',
  boardingLine: gangnam.line,
  boardingStationId: gangnam.id,
  destinationId: chungmuro.id,
  boardingEvidence: true,
  boardedAt: Date.now(),
  expectedDurationMs: 5 * 60 * 1000,
};

function setAppState(state: 'active' | 'background') {
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => state,
  });
}

describe('useEnsureLiveActivity', () => {
  let appStateListener: ((state: string) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLiveActivityEnabled.mockReturnValue(true);
    mockHasActiveLiveActivity.mockReturnValue(false);
    mockUpdateLiveActivity.mockResolvedValue(undefined);
    setAppState('active');
    appStateListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, cb: (state: string) => void) => {
      appStateListener = cb;
      return { remove: jest.fn() };
    }) as never);
  });

  it('FG active + 트립 활성(lock 있음) + hasActiveLiveActivity=false → updateLiveActivity 1회 호출', () => {
    renderHook(() =>
      useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK),
    );
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    expect(mockBuildLiveActivityData).toHaveBeenCalledWith(gangnam, 120, chungmuro, null, 5);
  });

  it('hasActiveLiveActivity=true → 호출하지 않는다 (멱등)', () => {
    mockHasActiveLiveActivity.mockReturnValue(true);
    renderHook(() => useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('isLiveActivityEnabled=false → 호출하지 않는다', () => {
    mockIsLiveActivityEnabled.mockReturnValue(false);
    renderHook(() => useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('AppState background → 호출하지 않는다', () => {
    setAppState('background');
    renderHook(() => useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('트립 비활성(lock 없음 + destination 없음) → 호출하지 않는다', () => {
    renderHook(() => useEnsureLiveActivity(gangnam, 120, null, null, 5, null));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('currentStation 없음 → 호출하지 않는다', () => {
    renderHook(() => useEnsureLiveActivity(null, 120, chungmuro, null, 5, LOCK));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('재렌더 멱등 — 첫 호출 후 hasActiveLiveActivity=true로 전환되면 중복 호출 없음', () => {
    const { rerender } = renderHook(
      ({ distanceM }) => useEnsureLiveActivity(gangnam, distanceM, chungmuro, null, 5, LOCK),
      { initialProps: { distanceM: 120 } },
    );
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    mockHasActiveLiveActivity.mockReturnValue(true);
    rerender({ distanceM: 100 });
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('BG → FG 복귀(AppState change) → 조건 충족 시 updateLiveActivity 호출', () => {
    setAppState('background');
    renderHook(() => useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();

    setAppState('active');
    act(() => {
      appStateListener?.('active');
    });
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });
});
