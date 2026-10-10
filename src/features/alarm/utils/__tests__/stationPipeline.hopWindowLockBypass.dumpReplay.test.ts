/**
 * #2478 — hopWindowGate(#2373)에 active lock을 배선해 지하 다역 전진 오차단을 막는 red→green
 * fixture. 덤프 근거(~/Downloads/텍스트-B9182EBB56F8-1.txt, 2026-09-02 저녁, 7호선 건대입구→용마산):
 *
 *   - lock 17:14:14 autolock-success, origin=건대입구, destination=용마산, trainCode=실코드.
 *   - firedAlarms(이 trip)=비어있음 — 17:14~22 중간역(어린이대공원/군자/중곡) station-passed가
 *     전부 억제돼 BG hop 추적 기준점(`BG_HOP_WINDOW_STATION_KEY`)이 origin(건대입구)에 stuck.
 *   - GPS: 지하 garbage 후 17:22:27 용마산서 20m로 지상 복귀 → gap=4 hop > windowSize(1) →
 *     `evaluateBgHopWindowGate`가 `blocked` 반환 → destination 발사 억제(#2478 발견 근본).
 *
 * 하네스: `bgPositionTrainFire.dumpReplay.e2eFire.test.ts`(#2400) 패턴 — `processLocationUpdate`는
 * mock 없이 실체인 구동. leaf만 mock(getBoardingLock, AsyncStorage in-memory, expo-notifications,
 * logger). storedRoute는 실제 findRoute(건대입구→용마산, 7호선)로 명시 배선해 결정성 확보
 * (spike는 route 미전달로 내부 findRoute 유도에 의존 — 이 fixture는 명시 배선으로 대체).
 *
 * 게이트 통과 ≠ 발사(#2400 교훈) — 이 fixture는 게이트 판정이 아니라 fireLocalAlarmNotification
 * 도달까지 assert한다.
 */
process.env.EXPO_PUBLIC_MINIMAL_ALARM = 'true';

const storage = new Map<string, string>();

const mockGetItem = jest.fn((key: string) =>
  Promise.resolve(storage.has(key) ? storage.get(key)! : null),
);
const mockSetItem = jest.fn((key: string, value: string) => {
  storage.set(key, value);
  return Promise.resolve();
});
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: [string]) => mockGetItem(...args),
  setItem: (...args: [string, string]) => mockSetItem(...args),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
}));

const mockFireLocalAlarmNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../stationNotification', () => {
  const actual = jest.requireActual('../stationNotification');
  return {
    ...actual,
    fireLocalAlarmNotification: (...args: unknown[]) => mockFireLocalAlarmNotification(...args),
  };
});

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn().mockResolvedValue('id'),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
  getAllScheduledNotificationsAsync: jest.fn().mockResolvedValue([]),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(undefined),
  getPresentedNotificationsAsync: jest.fn().mockResolvedValue([]),
  setNotificationHandler: jest.fn(),
  AndroidNotificationPriority: { MAX: 5 },
  AndroidImportance: { HIGH: 4, MAX: 5, DEFAULT: 3 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { processLocationUpdate } from '../stationPipeline';
import { findRoute, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { _resetCrossCategoryDedupForTests } from '../crossCategoryStationDedup';
import { BG_HOP_WINDOW_STATION_KEY } from '../../../../shared/constants/storageKeys';
import { PENDING_TRAIN_CODE } from '../../../../shared/constants/boardingLock';

const BOARDING_LINE = '7';
const ORIGIN = findStationByNameAndLine('건대입구', BOARDING_LINE)!;
const DESTINATION = findStationByNameAndLine('용마산', BOARDING_LINE)!;
const STORED_ROUTE = findRoute(ORIGIN.id, DESTINATION.id);
const LOCK_TRAIN_CODE = '2026090201';
const REAL_LOCK = {
  destinationId: DESTINATION.id,
  trainCode: LOCK_TRAIN_CODE,
  boardingStationId: ORIGIN.id,
  boardingLine: BOARDING_LINE,
  boardedAt: 0,
  expectedDurationMs: 600_000,
};

async function runFinalTick() {
  return processLocationUpdate({
    lat: DESTINATION.lat,
    lng: DESTINATION.lng,
    destination: DESTINATION,
    firedAlarms: new Set<string>(),
    sleepMode: false,
    storedRoute: STORED_ROUTE,
    source: 'bg',
    fusionSource: 'gps',
  });
}

describe('processLocationUpdate 실체인 — #2478 hopWindowGate active-lock bypass (9/2 저녁 용마산 재현)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.clear();
    _resetCrossCategoryDedupForTests();
    mockFireLocalAlarmNotification.mockResolvedValue(undefined);
    // 덤프 재현: 중간역 station-passed가 전부 억제돼 BG hop 추적 기준점이 origin(건대입구)에 stuck.
    storage.set(
      BG_HOP_WINDOW_STATION_KEY,
      JSON.stringify({ destinationId: DESTINATION.id, station: ORIGIN }),
    );
  });

  it('lock 활성 + 실 trainCode + forward 전진 → hop window gap(4) 우회, destination 발사', async () => {
    mockGetBoardingLock.mockResolvedValue(REAL_LOCK);

    const result = await runFinalTick();

    expect(mockFireLocalAlarmNotification).toHaveBeenCalled();
    expect(result.alarmEvent?.type).toBe('destination');
  });

  it('#2373 방어 negative — lock 없음이면 gap(4)은 여전히 차단(오발사 0)', async () => {
    mockGetBoardingLock.mockResolvedValue(null);

    // hopWindowGate 차단은 fireLocalAlarmNotification 미호출로만 관측된다 — alarmEvent 자체는
    // evaluateAlarmPhase가 게이트와 무관하게 항상 계산하므로(#2400 교훈: 게이트 통과≠발사),
    // suppress 여부의 유일한 관측 지점은 발사 호출이다.
    await runFinalTick();

    expect(mockFireLocalAlarmNotification).not.toHaveBeenCalled();
  });

  it('#2373 방어 negative — lock.trainCode가 PENDING(미확정)이면 gap(4)은 여전히 차단', async () => {
    mockGetBoardingLock.mockResolvedValue({ ...REAL_LOCK, trainCode: PENDING_TRAIN_CODE });

    await runFinalTick();

    expect(mockFireLocalAlarmNotification).not.toHaveBeenCalled();
  });

  it('#2373 방어 negative — lock은 있으나 candidate가 locked route arc 밖(같은 노선, 목적지 너머 이탈)이면 여전히 차단', async () => {
    mockGetBoardingLock.mockResolvedValue(REAL_LOCK);
    // 기준점을 목적지 바로 앞(중곡, forward 정상 진행 중)으로 두고, 최종 tick을 같은 노선(7호선)
    // 이지만 origin→destination arc 밖(용마산 너머 상봉 방향)으로 대체 — line은 같아 조기
    // early-return(#2373 "방금 환승" 경로)을 우회하지 않으면서 arc forward-only 판정 자체가
    // candidateArcIndex=-1(off-route)로 차단하는지 검증한다.
    const NEAR_DEST = findStationByNameAndLine('중곡', BOARDING_LINE)!;
    storage.set(
      BG_HOP_WINDOW_STATION_KEY,
      JSON.stringify({ destinationId: DESTINATION.id, station: NEAR_DEST }),
    );
    const OFF_ROUTE = findStationByNameAndLine('상봉', BOARDING_LINE)!;

    await processLocationUpdate({
      lat: OFF_ROUTE.lat,
      lng: OFF_ROUTE.lng,
      destination: DESTINATION,
      firedAlarms: new Set<string>(),
      sleepMode: false,
      storedRoute: STORED_ROUTE,
      source: 'bg',
      fusionSource: 'gps',
    });

    expect(mockFireLocalAlarmNotification).not.toHaveBeenCalled();
  });

  it('회귀 — 정상 근거리 hop(gap=1)은 기존대로 통과(우회 로직과 무관하게 불변)', async () => {
    mockGetBoardingLock.mockResolvedValue(REAL_LOCK);
    const NEAR_DEST = findStationByNameAndLine('중곡', BOARDING_LINE)!; // 용마산 직전역, gap=1
    storage.set(
      BG_HOP_WINDOW_STATION_KEY,
      JSON.stringify({ destinationId: DESTINATION.id, station: NEAR_DEST }),
    );

    const result = await runFinalTick();

    expect(mockFireLocalAlarmNotification).toHaveBeenCalled();
    expect(result.alarmEvent?.type).toBe('destination');
  });
});
