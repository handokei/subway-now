/* eslint-disable import/no-restricted-paths --
 * Cross-feature test mirroring source's disable. ADR Phase 5 (#890).
 */
import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { useDestinationStore } from '../../../route/store/useDestinationStore';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockIsLiveActivityEnabled = jest.fn();
const mockUpdateLiveActivity = jest.fn();

jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  // #2667 — 이 훅의 update 직전에 ambient token 구독(멱등)이 시작된다. 구독 자체의 동작은
  // liveActivityPushChannel.test.ts가 검증하므로 여기서는 API 존재만 채운다.
  addPushTokenListener: () => ({ remove: () => undefined }),
}));

const mockClearStationNotification = jest.fn();
jest.mock('../../utils/stationNotification', () => ({
  clearStationNotification: (...args: unknown[]) => mockClearStationNotification(...args),
}));

const mockGetCurrentTripCorrIdSync = jest.fn<string | null, []>(() => null);
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));

const mockLogLaWrite = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  ...jest.requireActual('../../utils/alarmLog'),
  logLaWrite: (...args: unknown[]) => mockLogLaWrite(...args),
}));

const mockWarn = jest.fn();
const mockInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: (...args: unknown[]) => mockInfo(...args),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  }),
}));

// #2782 — getStationById만 제어, isStationOnRoute 등 나머지는 실제 구현을 통과시킨다
// (resolveGpsFreeOrigin의 R-3 route 필터 정확성을 그대로 검증하기 위함).
const mockGetStationById = jest.fn<ReturnType<typeof import('../../../../shared/utils/stationRoute').getStationById>, [string]>();
jest.mock('../../../../shared/utils/stationRoute', () => {
  const actual = jest.requireActual('../../../../shared/utils/stationRoute');
  return {
    ...actual,
    getStationById: (...args: [string]) => mockGetStationById(...args),
  };
});

