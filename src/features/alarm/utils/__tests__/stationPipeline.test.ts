import type { Station, NearestStationResult } from '../../../../shared/types/station';
import type { Route, DirectRoute } from '../../../../shared/utils/stationRoute';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';
import type { AlarmEvent } from '../stationAlarm';

const mockFindNearestStation = jest.fn();
jest.mock('../../../nearest-station/utils/findNearestStation', () => ({
  findNearestStation: (...args: unknown[]) => mockFindNearestStation(...args),
}));

const mockFindRoute = jest.fn();
const mockCalculateStaticETA = jest.fn();
const mockUpdateRouteFromPosition = jest.fn();
const mockIsStationOnRoute = jest.fn();
const mockIsSameStationName = jest.fn((a: string, b: string) => a === b);
const mockGetFirstLeg = jest.fn((..._args: unknown[]) => ({ line: '2', endName: '' }));
jest.mock('../../../../shared/utils/stationRoute', () => ({
  findRoute: (...args: unknown[]) => mockFindRoute(...args),
  calculateStaticETA: (...args: unknown[]) => mockCalculateStaticETA(...args),
  updateRouteFromPosition: (...args: unknown[]) => mockUpdateRouteFromPosition(...args),
  isStationOnRoute: (...args: unknown[]) => mockIsStationOnRoute(...args),
  isSameStationName: (a: string, b: string) => mockIsSameStationName(a, b),
  getFirstLeg: (...args: unknown[]) => mockGetFirstLeg(...args),
}));

const mockEvaluateAlarmPhase = jest.fn();
const mockAlarmKey = jest.fn();
const mockResolveAllTargets = jest.fn((..._args: unknown[]) => [] as Array<{ name: string; stops: number; alarmType: 'destination' | 'transfer'; approachLine: string }>);
jest.mock('../stationAlarm', () => ({
  evaluateAlarmPhase: (...args: unknown[]) => mockEvaluateAlarmPhase(...args),
  alarmKey: (...args: unknown[]) => mockAlarmKey(...args),
  resolveAllTargets: (...args: unknown[]) => mockResolveAllTargets(...args),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../boardingLockStorage', () => ({
  getBoardingLock: () => mockGetBoardingLock(),
}));

const mockGetDismissSilence = jest.fn();
const mockClearDismissSilence = jest.fn();
jest.mock('../dismissSilenceStorage', () => ({
  getDismissSilence: (...args: unknown[]) => mockGetDismissSilence(...args),
  clearDismissSilence: (...args: unknown[]) => mockClearDismissSilence(...args),
}));

const mockAdvanceHopWindow = jest.fn().mockResolvedValue(undefined);
jest.mock('../boardingLockScheduler', () => ({
  advanceHopWindow: (...args: unknown[]) => mockAdvanceHopWindow(...args),
}));

const mockUpdateStationNotification = jest.fn();
const mockSendStationPassedNotification = jest.fn();
jest.mock('../stationNotification', () => ({
  updateStationNotification: (...args: unknown[]) => mockUpdateStationNotification(...args),
  sendStationPassedNotification: (...args: unknown[]) => mockSendStationPassedNotification(...args),
}));

const mockGetLastNotifiedStationId = jest.fn();
const mockSetLastNotifiedStationId = jest.fn();
jest.mock('../notificationState', () => ({
  getLastNotifiedStationId: (...args: unknown[]) => mockGetLastNotifiedStationId(...args),
  setLastNotifiedStationId: (...args: unknown[]) => mockSetLastNotifiedStationId(...args),
}));

const mockLogFiredAlarm = jest.fn();
const mockLogFiredStationPassed = jest.fn();
const mockLogSuppressedDedupStation = jest.fn();
const mockLogSuppressedDedupAlarm = jest.fn();
const mockLogSuppressedSleepFirstTransfer = jest.fn();
const mockLogSuppressedSleepStationPassed = jest.fn();
const mockLogSuppressedDismissSilence = jest.fn();
const mockLogSuppressedCrossCategoryDedup = jest.fn();
const mockLogSuppressedCrossCategoryRecent = jest.fn();
const mockLogSuppressedPhaseToPhaseDedup = jest.fn();
const mockLogSuppressedChannelAgnosticDedup = jest.fn();
jest.mock('../alarmLog', () => ({
  logFiredAlarm: (...args: unknown[]) => mockLogFiredAlarm(...args),
  logFiredStationPassed: (...args: unknown[]) => mockLogFiredStationPassed(...args),
  logSuppressedDedupStation: (...args: unknown[]) => mockLogSuppressedDedupStation(...args),
  logSuppressedDedupAlarm: (...args: unknown[]) => mockLogSuppressedDedupAlarm(...args),
  logSuppressedSleepFirstTransfer: (...args: unknown[]) =>
    mockLogSuppressedSleepFirstTransfer(...args),
  logSuppressedSleepStationPassed: (...args: unknown[]) =>
    mockLogSuppressedSleepStationPassed(...args),
  logSuppressedDismissSilence: (...args: unknown[]) => mockLogSuppressedDismissSilence(...args),
  logSuppressedCrossCategoryDedup: (...args: unknown[]) =>
    mockLogSuppressedCrossCategoryDedup(...args),
  logSuppressedCrossCategoryRecent: (...args: unknown[]) =>
    mockLogSuppressedCrossCategoryRecent(...args),
  logSuppressedPhaseToPhaseDedup: (...args: unknown[]) =>
    mockLogSuppressedPhaseToPhaseDedup(...args),
  logSuppressedChannelAgnosticDedup: (...args: unknown[]) =>
    mockLogSuppressedChannelAgnosticDedup(...args),
}));

import { processLocationUpdate, resolveNextTarget } from '../stationPipeline';

const mockStation: Station = {
  id: 'station-1',
  name: '강남',
  line: '2',
  lineColor: '#009246',
  lat: 37.498,
  lng: 127.028,
};

const mockDestination: Station = {
  id: 'station-2',
  name: '시청',
  line: '1',
  lineColor: '#0052A4',
  lat: 37.565,
  lng: 126.977,
};

const mockNearestResult: NearestStationResult = {
  station: mockStation,
  distanceKm: 0.15,
};

const mockRoute = makeDirectRoute(3, '2');
const mockAlarmEvent: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '시청' };

function call(overrides: Partial<Parameters<typeof processLocationUpdate>[0]> = {}) {
  return processLocationUpdate({
    lat: 37.498,
    lng: 127.028,
    destination: mockDestination,
    firedAlarms: new Set(),
    sleepMode: false,
    source: 'bg',
    ...overrides,
  });
}

