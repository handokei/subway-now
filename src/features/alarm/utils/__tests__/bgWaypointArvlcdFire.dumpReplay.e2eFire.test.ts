/**
 * #2480 — 2026-09-02 저녁 직행(건대입구→용마산, 7호선) RED→GREEN 재현.
 *
 * 배경: 그날 저녁 garbage GPS(지하 drift, ~2500m 오차)로 `#2383`(evaluatePositionTrainFire,
 * realtimePosition 열차 매칭)이 트랙 후보를 못 찾아 매 tick false를 반환했고, GPS accuracy
 * 게이트도 실패해 gate-accuracy 강등 분기(#2381 consensus)로만 빠졌다 — 그 경로 역시 WiFi
 * 매칭 실패로 발사하지 못해 용마산 도착 알림이 0건이었다.
 *
 * 이 spine(`evaluateWaypointArvlcdFire`)은 GPS/WiFi/열차위치매칭 전부 무관하게 "내 목적지(다음
 * waypoint)에 내 열차가 도착하나"만 arvlCd로 직접 확인한다 — lock에 real trainCode가 있고
 * 목적지 arvlCd가 ENTERING/ARRIVED로 응답하면 GPS 상태와 완전히 독립적으로 발사한다.
 *
 * REAL(mock 금지): `processLocationUpdate`(stationPipeline 전체, `bgPositionTrainFire.
 * dumpReplay.e2eFire.test.ts`와 동일 취지 — 발사 함수 도달까지 실체인 검증), `resolveAllTargets`/
 * `alarmKey`(stationAlarm), `isImminentByArrivalCode`(arrival), `pollWaypointArrivalIfDue`/
 * `pollWithCooldown`(제네릭 쿨다운 skeleton), `findStationByNameAndLine`/`getStationById`
 * (stationRoute, 실제 stations.json).
 *
 * mock 대상(leaf, `bgPositionTrainFire.dumpReplay.e2eFire.test.ts`와 동일 원칙 — 인프라 경계 +
 * 발사 여부 assert 대상만):
 *   - `getBoardingLock`(boardingLockStorage)
 *   - AsyncStorage — in-memory Map
 *   - `createArrivalProvider`(arrival provider factory) — 네트워크 fetch 경계
 *   - `fireLocalAlarmNotification`(stationNotification) — 발사 여부 spy
 *   - `saveStationToWidget`(widgetStorage)
 *   - `expo-notifications` — 네이티브 SDK 경계
 *   - logger
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

const mockGetArrival = jest.fn();
jest.mock('../../../arrival/providers/factory', () => ({
  createArrivalProvider: () => ({ getArrival: (...args: unknown[]) => mockGetArrival(...args) }),
}));

const mockSaveStationToWidget = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
  clearWidgetStation: jest.fn().mockResolvedValue(undefined),
}));

// leaf: 발사 여부를 spy로 assert. 같은 모듈의 다른 export는 real 유지.
const mockFireLocalAlarmNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../stationNotification', () => {
  const actual = jest.requireActual('../stationNotification');
  return {
    ...actual,
    fireLocalAlarmNotification: (...args: unknown[]) => mockFireLocalAlarmNotification(...args),
  };
});

// 인프라 경계 — 네이티브 SDK.
const mockScheduleNotificationAsync = jest.fn().mockResolvedValue('id');
const mockDismissNotificationAsync = jest.fn().mockResolvedValue(undefined);
const mockGetAllScheduledNotificationsAsync = jest.fn().mockResolvedValue([]);
const mockCancelScheduledNotificationAsync = jest.fn().mockResolvedValue(undefined);
const mockGetPresentedNotificationsAsync = jest.fn().mockResolvedValue([]);
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockScheduleNotificationAsync(...args),
  dismissNotificationAsync: (...args: unknown[]) => mockDismissNotificationAsync(...args),
  getAllScheduledNotificationsAsync: (...args: unknown[]) =>
    mockGetAllScheduledNotificationsAsync(...args),
  cancelScheduledNotificationAsync: (...args: unknown[]) =>
    mockCancelScheduledNotificationAsync(...args),
  getPresentedNotificationsAsync: (...args: unknown[]) =>
    mockGetPresentedNotificationsAsync(...args),
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

import { evaluateWaypointArvlcdFire } from '../bgWaypointArvlcdFire';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { _resetCrossCategoryDedupForTests } from '../crossCategoryStationDedup';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
  ALARM_EVENT_KEY,
} from '../../../../shared/constants/storageKeys';

// 2026-09-02 저녁 직행 evidence — 건대입구(7-212) 탑승 → 용마산(7-211) 목적지, 단일 leg.
const LINE = '7';
const ORIGIN_NAME = '건대입구';
const DESTINATION_NAME = '용마산';

const DESTINATION = findStationByNameAndLine(DESTINATION_NAME, LINE)!;
const ORIGIN = findStationByNameAndLine(ORIGIN_NAME, LINE)!;
const ROUTE = { type: 'direct' as const, line: LINE, stops: 4 };
const LOCK_TRAIN_CODE = '2026090201';
const LOCK = {
  destinationId: DESTINATION.id,
  trainCode: LOCK_TRAIN_CODE,
  boardingStationId: ORIGIN.id,
  boardingLine: LINE,
  boardedAt: 0,
  expectedDurationMs: 600_000,
};

describe('evaluateWaypointArvlcdFire → processLocationUpdate 실체인 end-to-end (#2480, 9/2 저녁 용마산 재현)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.clear();
    _resetCrossCategoryDedupForTests();
    storage.set(DESTINATION_KEY, JSON.stringify(DESTINATION));
    storage.set(SLEEP_MODE_KEY, 'false');
    storage.set(ROUTE_KEY, JSON.stringify(ROUTE));

    mockGetBoardingLock.mockResolvedValue(LOCK);
    mockSaveStationToWidget.mockResolvedValue(undefined);
    mockFireLocalAlarmNotification.mockResolvedValue(undefined);
    mockScheduleNotificationAsync.mockResolvedValue('id');
    mockDismissNotificationAsync.mockResolvedValue(undefined);
    mockGetAllScheduledNotificationsAsync.mockResolvedValue([]);
    mockCancelScheduledNotificationAsync.mockResolvedValue(undefined);
    mockGetPresentedNotificationsAsync.mockResolvedValue([]);
  });

  // 🔴 핵심(#2480 acceptance): garbage GPS(evaluatePositionTrainFire 실패 대상 시나리오)에서도
  // GPS 좌표를 전혀 참조하지 않고 목적지 arvlCd만으로 발사한다 — 발사 함수 도달까지 assert
  // (게이트 통과만으로는 불충분, #2400과 동일 원칙).
  it('lock real trainCode + 목적지 arvlCd ENTERING → destination 발사(GREEN)', async () => {
    mockGetArrival.mockResolvedValue({
      up: [{ trainCode: LOCK_TRAIN_CODE, arrivalCode: ARRIVAL_CODE.ENTERING }],
      down: [],
      isMock: false,
    });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(true);
    expect(mockGetArrival).toHaveBeenCalledWith(DESTINATION_NAME, { lineHint: LINE });

    // 🔴 진짜 목적지 — fireLocalAlarmNotification이 실제로 호출됐는가.
    expect(mockFireLocalAlarmNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'destination',
        stationName: canonicalStationName(DESTINATION_NAME, LINE),
      }),
      'positionTrain',
    );

    expect(mockSetItem).toHaveBeenCalledWith(
      ALARM_EVENT_KEY,
      expect.stringContaining(canonicalStationName(DESTINATION_NAME, LINE)),
    );
  });

  it('lock real trainCode + 목적지 arvlCd ARRIVED → destination 발사(GREEN)', async () => {
    mockGetArrival.mockResolvedValue({
      up: [{ trainCode: LOCK_TRAIN_CODE, arrivalCode: ARRIVAL_CODE.ARRIVED }],
      down: [],
      isMock: false,
    });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(true);
    expect(mockFireLocalAlarmNotification).toHaveBeenCalled();
  });

  // negative 1 — PENDING trainCode(#2407 fallback lock, 미확정)로는 절대 발사하지 않는다.
  it('lock.trainCode가 PENDING sentinel이면 arvlCd가 ENTERING이어도 발사하지 않는다 (오발사 0)', async () => {
    const { PENDING_TRAIN_CODE } = jest.requireActual('../../../../shared/constants/boardingLock');
    mockGetBoardingLock.mockResolvedValue({ ...LOCK, trainCode: PENDING_TRAIN_CODE });
    mockGetArrival.mockResolvedValue({
      up: [{ trainCode: LOCK_TRAIN_CODE, arrivalCode: ARRIVAL_CODE.ENTERING }],
      down: [],
      isMock: false,
    });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockGetArrival).not.toHaveBeenCalled();
    expect(mockFireLocalAlarmNotification).not.toHaveBeenCalled();
  });

  // negative 2 — 내 열차가 아직 도착 확증되지 않았으면(DEPARTED 등) 조용히 미발사.
  it('목적지 arvlCd가 내 열차의 ENTERING/ARRIVED가 아니면 발사하지 않는다 (오발사 0)', async () => {
    mockGetArrival.mockResolvedValue({
      up: [{ trainCode: LOCK_TRAIN_CODE, arrivalCode: ARRIVAL_CODE.DEPARTED }],
      down: [],
      isMock: false,
    });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockFireLocalAlarmNotification).not.toHaveBeenCalled();
  });

  // negative 3 — arvlCd 응답에 내 trainCode 자체가 없으면(다른 열차만 응답) 미확증 → 미발사.
  it('목적지 arvlCd 응답에 내 trainCode가 없으면 발사하지 않는다 (오발사 0)', async () => {
    mockGetArrival.mockResolvedValue({
      up: [{ trainCode: '다른열차', arrivalCode: ARRIVAL_CODE.ENTERING }],
      down: [],
      isMock: false,
    });

    const result = await evaluateWaypointArvlcdFire();

    expect(result).toBe(false);
    expect(mockFireLocalAlarmNotification).not.toHaveBeenCalled();
  });
});