// #2735 PR-4 — D6(auto-locked pre-boarding)는 backend 권위 게이트를 받는다. 판정 자체는
// liveActivityPushChannel.test.ts가 검증하고, 여기서는 wire-up만 본다(기본: 권위 아님).
const mockShouldSkipDeviceLiveActivityWrite = jest.fn(async (..._args: unknown[]) => false);
jest.mock('../../utils/liveActivityPushChannel', () => ({
  ...jest.requireActual('../../utils/liveActivityPushChannel'),
  shouldSkipDeviceLiveActivityWrite: (...args: unknown[]) => mockShouldSkipDeviceLiveActivityWrite(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';
import { useLiveActivityPreBoardingLifecycle } from '../useLiveActivityPreBoardingLifecycle';

/** 게이트 판정(storage 읽기 + await)과 update 체인이 모두 끝날 때까지 이벤트 루프를 비운다. */
const flushAll = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const { gangnam, chungmuro, hyochang } = MOCK_STATIONS;

const LOCK: BoardingLock = {
  trainCode: 'T001',
  boardingLine: gangnam.line,
  boardingStationId: gangnam.id,
  destinationId: chungmuro.id,
  boardingEvidence: true,
  boardedAt: Date.now(),
  expectedDurationMs: 5 * 60 * 1000,
};

describe('useLiveActivityPreBoardingLifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLiveActivityEnabled.mockReturnValue(true);
    mockUpdateLiveActivity.mockResolvedValue(undefined);
    mockClearStationNotification.mockResolvedValue(undefined);
    // 기본값: lock.boardingStationId로 resolve 안 됨(미기재 테스트는 tripOrigin fallback으로 귀결).
    mockGetStationById.mockReturnValue(undefined);
    mockShouldSkipDeviceLiveActivityWrite.mockResolvedValue(false);
    useDestinationStore.setState({ destination: null, tripOrigin: null, customOrigin: null });
    useBoardingLockStore.setState({ lock: null });
  });

  it('destination 없음 + lock 없음 → 아무 것도 하지 않는다', () => {
    renderHook(() => useLiveActivityPreBoardingLifecycle(null));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(mockClearStationNotification).not.toHaveBeenCalled();
  });

  it('destination 설정(lock 없음) → #2854 평범한 추적 content만 update(boardingPhase 미설정 — 유령 배너 제거)', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(null));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.boardingPhase).toBeUndefined();
    expect(data.destinationName).toBeTruthy();
    // GPS 미확정 — placeholder stationName ("감지 중" i18n)
    expect(data.stationName).toBe('감지 중');
    expect(data.boardingPromptOriginStation).toBeUndefined();
  });

  // #2735 PR-1 — D5(pre-boarding 시작/갱신)·D6(auto-locked pre-boarding) 쓰기 관측.
  describe('#2735 PR-1 la-write (D5/D6)', () => {
    const flush = () =>
      act(async () => {
        await Promise.resolve();
      });

    it('D5 — pre-boarding update 성공 후 source=pre-boarding, 권위 n/a로 1건', async () => {
      useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
      renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
      await flush();
      expect(mockLogLaWrite).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).toHaveBeenCalledWith({
        writer: 'D5',
        source: 'pre-boarding',
        data: expect.objectContaining({ stationName: gangnam.name }),
        authority: 'n/a',
      });
    });

    it('D5 — native update가 실패하면 적재하지 않는다', async () => {
      mockUpdateLiveActivity.mockRejectedValueOnce(new Error('native down'));
      useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
      renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
      await flush();
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });

    it('D6 — evidence 있는 lock 전환 시 auto-locked 갱신 성공 후 source=auto-locked-pre-boarding으로 1건 추가', async () => {
      useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
      const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
      await flush();
      mockLogLaWrite.mockClear();

      act(() => {
        useBoardingLockStore.setState({ lock: LOCK });
      });
      rerender({});
      await flushAll();

      expect(mockLogLaWrite).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).toHaveBeenCalledWith({
        writer: 'D6',
        source: 'auto-locked-pre-boarding',
        data: expect.objectContaining({ boardingAutoLocked: true }),
        authority: 'not-active',
      });
    });

    it('D6 — auto-locked 갱신이 실패하면 적재하지 않는다', async () => {
      useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
      const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
      await flush();
      mockLogLaWrite.mockClear();
      mockUpdateLiveActivity.mockRejectedValueOnce(new Error('native down'));

      act(() => {
        useBoardingLockStore.setState({ lock: LOCK });
      });
      rerender({});
      await flushAll();

      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });

    it('lock 전환이 evidence 없으면(native 호출 없음) 적재하지 않는다', async () => {
      useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
      useBoardingLockStore.setState({ lock: { ...LOCK, boardingEvidence: false } });
      renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
      await flush();
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });
  });

  it('tripOrigin 확보돼도 #2854 — boardingPhase 미설정이므로 #2434 버튼 컨텍스트 필드도 싣지 않는다', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.stationName).toBe(gangnam.name);
    expect(data.lineColorHex).toBe(gangnam.lineColor);
    expect(data.boardingPhase).toBeUndefined();
    expect(data.boardingPromptOriginStation).toBeUndefined();
    expect(data.boardingPromptLine).toBeUndefined();
    expect(data.boardingAlertTitle).toBeUndefined();
    expect(data.boardingAlertBody).toBeUndefined();
  });

  it('#2854 — tripToken이 있어도 시작 시 content엔 boardingPromptTripToken을 싣지 않는다(phase 없는 content는 버튼 컨텍스트 무의미)', () => {
    mockGetCurrentTripCorrIdSync.mockReturnValue('corr-123');
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(null));
    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.boardingPromptTripToken).toBeUndefined();
  });

  it('이미 GPS 경로로 LA가 떠 있어도(활성 세션 판단 불가) 이 훅은 native update만 호출한다 — start 이중 호출 없음', () => {
    // ensureLiveActivityRegistered/startLiveActivity 경로를 타지 않는지 — updateLiveActivity만 호출됐는지 검증.
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('lock 생성됨 → 콘텐츠 소유권을 넘기고 이 훅은 native 호출을 하지 않는다', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    useBoardingLockStore.setState({ lock: LOCK });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(mockClearStationNotification).not.toHaveBeenCalled();
  });

  it('pre-boarding 세션을 스스로 시작한 뒤 lock이 생성되고, 이후 destination이 해제돼도 종료 호출을 하지 않는다(GPS 파이프라인 책임)', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useBoardingLockStore.setState({ lock: LOCK });
    });
    rerender({});

    act(() => {
      useDestinationStore.setState({ destination: null, tripOrigin: null, customOrigin: null });
    });
    rerender({});

    expect(mockClearStationNotification).not.toHaveBeenCalled();
  });

  it('스스로 시작한 pre-boarding 세션 중 destination이 해제되면 clearStationNotification으로 종료', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useDestinationStore.setState({ destination: null, tripOrigin: null, customOrigin: null });
    });
    rerender({});

    expect(mockClearStationNotification).toHaveBeenCalledTimes(1);
  });

  it('#2528 — evidence 있는 lock으로 전환 시 추적중(auto-locked) 배너로 한 번 더 update한다', async () => {
    mockGetCurrentTripCorrIdSync.mockReturnValue('corr-999');
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useBoardingLockStore.setState({ lock: LOCK }); // LOCK.boardingEvidence === true
    });
    rerender({});
    await flushAll();

    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
    const autoLockedData = mockUpdateLiveActivity.mock.calls[1][0];
    expect(autoLockedData.boardingPhase).toBe('pre-boarding');
    expect(autoLockedData.boardingAutoLocked).toBe(true);
    expect(autoLockedData.boardingAlertTitle).toBeUndefined();
    expect(autoLockedData.boardingPromptTripToken).toBe('corr-999');
  });

  it('#2528 — tripToken 없이 evidence 있는 lock으로 전환되면 boardingPromptTripToken 없이 추적중 배너를 갱신한다', async () => {
    mockGetCurrentTripCorrIdSync.mockReturnValue(null);
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useBoardingLockStore.setState({ lock: LOCK });
    });
    rerender({});
    await flushAll();

    const autoLockedData = mockUpdateLiveActivity.mock.calls[1][0];
    expect(autoLockedData.boardingAutoLocked).toBe(true);
    expect(autoLockedData.boardingPromptTripToken).toBeUndefined();
  });

  it('#2528 — evidence 없는(사용자 tap/응답) lock으로 전환되면 추가 update 없이 조용히 소유권만 넘긴다', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);

    act(() => {
      useBoardingLockStore.setState({ lock: { ...LOCK, boardingEvidence: undefined } });
    });
    rerender({});

    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('#2528 — auto-locked LA 갱신이 throw하면 logger.warn으로 흡수', async () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    mockUpdateLiveActivity.mockRejectedValueOnce(new Error('auto-lock update fail'));

    act(() => {
      useBoardingLockStore.setState({ lock: LOCK });
    });
    rerender({});
    await flushAll();

    expect(mockWarn).toHaveBeenCalledWith('auto-locked pre-boarding LA 갱신 실패', expect.any(Error));
  });

  // #2735 PR-4 — D6 게이트. backend가 LA를 갱신 중이면 auto-locked "추적중" 배너 update를 skip한다.
  describe('#2735 PR-4 D6 backend 권위 게이트', () => {
    const lockTransition = async () => {
      useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
      const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1); // D5
      await flushAll(); // D5의 la-write(비동기)가 끝난 뒤에 비운다
      mockLogLaWrite.mockClear();
      act(() => {
        useBoardingLockStore.setState({ lock: LOCK });
      });
      rerender({});
      await flushAll();
    };

    it('권위 active면 auto-locked update도 la-write도 없다 — 판정은 ACTIVE_TRIP_KEY 기준', async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'apns-token-abc');
      mockShouldSkipDeviceLiveActivityWrite.mockResolvedValue(true);
      await lockTransition();
      expect(mockShouldSkipDeviceLiveActivityWrite).toHaveBeenCalledWith('apns-token-abc');
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).not.toHaveBeenCalled();
      await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
    });

    it('[거부] 권위가 아니면 auto-locked update + D6 la-write 그대로', async () => {
      await lockTransition();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
      expect(mockLogLaWrite).toHaveBeenCalledWith(expect.objectContaining({ writer: 'D6' }));
    });
  });

  it('Android — 아무 것도 하지 않는다', () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, 'OS', { get: () => 'android' });
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    Object.defineProperty(Platform, 'OS', { get: () => originalOS });
  });

  it('Live Activity 비활성이면 update를 호출하지 않는다', () => {
    mockIsLiveActivityEnabled.mockReturnValue(false);
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(null));
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('updateLiveActivity가 throw하면 logger.warn으로 흡수', async () => {
    mockUpdateLiveActivity.mockRejectedValueOnce(new Error('native fail'));
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(null));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockWarn).toHaveBeenCalledWith('pre-boarding LA 갱신 실패', expect.any(Error));
  });

  it('clearStationNotification이 throw하면 logger.warn으로 흡수', async () => {
    mockClearStationNotification.mockRejectedValueOnce(new Error('end fail'));
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));
    act(() => {
      useDestinationStore.setState({ destination: null, tripOrigin: null, customOrigin: null });
    });
    rerender({});
    await Promise.resolve();
    await Promise.resolve();
    expect(mockWarn).toHaveBeenCalledWith('pre-boarding LA 종료 실패', expect.any(Error));
  });

  // ──────────────────────────────────────────────────────────────────────
  // #2782 — resolveGpsFreeOrigin 연결 (갱신된 요구사항 1~3)
  // ──────────────────────────────────────────────────────────────────────

  it('(#2782 red①) tripOrigin=null + customOrigin=hyochang → resolveGpsFreeOrigin으로 customOrigin이 pre-boarding 표시에 반영된다', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null, customOrigin: hyochang });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(3, hyochang.line)));

    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.stationName).toBe(hyochang.name);
    expect(data.lineColorHex).toBe(hyochang.lineColor);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('source=custom'));
  });

  it('(#2782) customOrigin이 route 밖 노선이면(R-3) 건너뛰고 다음 후보(tripOrigin)로 fallback한다', () => {
    // customOrigin(hyochang, line 6)은 route(line 2)에 없어 걸러지고, tripOrigin(gangnam, line 2)이 채택된다.
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: hyochang });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));

    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.stationName).toBe(gangnam.name);
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('source=trip'));
  });

  it('(#2782) boardingLockStation이 resolve되면(customOrigin 없음) lock 후보가 tripOrigin보다 우선한다', () => {
    mockGetStationById.mockImplementation((id: string) => (id === LOCK.boardingStationId ? gangnam : undefined));
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null, customOrigin: null });
    useBoardingLockStore.setState({ lock: LOCK });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));

    // lock이 이미 활성이라 이 훅 자체는 콘텐츠를 발사하지 않지만(소유권 이전), 해석 로그는 남는다.
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('source=lock'));
  });

  it('(#2782 거부) tripOrigin만 있을 때는 기존 동작 100% 불변(R-2 동형) — customOrigin/lock 후보가 없어도 동일 결과', () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: gangnam, customOrigin: null });
    renderHook(() => useLiveActivityPreBoardingLifecycle(makeDirectRoute(5, gangnam.line)));

    const data = mockUpdateLiveActivity.mock.calls[0][0];
    expect(data.stationName).toBe(gangnam.name);
    expect(data.lineName).toBeTruthy();
    expect(data.lineColorHex).toBe(gangnam.lineColor);
  });

  it('(#2782 red②) 후보 전부 null(route도 없음)이어도 auto-locked 전환 시 boardingPhase/boardingAutoLocked 버튼 필드는 유지된다', async () => {
    useDestinationStore.setState({ destination: chungmuro, tripOrigin: null, customOrigin: null });
    const { rerender } = renderHook(() => useLiveActivityPreBoardingLifecycle(null));
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    const initial = mockUpdateLiveActivity.mock.calls[0][0];
    // 요구 2 — "어느 역인지 모름"은 widget.detecting 표시로 유지.
    expect(initial.stationName).toBe('감지 중');

    act(() => {
      useBoardingLockStore.setState({ lock: LOCK }); // LOCK.boardingEvidence === true
    });
    rerender({});
    await flushAll();

    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
    const autoLockedData = mockUpdateLiveActivity.mock.calls[1][0];
    expect(autoLockedData.boardingPhase).toBe('pre-boarding');
    expect(autoLockedData.boardingAutoLocked).toBe(true);
    expect(autoLockedData.boardingPromptOriginStation).toBeUndefined();
    expect(autoLockedData.boardingPromptLine).toBeUndefined();
    expect(autoLockedData.stationName).toBe('감지 중');
    expect(mockInfo).toHaveBeenLastCalledWith(expect.stringContaining('source=none'));
  });
});