describe('processLocationUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // #1515 — cross-category dedup module 상태는 mock 대상이 아니므로 명시 리셋.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../crossCategoryStationDedup')._resetCrossCategoryDedupForTests();
    mockUpdateStationNotification.mockResolvedValue(undefined);
    mockSendStationPassedNotification.mockResolvedValue(undefined);
    mockCalculateStaticETA.mockReturnValue(10);
    mockEvaluateAlarmPhase.mockReturnValue(null);
    mockIsStationOnRoute.mockReturnValue(true);
    mockGetLastNotifiedStationId.mockResolvedValue(null);
    mockSetLastNotifiedStationId.mockResolvedValue(undefined);
    // 기본: lock 없음 — BG path가 GPS line을 그대로 사용 (기존 동작).
    mockGetBoardingLock.mockResolvedValue(null);
    // #750: 알람 발사 분기는 resolveAllTargets를 호출해 첫 hop을 산출한다.
    // 기존 테스트에서 빈 배열을 반환하면 `[0].name`이 깨지므로 destination 매칭 default를 둔다.
    // sleep 게이트 describe는 자체 beforeEach로 transfer-first 매핑을 덮어쓴다.
    mockResolveAllTargets.mockReturnValue([
      { name: '시청', stops: 3, alarmType: 'destination', approachLine: '2' },
    ]);
    mockGetFirstLeg.mockReturnValue({ line: '2', endName: '시청' });
    // #746: dismissSilence 기본은 null — silence 없음.
    mockGetDismissSilence.mockResolvedValue(null);
    mockClearDismissSilence.mockResolvedValue(undefined);
  });

  it('returns null nearest and null alarm when findNearestStation returns null', async () => {
    mockFindNearestStation.mockReturnValue(null);
    const result = await call();
    expect(result).toEqual({ alarmEvent: null, nearest: null });
    expect(mockFindRoute).not.toHaveBeenCalled();
    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });

  it('calls findRoute and evaluator with full source', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    await call({ speedMps: 10 });

    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
    expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        route: mockRoute,
        destinationName: '시청',
        etaSeconds: expect.any(Number),
      }),
      expect.any(Set),
      undefined,
      expect.any(Array),
    );
  });

  describe('#707 BoardingLock line 가드 (BG path)', () => {
    const lockOnLine7 = {
      destinationId: 'station-2',
      trainCode: 'T-7',
      boardingStationId: 'station-0',
      boardingLine: '7' as const,
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };

    it('lock 활성이면 currentLine은 lock.boardingLine으로 강등 (raw GPS line 무시)', async () => {
      // GPS는 환승역에서 옆 노선(line 2)으로 잘못 잠긴 상태이지만 사용자는 line 7 탑승 중.
      mockFindNearestStation.mockReturnValue(mockNearestResult); // station.line = '2'
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetBoardingLock.mockResolvedValue(lockOnLine7);

      await call();

      expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
        expect.objectContaining({ currentLine: '7' }),
        expect.any(Set),
        undefined,
        expect.any(Array),
      );
    });

    it('lock 없으면 currentLine은 nearest.station.line 사용 (기존 동작 유지)', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult); // station.line = '2'
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetBoardingLock.mockResolvedValue(null);

      await call();

      expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
        expect.objectContaining({ currentLine: '2' }),
        expect.any(Set),
        undefined,
        expect.any(Array),
      );
    });

    // #796 P1-1: resolveNextTarget도 같은 lock-degraded currentLine을 사용해야 함.
    // BG GPS jitter로 nearest가 옆 노선 station(예: 5호선 군자)을 잡아도 lock(7호선) SSOT로
    // segment 식별하여 다음-다음 transfer로 잘못 넘어가지 않는다.
    //
    // #2064 (Phase 1-device) — sendStationPassedNotification 제거로 resolveNextTarget의 결과값이
    // processLocationUpdate 밖으로 더 이상 노출되지 않는다(내부 dedup/hop-advance bookkeeping
    // gate로만 소비). currentLine 선택 로직(lock.boardingLine 우선) 자체의 정확성은
    // `resolveNextTarget` 직접 단위 테스트(아래 '#796 currentLine 기반 segment 식별' describe)가
    // 계속 커버 — 여기서는 lock 활성 시 station-passed dedup bookkeeping이 정상 진행됨을 검증한다.
    it('#796 P1-1 lock 활성 시에도 station-passed dedup bookkeeping이 정상 진행된다 (target resolve 성공)', async () => {
      // 7→5→8 multi-transfer route. GPS는 5호선 군자 station(line='5')으로 jitter됐지만
      // 실제 사용자는 7호선 탑승 중이라 lock.boardingLine='7'.
      const multiRoute = makeMultiTransferRoute({
        transfers: [
          { transferName: '군자', fromLine: '7', toLine: '5', stopsToTransfer: 0 },
          { transferName: '천호', fromLine: '5', toLine: '8', stopsToTransfer: 6 },
        ],
        stopsAfterLastTransfer: 2,
      });
      const stationOn5: Station = { ...mockStation, line: '5' };
      mockFindNearestStation.mockReturnValue({ station: stationOn5, distanceKm: 0.1 });
      mockFindRoute.mockReturnValue(multiRoute);
      mockIsStationOnRoute.mockReturnValue(true);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      mockGetBoardingLock.mockResolvedValue(lockOnLine7);

      await call();

      // target이 null이었다면(resolveNextTarget 실패) setLastNotifiedStationId가 호출되지 않는다.
      // lock SSOT currentLine 적용으로 두 segment 중 하나가 정상 매칭돼 target이 resolve된다.
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith('station-2', stationOn5.id);
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  it('passes null etaSeconds when speedMps is not provided', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    await call();

    expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
      expect.objectContaining({ etaSeconds: null }),
      expect.any(Set),
      undefined,
      expect.any(Array),
    );
  });

  it('does not call logFiredAlarm when no alarm', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    await call();
    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });

  it('calls updateStationNotification with computed args', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCalculateStaticETA.mockReturnValue(12);

    await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation,
      150,
      mockDestination,
      mockRoute,
      12,
      undefined,
      null,
      undefined,
    );
  });

  // #776: 도보 시간 합산을 위해 currentLocation/originStation을 calculateStaticETA에 전달.
  it('calculateStaticETA에 currentLocation(GPS)과 originStation(nearest 좌표)을 전달한다', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    await call();

    expect(mockCalculateStaticETA).toHaveBeenCalledWith(mockRoute, {
      currentLocation: { lat: 37.498, lng: 127.028 },
      originStation: { lat: mockStation.lat, lng: mockStation.lng },
    });
  });

  it('passes alarmEvent to updateStationNotification only when sleepMode is true', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);
    mockCalculateStaticETA.mockReturnValue(10);

    await call({ sleepMode: true });

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, mockRoute, 10, undefined, mockAlarmEvent, undefined,
    );
  });

  it('does not pass alarmEvent to updateStationNotification when sleepMode is false', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, mockRoute, 10, undefined, null, undefined,
    );
  });

  it('returns alarmEvent and nearest in result', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    const result = await call();

    expect(result.alarmEvent).toBe(mockAlarmEvent);
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('returns null alarm when evaluator returns null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    const result = await call();

    expect(result.alarmEvent).toBeNull();
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('rounds distanceKm to meters correctly', async () => {
    mockFindNearestStation.mockReturnValue({ station: mockStation, distanceKm: 0.4567 });
    mockFindRoute.mockReturnValue(mockRoute);
    mockCalculateStaticETA.mockReturnValue(5);

    await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 457, mockDestination, mockRoute, 5, undefined, null, undefined,
    );
  });

  it('falls back to findRoute when storedRoute exists but updateRouteFromPosition returns null', async () => {
    const storedRoute = makeDirectRoute(5, '2');
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockUpdateRouteFromPosition.mockReturnValue(null);
    mockFindRoute.mockReturnValue(mockRoute);

    await call({ storedRoute });

    expect(mockUpdateRouteFromPosition).toHaveBeenCalledWith(storedRoute, mockStation, 'station-2');
    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
  });

  it('uses updateRouteFromPosition result when storedRoute is provided and succeeds', async () => {
    const storedRoute = makeDirectRoute(5, '2');
    const updatedRoute = makeDirectRoute(3, '2');
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockUpdateRouteFromPosition.mockReturnValue(updatedRoute);
    mockCalculateStaticETA.mockReturnValue(6);

    await call({ storedRoute });

    expect(mockUpdateRouteFromPosition).toHaveBeenCalledWith(storedRoute, mockStation, 'station-2');
    expect(mockFindRoute).not.toHaveBeenCalled();
    expect(mockCalculateStaticETA).toHaveBeenCalledWith(updatedRoute, expect.any(Object));
  });

  it('calls findRoute when no storedRoute is provided', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    await call();

    expect(mockUpdateRouteFromPosition).not.toHaveBeenCalled();
    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
  });

  // #2064 (Phase 1-device) — 매역 알림은 backend visible push 단일 채널로 전환. station-passed 감지는
  // 더 이상 사용자 노출 알림을 발사하지 않고 notificationState(dedup) bookkeeping만 수행한다.
  it('does not send station-passed notification but still writes to notificationState when station changes', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockGetLastNotifiedStationId.mockResolvedValue('other-station');

    await call();

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(mockDestination.id, 'station-1');
  });

  it('does not send station-passed notification when station is the same as stored', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockGetLastNotifiedStationId.mockResolvedValue('station-1');

    await call();

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
  });

  it('does not send station-passed notification but writes notificationState when stored lastNotifiedStationId is null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockGetLastNotifiedStationId.mockResolvedValue(null);

    await call();

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(mockDestination.id, 'station-1');
  });

  it('does not mutate firedAlarms (responsibility moved to caller)', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    const firedAlarms = new Set<string>();
    await call({ firedAlarms });

    expect(firedAlarms.size).toBe(0);
    expect(mockAlarmKey).not.toHaveBeenCalled();
  });

  it('handles null route gracefully', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(null);
    mockCalculateStaticETA.mockReturnValue(null);

    const result = await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, null, null, undefined, null, undefined,
    );
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('경로 외 노선의 역이면 station-passed 알림을 보내지 않고 notificationState를 갱신하지 않는다', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockIsStationOnRoute.mockReturnValue(false);
    mockGetLastNotifiedStationId.mockResolvedValue('previous-station');

    await call();

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
  });

  it('route가 null이면 station-passed 알림을 보내지 않는다', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(null);

    await call();

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
    expect(mockGetLastNotifiedStationId).not.toHaveBeenCalled();
  });

  describe('#624 BG-safe stale alarm cancel (BoardingLock advance)', () => {
    const mockLock = {
      destinationId: 'station-2',
      trainCode: 'T-100',
      boardingStationId: 'station-0',
      boardingLine: '2',
      boardedAt: 1_700_000_000_000,
      expectedDurationMs: 600_000,
    };

    it('lock 있고 nearest station이 waypoint이면 advanceHopWindow 호출', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetLastNotifiedStationId.mockResolvedValue('other-station');
      mockGetBoardingLock.mockResolvedValue(mockLock);
      mockResolveAllTargets.mockReturnValue([
        { name: '강남', stops: 1, alarmType: 'destination', approachLine: '2' },
      ]);

      await call();

      expect(mockAdvanceHopWindow).toHaveBeenCalledWith({
        lock: mockLock,
        route: mockRoute,
        destinationName: '시청',
        passedStationName: '강남',
        sleepMode: false,
      });
    });

    it('lock 있고 nearest가 waypoint가 아니면 advanceHopWindow 호출 안 함 (no-op)', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetLastNotifiedStationId.mockResolvedValue('other-station');
      mockGetBoardingLock.mockResolvedValue(mockLock);
      mockResolveAllTargets.mockReturnValue([
        { name: '다른역', stops: 1, alarmType: 'destination', approachLine: '2' },
      ]);

      await call();

      expect(mockAdvanceHopWindow).not.toHaveBeenCalled();
    });

    it('lock 없으면 advanceHopWindow 호출 안 함', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetLastNotifiedStationId.mockResolvedValue('other-station');
      mockGetBoardingLock.mockResolvedValue(null);

      await call();

      expect(mockAdvanceHopWindow).not.toHaveBeenCalled();
    });
  });

  it('findNearestStation을 MAX_STATION_DISTANCE_KM(1.0)와 함께 호출한다', async () => {
    mockFindNearestStation.mockReturnValue(null);

    await call({ lat: 37.5, lng: 127.0 });

    expect(mockFindNearestStation).toHaveBeenCalledWith(37.5, 127.0, 1.0);
  });

  it('route 타입이 unknown(타입 오염)으로 resolveNextTarget이 null이면 알림 미발송 + notificationState 미갱신', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    // AsyncStorage 등에서 손상된 route가 들어온 케이스
    const corruptedRoute = { type: 'unknown', stops: 0 } as unknown as DirectRoute;
    mockFindRoute.mockReturnValue(corruptedRoute);
    mockIsStationOnRoute.mockReturnValue(true);
    mockGetLastNotifiedStationId.mockResolvedValue('prev-station');

    await call();

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
  });

  // ── 알람 로그 적재 (B2 인프라) ──

  describe('알람 로그 적재', () => {
    it('알람 발사 시 logFiredAlarm(source, event)를 호출한다', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

      await call();

      expect(mockLogFiredAlarm).toHaveBeenCalledWith('bg', mockAlarmEvent);
    });

    // #2064 (Phase 1-device) — station-passed 로컬 알림 제거로 logFiredStationPassed(alarmLog
    // 'fired' 엔트리) 호출부도 함께 제거됨. dedup bookkeeping(setLastNotifiedStationId)은 유지.
    it('역 통과 감지 시에도 logFiredStationPassed는 호출하지 않는다 (dedup bookkeeping만 수행)', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      await call();

      expect(mockLogFiredStationPassed).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(mockDestination.id, mockStation.id);
    });

    it('lastNotifiedStationId 일치로 skip되면 logSuppressedDedupStation을 호출한다', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetLastNotifiedStationId.mockResolvedValue(mockStation.id);

      await call();

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedDedupStation).toHaveBeenCalledWith('bg', mockStation);
    });

    it('source 인자가 fg면 fg로 전파된다', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

      await call({ source: 'fg' });

      expect(mockLogFiredAlarm).toHaveBeenCalledWith('fg', mockAlarmEvent);
    });
  });

  // #327 — notificationSource 라벨은 #2067(D1) 이후 updateStationNotification의 마지막 인자로만
  // 전파된다 (sendAlarmNotification 경로 자체가 삭제됨).
  describe('fusionSource 라벨 전파 (#327)', () => {
    it('fusionSource=gps → updateStationNotification에 gpsOnly 전달', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

      await call({ fusionSource: 'gps' });

      expect(mockUpdateStationNotification).toHaveBeenCalledWith(
        mockStation, 150, mockDestination, mockRoute, 10, undefined, null, 'gpsOnly',
      );
    });

    it('fusionSource=position-train → positionTrain 전달', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

      await call({ fusionSource: 'position-train' });

      expect(mockUpdateStationNotification).toHaveBeenCalledWith(
        mockStation, 150, mockDestination, mockRoute, 10, undefined, null, 'positionTrain',
      );
    });

    it('locationUncertain=true → source 무시하고 uncertain 전달', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

      await call({ fusionSource: 'position-train', locationUncertain: true });

      expect(mockUpdateStationNotification).toHaveBeenCalledWith(
        mockStation, 150, mockDestination, mockRoute, 10, undefined, null, 'uncertain',
      );
    });

    it('fusionSource 미지정 → updateStationNotification에 source 전달 안 함 (마지막 인자 undefined)', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

      await call();

      expect(mockUpdateStationNotification).toHaveBeenCalledWith(
        mockStation, 150, mockDestination, mockRoute, 10, undefined, null, undefined,
      );
    });

    // #2064 (Phase 1-device) — station-passed 로컬 알림 제거로 notificationSource 전파 대상도
    // 사라짐(updateStationNotification 경로만 notificationSource를 계속 사용).
    it('역 통과 감지에는 더 이상 notificationSource가 전달되지 않는다 (알림 자체가 없음)', async () => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetLastNotifiedStationId.mockResolvedValue(null);

      await call({ fusionSource: 'route-progress' });

      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #750 — BG 즉시 발사 path도 공통 sleep 룰 게이트를 통과해야 한다.
  // scheduler가 사전 예약을 skip한 transfer를 BG silent push 등이 우회 발사하던 회귀.
  describe('#750 sleep first-transfer 게이트', () => {
    const lock = {
      destinationId: 'station-2',
      trainCode: 'T-1',
      boardingStationId: 'station-1',
      boardingLine: '2' as const,
      boardedAt: Date.now(),
      expectedDurationMs: 60_000,
    };
    const transferAlarm: AlarmEvent = {
      phaseId: 'early',
      type: 'transfer',
      stationName: '교대',
    };

    beforeEach(() => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockEvaluateAlarmPhase.mockReturnValue(transferAlarm);
      // 첫 hop 매칭용 — resolveAllTargets는 호출 순서에 따라 호출됨. transfer 알람 매칭 케이스에서
      // alarmEvent 분기와 station-passed 분기 둘 다 사용 — 둘 다 같은 targets 반환하도록 통일.
      mockResolveAllTargets.mockReturnValue([
        { name: '교대', stops: 1, alarmType: 'transfer', approachLine: '2' },
        { name: '시청', stops: 3, alarmType: 'destination', approachLine: '1' },
      ]);
      mockGetFirstLeg.mockReturnValue({ line: '2', endName: '교대' });
    });

    it('sleep ON + lock 활성 + 첫 hop transfer → logFiredAlarm 호출 X, suppression 로그', async () => {
      mockGetBoardingLock.mockResolvedValue(lock);
      await call({ sleepMode: true });
      expect(mockLogSuppressedSleepFirstTransfer).toHaveBeenCalledWith({
        source: 'bg',
        stationName: '교대',
        phaseId: 'early',
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('sleep OFF + lock 활성 + 첫 hop transfer → 정상 발사', async () => {
      mockGetBoardingLock.mockResolvedValue(lock);
      await call({ sleepMode: false });
      expect(mockLogFiredAlarm).toHaveBeenCalled();
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('sleep ON + lock null + 첫 hop transfer → suppress (#1214 lockless 적용)', async () => {
      // #1214 (Epic #1204 D8): lock=null 조기 종료 제거 — lockless trip도 동급 정확도 보장.
      // 호출자(stationPipeline)의 isFirstHop 계산은 getFirstLeg.endName 매칭으로 lockless에서도 동작.
      mockGetBoardingLock.mockResolvedValue(null);
      await call({ sleepMode: true });
      expect(mockLogSuppressedSleepFirstTransfer).toHaveBeenCalledWith({
        source: 'bg',
        stationName: '교대',
        phaseId: 'early',
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('sleep OFF + lock null + 첫 hop transfer → 정상 발사 (sleep off 우선)', async () => {
      mockGetBoardingLock.mockResolvedValue(null);
      await call({ sleepMode: false });
      expect(mockLogFiredAlarm).toHaveBeenCalled();
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('sleep ON + lock 활성 + alarmEvent의 stationName이 첫 hop과 불일치 → 정상 발사 (둘째 hop은 영향 없음)', async () => {
      mockGetBoardingLock.mockResolvedValue(lock);
      // 둘째 hop transfer가 발사 시점에 trigger됐다고 가정 (자주 일어나지 않지만 회귀 가드).
      mockEvaluateAlarmPhase.mockReturnValue({
        phaseId: 'early',
        type: 'transfer',
        stationName: '시청', // 둘째 hop
      });
      await call({ sleepMode: true });
      expect(mockLogFiredAlarm).toHaveBeenCalled();
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('sleep ON + lock 활성 + destination 카테고리 → 정상 발사 (transfer 외 영향 없음)', async () => {
      mockGetBoardingLock.mockResolvedValue(lock);
      mockEvaluateAlarmPhase.mockReturnValue({
        phaseId: 'early',
        type: 'destination',
        stationName: '교대',
      });
      await call({ sleepMode: true });
      expect(mockLogFiredAlarm).toHaveBeenCalled();
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('route=null → 게이트 비활성, alarmEvent도 null이라 발사 자체 없음 (회귀 가드)', async () => {
      // route 미존재 시 evaluateAlarmPhase가 null을 반환하므로 게이트 분기에 들어가지 않는다.
      // 본 케이스는 alarmEvent=null path에서 sleep 게이트가 우발 동작하지 않는지 가드.
      mockGetBoardingLock.mockResolvedValue(lock);
      mockFindRoute.mockReturnValue(null);
      mockEvaluateAlarmPhase.mockReturnValue(null);
      await call({ sleepMode: true });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });

    it('route=null인데 evaluator가 alarmEvent 반환(비정상) → 게이트 분기 진입 안 함, 발사 안 함 (defensive guard)', async () => {
      // evaluateAlarmPhase 계약상 route=null이면 null이지만, mock으로 비정상 케이스를 시뮬레이트해
      // 발사 분기의 `alarmEvent && route` 가드 양쪽을 branch coverage로 확정한다.
      mockGetBoardingLock.mockResolvedValue(lock);
      mockFindRoute.mockReturnValue(null);
      mockEvaluateAlarmPhase.mockReturnValue(transferAlarm);
      await call({ sleepMode: true });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      expect(mockLogSuppressedSleepFirstTransfer).not.toHaveBeenCalled();
    });
  });

  // #1515 — cross-category station-level dedup (BG path).
  describe('#1515 cross-category station-level dedup (BG path)', () => {
    const passedStation: Station = { ...mockStation, name: '강남', id: 'station-1' };
    beforeEach(() => {
      mockFindNearestStation.mockReturnValue({ station: passedStation, distanceKm: 0.05 });
      mockFindRoute.mockReturnValue(mockRoute);
      mockIsStationOnRoute.mockReturnValue(true);
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
    });

    it('phase 알람 발사 후 같은 station BG station-passed는 cross-category dedup으로 차단', async () => {
      // 1st call — phase 알람 발사 → mark.
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'imminent',
        type: 'destination',
        stationName: passedStation.name,
      });
      // station-passed 분기를 진입하지 않도록 isStationOnRoute=false로 1차 call 한정.
      mockIsStationOnRoute.mockReturnValueOnce(false);
      await call({ source: 'fg-evaluated' });
      expect(mockLogFiredAlarm).toHaveBeenCalled();

      // 2nd call — station-passed 분기 진입. cross-category로 차단되어야 함.
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockIsStationOnRoute.mockReturnValue(true);
      await call({ source: 'bg' });
      expect(mockLogSuppressedCrossCategoryDedup).toHaveBeenCalledWith({
        source: 'bg',
        stationName: passedStation.name,
        kind: 'station-passed',
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('station-passed 감지 후 같은 station phase 알람은 cross-category dedup으로 차단', async () => {
      // 1st: station-passed 감지(#2064 — 로컬 알림은 미발사, markStationFired는 계속 mark).
      await call({ source: 'bg' });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(mockDestination.id, passedStation.id);

      // 2nd: phase 알람 같은 station — cross-cat 차단. (다른 destination이라 lastNotifiedStationId
      // 게이트는 다른 키, isStationOnRoute false로 station-passed 분기 회피.)
      mockEvaluateAlarmPhase.mockReturnValue({
        phaseId: 'imminent',
        type: 'destination',
        stationName: passedStation.name,
      });
      mockIsStationOnRoute.mockReturnValue(false);
      await call({ source: 'fg-evaluated' });
      expect(mockLogSuppressedCrossCategoryDedup).toHaveBeenCalledWith({
        source: 'fg-evaluated',
        stationName: passedStation.name,
        kind: 'destination',
        phaseId: 'imminent',
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

  });

  // #1643 — trip-scoped cross-category + cross-station 즉시 cascade dedup (BG path).
  // 2026-06-20 12:31 어대 "군자 도착"(SP) + "곧 성수 도착"(D imminent) 회귀 차단.
  describe('#1643 trip-scoped cross-category + cross-station cascade dedup (BG path)', () => {
    const passedStation: Station = { ...mockStation, name: '군자', id: 'station-1' };
    const otherStation: Station = { ...mockStation, name: '성수', id: 'station-3' };

    beforeEach(() => {
      mockFindRoute.mockReturnValue(mockRoute);
      mockIsStationOnRoute.mockReturnValue(true);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
    });

    it('station-passed 감지(군자) 후 5s 안 phase 알람(성수=다른 station, cross-cat)은 trip-scoped dedup으로 차단', async () => {
      // 1st: 군자 station-passed 감지 → trip-scoped mark(#2064 — 로컬 알림은 미발사).
      mockFindNearestStation.mockReturnValue({ station: passedStation, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValue(null);
      await call({ source: 'bg' });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledWith(mockDestination.id, passedStation.id);

      // 2nd: 다른 station(성수) phase 알람 — cross-station + cross-cat이라 trip-scoped 차단.
      mockFindNearestStation.mockReturnValue({ station: otherStation, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValue({
        phaseId: 'imminent',
        type: 'destination',
        stationName: otherStation.name,
      });
      mockIsStationOnRoute.mockReturnValue(false); // station-passed 분기 회피
      await call({ source: 'bg' });
      expect(mockLogSuppressedCrossCategoryRecent).toHaveBeenCalledWith({
        source: 'bg',
        stationName: otherStation.name,
        kind: 'destination',
        phaseId: 'imminent',
      });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('phase 알람 발사(성수) 후 5s 안 다른 station(군자) station-passed는 trip-scoped dedup으로 차단', async () => {
      // 1st: 성수 phase 발사 → trip-scoped mark.
      mockFindNearestStation.mockReturnValue({ station: otherStation, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'imminent',
        type: 'destination',
        stationName: otherStation.name,
      });
      mockIsStationOnRoute.mockReturnValueOnce(false);
      await call({ source: 'fg-evaluated' });
      expect(mockLogFiredAlarm).toHaveBeenCalled();

      // 2nd: 군자(다른 station) station-passed 시도 — trip-scoped cross-cat 차단.
      mockFindNearestStation.mockReturnValue({ station: passedStation, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockIsStationOnRoute.mockReturnValue(true);
      await call({ source: 'bg' });
      expect(mockLogSuppressedCrossCategoryRecent).toHaveBeenCalledWith({
        source: 'bg',
        stationName: passedStation.name,
        kind: 'station-passed',
      });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });
  });

  // #1656 — phase↔phase cross-station 즉시 cascade dedup (BG path).
  // 2026-06-20 12:32 어대 "곧 건대"(transfer) + "성수 도착"(destination) 회귀 차단.
  describe('#1656 phase↔phase cross-station cascade dedup (BG path)', () => {
    const transferStation: Station = { ...mockStation, name: '건대', id: 'station-transfer' };
    const destStation: Station = { ...mockStation, name: '성수', id: 'station-dest' };

    beforeEach(() => {
      mockFindRoute.mockReturnValue(mockRoute);
      mockIsStationOnRoute.mockReturnValue(false);
    });

    it('transfer phase 발사(건대) 후 3s 안 destination phase(성수=다른 station)는 phase↔phase dedup으로 차단', async () => {
      // 1st: 건대 transfer phase 발사.
      mockFindNearestStation.mockReturnValue({ station: transferStation, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'imminent',
        type: 'transfer',
        stationName: transferStation.name,
      });
      await call({ source: 'bg' });
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);

      // 2nd: 성수(다른 station) destination phase — 3s 안 phase→phase cross-station → 차단.
      mockFindNearestStation.mockReturnValue({ station: destStation, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'early',
        type: 'destination',
        stationName: destStation.name,
      });
      await call({ source: 'bg' });
      expect(mockLogSuppressedPhaseToPhaseDedup).toHaveBeenCalledWith({
        source: 'bg',
        stationName: destStation.name,
        kind: 'destination',
        phaseId: 'early',
      });
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1); // 추가 발사 없음
    });

    it('같은 station 진행(건대 transfer → 건대 destination early→imminent)은 차단하지 않음', async () => {
      // 1st: 건대 transfer imminent 발사.
      mockFindNearestStation.mockReturnValue({ station: transferStation, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'imminent',
        type: 'transfer',
        stationName: transferStation.name,
      });
      await call({ source: 'bg' });
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);

      // 2nd: 같은 station(건대) destination — same station이라 통과.
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'early',
        type: 'destination',
        stationName: transferStation.name, // 건대 = 같은 station
      });
      await call({ source: 'bg' });
      // phase↔phase dedup은 발동 안 됨 — same station은 firedAlarms가 담당.
      expect(mockLogSuppressedPhaseToPhaseDedup).not.toHaveBeenCalled();
    });
  });

  // #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop. silent state push + LA dirty update
  // cross-channel 중복(2026-06-26 trip-3 동대문역사문화공원 8분 차) BG path 동등 차단.
  describe('#1901/#1900 channel-agnostic 8분 backstop dedup (BG path)', () => {
    const stationA: Station = { ...mockStation, name: '동대문역사문화공원', id: 'station-1' };
    let nowSpy: jest.SpyInstance<number, []>;

    beforeEach(() => {
      mockFindRoute.mockReturnValue(mockRoute);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it('phase 알람 발사 후 31s~8분 사이 같은 station 같은 phase 재발사는 channel-agnostic backstop으로 차단', async () => {
      mockFindNearestStation.mockReturnValue({ station: stationA, distanceKm: 0.05 });
      // 1st: imminent destination 발사 (t=1_000_000).
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'imminent',
        type: 'destination',
        stationName: stationA.name,
      });
      mockIsStationOnRoute.mockReturnValueOnce(false);
      await call({ source: 'fg-evaluated' });
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);

      // t = 1_000_000 + 60_000 (1분 후) — 30s cross-category window는 만료, 8분 backstop은 활성.
      nowSpy.mockReturnValue(1_000_000 + 60_000);

      // 2nd: 같은 station 같은 phase imminent — cross-channel 중복 시뮬레이션. cross-category 30s
      // 만료 후 8분 backstop만 활성. phaseId 정확 매칭이라 차단.
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'imminent',
        type: 'destination',
        stationName: stationA.name,
      });
      mockIsStationOnRoute.mockReturnValueOnce(false);
      await call({ source: 'fg-evaluated' });
      expect(mockLogSuppressedChannelAgnosticDedup).toHaveBeenCalledWith({
        source: 'fg-evaluated',
        stationName: stationA.name,
        kind: 'destination',
        phaseId: 'imminent',
      });
      // 두 번째 발사 없음.
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);
    });

    it('phase 알람 발사 후 같은 station 다른 phase는 정상 phase 진행이라 통과', async () => {
      mockFindNearestStation.mockReturnValue({ station: stationA, distanceKm: 0.05 });
      // 1st: early destination 발사.
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'early',
        type: 'destination',
        stationName: stationA.name,
      });
      mockIsStationOnRoute.mockReturnValueOnce(false);
      await call({ source: 'fg-evaluated' });
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(1);

      // 2nd: 같은 station imminent destination — 다른 phaseId라 channel-agnostic backstop 통과.
      // cross-category 30s window는 만료시켜 phase 변경만 backstop 영향 받는지 격리.
      nowSpy.mockReturnValue(1_000_000 + 60_000);
      mockEvaluateAlarmPhase.mockReturnValueOnce({
        phaseId: 'imminent',
        type: 'destination',
        stationName: stationA.name,
      });
      mockIsStationOnRoute.mockReturnValueOnce(false);
      await call({ source: 'fg-evaluated' });
      // 두 번째 발사가 진행됨 — channel-agnostic dedup은 phase 진행 통과.
      expect(mockLogFiredAlarm).toHaveBeenCalledTimes(2);
      expect(mockLogSuppressedChannelAgnosticDedup).not.toHaveBeenCalled();
    });

    it('station-passed 감지 후 31s~8분 사이 같은 station station-passed는 channel-agnostic backstop으로 차단', async () => {
      mockFindNearestStation.mockReturnValue({ station: stationA, distanceKm: 0.05 });
      mockEvaluateAlarmPhase.mockReturnValue(null);
      mockIsStationOnRoute.mockReturnValue(true);
      // 1st: station-passed 감지 → markStationFired (t=1_000_000). #2064 — 로컬 알림은 미발사.
      await call({ source: 'bg' });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(1);

      // t = 1_000_000 + 60_000 — 30s cross-category 만료, lastNotifiedStationId가 다른 stationId면
      // 그 dedup도 통과 → channel-agnostic 8분 backstop이 차단해야 함.
      nowSpy.mockReturnValue(1_000_000 + 60_000);
      mockGetLastNotifiedStationId.mockResolvedValue('other-station');
      await call({ source: 'bg' });
      expect(mockLogSuppressedChannelAgnosticDedup).toHaveBeenCalledWith({
        source: 'bg',
        stationName: stationA.name,
        kind: 'station-passed',
      });
      // 알림은 두 호출 모두 미발사(#2064). 2nd call은 backstop 차단으로 setLastNotifiedStationId도
      // 갱신되지 않는다 — 1st 호출분(1회)만 유지.
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalledTimes(1);
    });
  });

  // #1236 (Epic #1204 D8 wire) — BG station-passed dispatch path도 sleep 룰 게이트 호출.
  // 2026-06-12 22:11:56 사가정 station-passed fire 회귀를 BG/silent push 양쪽에서 차단.
  describe('#1236 sleep 룰 게이트 — station-passed (BG path)', () => {
    const lockOnStation1 = {
      destinationId: 'station-2',
      trainCode: 'T-1',
      // boardingStationId가 mockStation.id와 일치 → station-passed 후보가 첫 hop으로 판정됨.
      boardingStationId: 'station-1',
      boardingLine: '2' as const,
      boardedAt: Date.now(),
      expectedDurationMs: 60_000,
    };

    beforeEach(() => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockIsStationOnRoute.mockReturnValue(true);
      mockGetLastNotifiedStationId.mockResolvedValue(null);
      // alarmEvent는 게이트와 무관 — null로 둬서 transfer/destination sleep 게이트와 격리.
      mockEvaluateAlarmPhase.mockReturnValue(null);
    });

    it('sleep ON + lock 활성 + candidate=boardingStation → station-passed 차단 + suppress 로그', async () => {
      mockGetBoardingLock.mockResolvedValue(lockOnStation1);
      await call({ sleepMode: true });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
      expect(mockLogSuppressedSleepStationPassed).toHaveBeenCalledWith({
        source: 'bg',
        stationName: mockStation.name,
      });
    });

    it('sleep OFF + lock 활성 + candidate=boardingStation → 정상 진행 (sleep off 우선, #2064 알림은 미발사)', async () => {
      mockGetBoardingLock.mockResolvedValue(lockOnStation1);
      await call({ sleepMode: false });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
    });

    it('sleep ON + lock 활성 + candidate≠boardingStation → 정상 진행 (첫 hop 아님, #2064 알림은 미발사)', async () => {
      const lockOnOther = { ...lockOnStation1, boardingStationId: 'station-other' };
      mockGetBoardingLock.mockResolvedValue(lockOnOther);
      await call({ sleepMode: true });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
    });

    it('sleep ON + lock null (lockless) → BG는 currentHopIndex SSOT 부재라 graceful 통과 (#2064 알림은 미발사)', async () => {
      // BG path는 estimator hopIndex 입력이 없어 lockless trip을 차단하지 않는다(보수적 graceful).
      // FG path가 currentHopIndex로 동급 보장(useStationAlarm 테스트에서 검증).
      mockGetBoardingLock.mockResolvedValue(null);
      await call({ sleepMode: true });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).toHaveBeenCalled();
      expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
    });

    it('sleep ON + lock 활성 + silence 활성 → silence 차단이 우선 (station-passed gate는 호출되지 않음)', async () => {
      // 같은 candidate에 silence 게이트가 위에 있어 sleep 게이트보다 먼저 차단한다.
      mockGetBoardingLock.mockResolvedValue(lockOnStation1);
      mockGetDismissSilence.mockResolvedValue({
        sinceTs: Date.now(),
        sinceLat: 37.498,
        sinceLng: 127.028,
      });
      await call({ sleepMode: true });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockLogSuppressedSleepStationPassed).not.toHaveBeenCalled();
    });
  });

  describe('#746 dismiss silence 게이트 (BG path)', () => {
    beforeEach(() => {
      mockFindNearestStation.mockReturnValue(mockNearestResult);
      mockFindRoute.mockReturnValue(mockRoute);
      mockIsStationOnRoute.mockReturnValue(true);
    });

    it('silence 활성이면 phase 알람 발사 차단 + suppress reason 로그', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);
      // 시간/거리 모두 silence 범위.
      mockGetDismissSilence.mockResolvedValue({
        sinceTs: Date.now(),
        sinceLat: 37.498,
        sinceLng: 127.028,
      });
      const result = await call({ source: 'bg' });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
      expect(mockLogSuppressedDismissSilence).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'bg',
          stationName: mockAlarmEvent.stationName,
          kind: mockAlarmEvent.type,
          phaseId: mockAlarmEvent.phaseId,
        }),
      );
      // 반환 alarmEvent는 null로 정정 (caller가 sleep overlay 등에 표시하지 않도록).
      expect(result.alarmEvent).toBeNull();
    });

    it('silence 활성이면 station-passed 알림도 차단 + lastNotifiedStationId 갱신 보존', async () => {
      mockGetLastNotifiedStationId.mockResolvedValue('other-id');
      mockGetDismissSilence.mockResolvedValue({
        sinceTs: Date.now(),
        sinceLat: 37.498,
        sinceLng: 127.028,
      });
      await call({ source: 'bg' });
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
      expect(mockSetLastNotifiedStationId).not.toHaveBeenCalled();
      expect(mockLogSuppressedDismissSilence).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'bg',
          stationName: mockStation.name,
          kind: 'station-passed',
        }),
      );
    });

    it('silence 만료(시간) 시 게이트 통과 + storage clear 호출', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);
      mockGetDismissSilence.mockResolvedValue({
        sinceTs: Date.now() - 10 * 60_000,
        sinceLat: null,
        sinceLng: null,
      });
      await call({ source: 'bg' });
      expect(mockClearDismissSilence).toHaveBeenCalledTimes(1);
      expect(mockLogFiredAlarm).toHaveBeenCalled();
    });

    it('silence state 좌표 null(=GPS-less dismiss)이면 거리 평가 skip — 시간 조건만 활성', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);
      mockGetDismissSilence.mockResolvedValue({
        sinceTs: Date.now(),
        sinceLat: null,
        sinceLng: null,
      });
      // 사용자가 1km 떨어진 좌표여도 시간 조건이 silence이므로 차단.
      await call({ source: 'bg', lat: 37.6, lng: 127.1 });
      expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    });

    it('silence state 없음(null) → 정상 발사', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);
      mockGetDismissSilence.mockResolvedValue(null);
      await call({ source: 'bg' });
      expect(mockLogSuppressedDismissSilence).not.toHaveBeenCalled();
      expect(mockLogFiredAlarm).toHaveBeenCalled();
    });

    it('silence 활성이어도 updateStationNotification(UI)은 계속 호출 — silence는 알람만 차단', async () => {
      mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);
      mockGetDismissSilence.mockResolvedValue({
        sinceTs: Date.now(),
        sinceLat: null,
        sinceLng: null,
      });
      await call({ source: 'bg' });
      expect(mockUpdateStationNotification).toHaveBeenCalled();
    });
  });
});

