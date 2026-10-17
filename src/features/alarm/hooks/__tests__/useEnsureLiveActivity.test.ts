/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
/**
 * #2828 — LA가 트립 내내 안 뜸(START가 FG pre-lock 윈도우에서만 발생) fix. 새 FG ensure 훅이
 * "lock 이후 / BG 재개 시 아무도 LA를 start 안 하던" 갭을 채우는지 순수 JS 결정 레벨로 검증한다.
 */
import { act, renderHook } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import { getStationsOnLine } from '../../../../shared/utils/stationRoute';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockIsLiveActivityEnabled = jest.fn();
const mockHasActiveLiveActivity = jest.fn();
const mockUpdateLiveActivity = jest.fn();

jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  hasActiveLiveActivity: () => mockHasActiveLiveActivity(),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
}));

const mockBuildLiveActivityData = jest.fn((..._args: unknown[]) => ({ stationName: '강남', lineName: '2호선' }));
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
      ({ distanceM }: { distanceM: number }) => useEnsureLiveActivity(gangnam, distanceM, chungmuro, null, 5, LOCK),
      { initialProps: { distanceM: 120 } },
    );
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    mockHasActiveLiveActivity.mockReturnValue(true);
    rerender({ distanceM: 100 });
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('Android → 아무 것도 하지 않는다 (iOS 전용)', () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { get: () => 'android' });
    try {
      renderHook(() => useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK));
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', { get: () => originalOS });
    }
  });

  it('updateLiveActivity 실패 시 경고 로그만 남기고 throw하지 않는다', async () => {
    const rejection = new Error('native update 실패');
    mockUpdateLiveActivity.mockRejectedValueOnce(rejection);
    renderHook(() => useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockWarn).toHaveBeenCalledWith('LA ensure 갱신 실패', rejection);
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

  it('AppState change가 active가 아니면 호출하지 않는다', () => {
    setAppState('background');
    renderHook(() => useEnsureLiveActivity(gangnam, 120, chungmuro, null, 5, LOCK));
    act(() => {
      appStateListener?.('inactive');
    });
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  // #2811 편측 감사 — 이 훅은 etaMinutes는 이미 caller(HomeScreen)가 currentStation 기준으로
  // 재앵커링해 전달하지만, route는 트립 시작 시점에 고정된 값을 그대로 받아 buildLiveActivityData에
  // 넘겼다 — "ETA는 줄어드는데 N정거장은 트립 시작값 그대로"인 자기모순(#2848 편측 감사 지적).
  // route도 currentStation 기준으로 재앵커링해서 buildLiveActivityData에 넘겨야 한다.
  it('#2811 편측 감사: route도 currentStation 기준 remaining으로 재앵커링해 buildLiveActivityData에 넘긴다', () => {
    // 성수(2-011) → 뚝섬(2-010) 실제 인접 1정거장. staleRoute는 트립 시작 시점 고정값(5정거장)을
    // 흉내 — fix 전에는 이 값이 그대로 buildLiveActivityData에 전달돼 self-contradiction이 난다.
    const seongsu = getStationsOnLine('2').find((s) => s.id === '2-011')!;
    const ddukseom = getStationsOnLine('2').find((s) => s.id === '2-010')!;
    const staleRoute = { type: 'direct' as const, line: '2' as const, stops: 5, travelSeconds: 600 };
    renderHook(() => useEnsureLiveActivity(seongsu, 50, ddukseom, staleRoute, 2, null));
    expect(mockBuildLiveActivityData).toHaveBeenCalledTimes(1);
    const [, , , routeArg] = mockBuildLiveActivityData.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { type: string; stops: number },
    ];
    // 회귀 상태(fix 전)라면 routeArg === staleRoute(stops:5)로 실패한다.
    expect(routeArg.stops).toBe(1);
  });

  it('#2811 편측 감사: destination이 없으면(lock만으로 트립 활성) route를 그대로 전달한다(anchor 대상 없음)', () => {
    const staleRoute = { type: 'direct' as const, line: '2' as const, stops: 5, travelSeconds: 600 };
    renderHook(() => useEnsureLiveActivity(gangnam, 120, null, staleRoute, 5, LOCK));
    expect(mockBuildLiveActivityData).toHaveBeenCalledWith(gangnam, 120, null, staleRoute, 5);
  });
});