describe('resolveNextTarget', () => {
  it('returns null for null route', () => {
    expect(resolveNextTarget(null, '강남')).toBeNull();
  });

  it('returns destination and stops for direct route', () => {
    const route = makeDirectRoute(5, '2');
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 5,
      isTransfer: false,
      stopsToDestination: 5,
    });
  });

  it('returns transfer station for transfer route with stopsToTransfer > 0', () => {
    const route = makeTransferRoute({
      transferName: '동대문', fromLine: '1', toLine: '4',
      stopsToTransfer: 3, stopsFromTransfer: 2,
    });
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '동대문',
      stopsToNextStation: 3,
      isTransfer: true,
      stopsToDestination: 5,
    });
  });

  it('returns destination for transfer route with stopsToTransfer = 0', () => {
    const route = makeTransferRoute({
      transferName: '동대문', fromLine: '1', toLine: '4',
      stopsToTransfer: 0, stopsFromTransfer: 2,
    });
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 2,
      isTransfer: false,
      stopsToDestination: 2,
    });
  });

  it('returns first transfer for multi-transfer route with stopsToTransfer > 0', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 3 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    });
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '잠실',
      stopsToNextStation: 3,
      isTransfer: true,
      stopsToDestination: 12,
    });
  });

  it('returns second transfer when first has stopsToTransfer = 0', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 0 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    });
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '시청',
      stopsToNextStation: 5,
      isTransfer: true,
      stopsToDestination: 9,
    });
  });

  it('returns null for unknown route type', () => {
    const route = { type: 'unknown' } as unknown as Route;
    expect(resolveNextTarget(route, '강남')).toBeNull();
  });

  it('returns destination when all transfers have stopsToTransfer = 0', () => {
    const route = makeMultiTransferRoute({
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 0 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 0 },
      ],
      stopsAfterLastTransfer: 4,
    });
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 4,
      isTransfer: false,
      stopsToDestination: 4,
    });
  });

  it('회귀(#214): 환승 전 구간에서 stopsToDestination은 환승 후 구간을 포함한 총합이다', () => {
    // 용마산 → 군자(환승) → 이대 시나리오: 환승까지 2정거장, 환승 후 9정거장 → 총 11
    const route = makeTransferRoute({
      transferName: '군자', fromLine: '7', toLine: '5',
      stopsToTransfer: 2, stopsFromTransfer: 9,
    });
    expect(resolveNextTarget(route, '이대')).toEqual({
      nextStationName: '군자',
      stopsToNextStation: 2,
      isTransfer: true,
      stopsToDestination: 11,
    });
  });

  describe('#796 currentLine 기반 segment 식별 (multi-transfer 회귀)', () => {
    it('회귀: multi-transfer 첫 환승역에 도착(stopsToTransfer=0)했어도 currentLine === fromLine이면 그 transfer 반환', () => {
      // 2026-06-03 실기기 회귀: 군자(7→5) 정확 도착 시 천호(5→8)로 잘못 안내됨.
      // updateRouteFromPosition이 군자_7호선에서 stopsToTransfer=0으로 갱신한 직후, 사용자는
      // 아직 7호선에 있으나 legacy 로직은 transfers[1](천호)을 반환했음.
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '군자', fromLine: '7', toLine: '5', stopsToTransfer: 0 },
          { transferName: '천호', fromLine: '5', toLine: '8', stopsToTransfer: 6 },
        ],
        stopsAfterLastTransfer: 2,
      });
      expect(resolveNextTarget(route, '어린이대공원', '7')).toEqual({
        nextStationName: '군자',
        stopsToNextStation: 0,
        isTransfer: true,
        stopsToDestination: 8,
      });
    });

    it('currentLine === segment[1].fromLine(5호선)이면 transfer[1] 반환 (환승 완료 후)', () => {
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '군자', fromLine: '7', toLine: '5', stopsToTransfer: 0 },
          { transferName: '천호', fromLine: '5', toLine: '8', stopsToTransfer: 4 },
        ],
        stopsAfterLastTransfer: 2,
      });
      expect(resolveNextTarget(route, '어린이대공원', '5')).toEqual({
        nextStationName: '천호',
        stopsToNextStation: 4,
        isTransfer: true,
        stopsToDestination: 6,
      });
    });

    it('currentLine === lastTransfer.toLine(8호선)이면 destination 반환', () => {
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '군자', fromLine: '7', toLine: '5', stopsToTransfer: 0 },
          { transferName: '천호', fromLine: '5', toLine: '8', stopsToTransfer: 0 },
        ],
        stopsAfterLastTransfer: 2,
      });
      expect(resolveNextTarget(route, '어린이대공원', '8')).toEqual({
        nextStationName: '어린이대공원',
        stopsToNextStation: 2,
        isTransfer: false,
        stopsToDestination: 2,
      });
    });

    it('currentLine 어느 segment에도 매칭 안 되면 legacy(stopsToTransfer>0) fallback', () => {
      // 사용자가 route 밖 노선(예: 1호선)에 있는 비정상 케이스 — legacy로 안전하게 fallthrough.
      const route = makeMultiTransferRoute({
        transfers: [
          { transferName: '군자', fromLine: '7', toLine: '5', stopsToTransfer: 3 },
          { transferName: '천호', fromLine: '5', toLine: '8', stopsToTransfer: 6 },
        ],
        stopsAfterLastTransfer: 2,
      });
      expect(resolveNextTarget(route, '어린이대공원', '1')).toEqual({
        nextStationName: '군자',
        stopsToNextStation: 3,
        isTransfer: true,
        stopsToDestination: 11,
      });
    });

    it('single transfer: currentLine === fromLine 이면 stopsToTransfer=0이어도 transfer 안내 유지 (환승역 도착 timing)', () => {
      // 동일한 회귀 패턴이 single transfer에서도 발생할 수 있음 — 환승역 정확 도착 시점.
      const route = makeTransferRoute({
        transferName: '군자', fromLine: '7', toLine: '5',
        stopsToTransfer: 0, stopsFromTransfer: 9,
      });
      expect(resolveNextTarget(route, '이대', '7')).toEqual({
        nextStationName: '군자',
        stopsToNextStation: 0,
        isTransfer: true,
        stopsToDestination: 9,
      });
    });

    it('single transfer: currentLine === toLine 이면 destination (환승 완료 후)', () => {
      const route = makeTransferRoute({
        transferName: '군자', fromLine: '7', toLine: '5',
        stopsToTransfer: 0, stopsFromTransfer: 3,
      });
      expect(resolveNextTarget(route, '이대', '5')).toEqual({
        nextStationName: '이대',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      });
    });

    it('single transfer: currentLine 미매칭이면 legacy fallback (stopsToTransfer > 0이면 transfer)', () => {
      const route = makeTransferRoute({
        transferName: '군자', fromLine: '7', toLine: '5',
        stopsToTransfer: 2, stopsFromTransfer: 9,
      });
      expect(resolveNextTarget(route, '이대', '1')).toEqual({
        nextStationName: '군자',
        stopsToNextStation: 2,
        isTransfer: true,
        stopsToDestination: 11,
      });
    });

    it('single transfer: currentLine 미매칭이면 legacy fallback (stopsToTransfer = 0이면 destination)', () => {
      const route = makeTransferRoute({
        transferName: '군자', fromLine: '7', toLine: '5',
        stopsToTransfer: 0, stopsFromTransfer: 3,
      });
      expect(resolveNextTarget(route, '이대', '1')).toEqual({
        nextStationName: '이대',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      });
    });
  });
});
