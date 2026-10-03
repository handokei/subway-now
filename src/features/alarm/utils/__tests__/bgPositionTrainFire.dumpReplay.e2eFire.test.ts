/**
 * #2400 (탑승 전 게이트, item 3 로직 증명) — 정직한 검증 spike.
 *
 * `bgPositionTrainFire.dumpReplay.test.ts`(#2385)는 `processLocationUpdate`(stationPipeline)를
 * mock해 지하 dump에서 "올바른 station을 채택한다"는 것만 증명했다 — 실제 도착 알람 발사
 * (`fireLocalAlarmNotification`)는 `processLocationUpdate` **내부**에서 일어나는데, 그 경로가
 * 한 번도 통으로 검증되지 않았다.
 *
 * 본 테스트는 같은 2026-08-26 덤프(E05A4F244EEB, `replay_20260826_underground_surface_misclassify`
 * 원문 근거)를 **`processLocationUpdate`를 mock하지 않고** 실체인으로 구동한다.
 *
 * REAL(mock 금지, 이슈 #2400 명시): `processLocationUpdate`(stationPipeline 전체) — 그 내부의
 * `findNearestStation`, `updateRouteFromPosition`/`findRoute`, `evaluateAlarmPhase`,
 * `evaluateBgHopWindowGate`(#2373), `evaluateMovement`(#2204), `crossCategoryStationDedup`(#1515/
 * #1643/#1656/#1901), `dismissSilenceGate`, `notificationState`/`hopWindowState`/
 * `dismissSilenceStorage`(AsyncStorage 위 real wrapper) 전부 real. `trackTrainProgress`/
 * `pickCandidateTrains`/`passesLockedStationGate`/`computeRouteArc`(bgPositionTrainFire 쪽)도
 * `bgPositionTrainFire.dumpReplay.test.ts`와 동일하게 real.
 *
 * mock 대상(leaf, 이슈 #2400 명시 6종 + 인프라 경계 2종만 추가):
 *   - `fireLocalAlarmNotification`(stationNotification) — 발사 여부 assert 대상 spy. 같은 모듈의
 *     `updateStationNotification`/`fireFgAuxStationPassedNotification`은 requireActual로 real
 *     유지(발사 판정과 무관한 후행 side-effect).
 *   - `getBoardingLock`(boardingLockStorage)
 *   - AsyncStorage(@react-native-async-storage/async-storage) — in-memory Map
 *   - `saveStationToWidget`(widgetStorage)
 *   - `fetchTrainPositions`(positionApi)
 *   - arrival storage — N/A: `evaluatePositionTrainFire`→`processLocationUpdate` 경로는
 *     `arrivalAtOrigin`/`arrivalsAtTransfers`를 전달하지 않아 arrival storage를 아예 참조하지
 *     않는다(이슈 배경 "live arrival API 불필요"와 일치) — mock할 대상 자체가 없음.
 *   - `expo-notifications` — 네이티브 SDK 경계(jest 환경에 NativeModule 없음). 발사 판정 로직이
 *     아니라 `updateStationNotification`이 호출하는 `scheduleNotificationAsync` 등이 크래시하지
 *     않도록 하는 인프라 shim. `live-activity`는 `requireOptionalNativeModule`이 jest에서 이미
 *     graceful null을 반환해(module 자체가 `Promise.resolve()`로 no-op) 별도 mock 불필요.
 *   - logger — 전 테스트 공통 관례(콘솔 출력 억제). 발사 판정과 무관.
 *
 * `_resetCrossCategoryDedupForTests()`(crossCategoryStationDedup.ts, real 모듈이 테스트 전용으로
 * 공식 노출)를 매 테스트 beforeEach에서 호출한다 — 이 모듈은 in-memory Map으로 테스트 파일 전체에서
 * 상태가 이어지므로(AsyncStorage와 달리 우리가 mock한 storage로 격리되지 않음), 리셋 없이는 이전
 * step의 8분 channel-agnostic backstop(#1901/#1900)이 다음 step의 정상 발사를 오차단한다 — 이는
 * production 코드 수정이 아니라 real 모듈이 제공하는 테스트 격리 유틸이다.
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

const mockFetchTrainPositions = jest.fn();
jest.mock('../../../nearest-station/api/positionApi', () => ({
  fetchTrainPositions: (...args: unknown[]) => mockFetchTrainPositions(...args),
}));

const mockSaveStationToWidget = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
  clearWidgetStation: jest.fn().mockResolvedValue(undefined),
}));

// leaf: 발사 여부를 spy로 assert. 같은 모듈의 다른 export(updateStationNotification/
// fireFgAuxStationPassedNotification)는 발사 판정과 무관한 real 코드 — requireActual로 유지.
const mockFireLocalAlarmNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../stationNotification', () => {
  const actual = jest.requireActual('../stationNotification');
  return {
    ...actual,
    fireLocalAlarmNotification: (...args: unknown[]) => mockFireLocalAlarmNotification(...args),
  };
});

// 인프라 경계 — 네이티브 SDK. real updateStationNotification이 크래시 없이 실행되도록 하는 shim.
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

import { evaluatePositionTrainFire } from '../bgPositionTrainFire';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { _resetCrossCategoryDedupForTests } from '../crossCategoryStationDedup';
import type { TrainPosition } from '../../../../shared/types/position';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
  BG_LAST_STATION_KEY,
  ALARM_EVENT_KEY,
} from '../../../../shared/constants/storageKeys';

// 덤프 `## Raw Signal` 실관측 순서(#2385/#2400 동일 근거) — 2호선 건대입구(2-012) 탑승 →
// 성수(2-011) → 뚝섬(2-010) 단일 leg 진행.
const BOARDING_LINE = '2';
const ORIGIN_NAME = '건대입구';
const OBSERVED_STATION_SEQUENCE = ['건대입구', '성수', '뚝섬'] as const;

const DESTINATION = findStationByNameAndLine('뚝섬', BOARDING_LINE)!;
const ORIGIN = findStationByNameAndLine(ORIGIN_NAME, BOARDING_LINE)!;
// #2400 명시: storedRoute + destination을 지하 탐지 station이 알람 waypoint가 되게 설정.
// 건대입구→성수→뚝섬 direct route(2 stops) — 성수 도달 시 remainingStops=1(early phase 조건),
// 뚝섬 도달 시 remainingStops=0. 뚝섬이 곧 destination 자체라 "알람 waypoint"다.
const ROUTE = { type: 'direct' as const, line: BOARDING_LINE, stops: 2 };
const LOCK_TRAIN_CODE = '2026082601';
const LOCK = {
  destinationId: DESTINATION.id,
  trainCode: LOCK_TRAIN_CODE,
  boardingStationId: ORIGIN.id,
  boardingLine: BOARDING_LINE,
  boardedAt: 0,
  expectedDurationMs: 600_000,
};

function buildTrainPosition(stationName: string, receivedAtMs: number): TrainPosition {
  return {
    statnId: findStationByNameAndLine(stationName, BOARDING_LINE)!.id,
    statnNm: stationName,
    trainNo: LOCK_TRAIN_CODE,
    trainStatus: 2,
    updnLine: 0,
    terminalStationId: DESTINATION.id,
    terminalStationName: DESTINATION.name,
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs,
  };
}

describe('evaluatePositionTrainFire → processLocationUpdate 실체인 end-to-end (#2400, item 3 발사 증명)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.clear();
    _resetCrossCategoryDedupForTests();
    storage.set(DESTINATION_KEY, JSON.stringify(DESTINATION));
    storage.set(SLEEP_MODE_KEY, 'false');
    storage.set(ROUTE_KEY, JSON.stringify(ROUTE));
    // BG_LAST_STATION_KEY 미설정 = anchor는 탑승역(건대입구) — 최초 step 전제.

    mockGetBoardingLock.mockResolvedValue(LOCK);
    mockSaveStationToWidget.mockResolvedValue(undefined);
    mockFireLocalAlarmNotification.mockResolvedValue(undefined);
    mockScheduleNotificationAsync.mockResolvedValue('id');
    mockDismissNotificationAsync.mockResolvedValue(undefined);
    mockGetAllScheduledNotificationsAsync.mockResolvedValue([]);
    mockCancelScheduledNotificationAsync.mockResolvedValue(undefined);
    mockGetPresentedNotificationsAsync.mockResolvedValue([]);
  });

  // OBSERVED_STATION_SEQUENCE[0](건대입구)은 탑승역 자체 — 새로 발사할 대상이 아니다. 열차가
  // 실제로 "진행"하는 다음 두 step만 검증한다: 성수(remainingStops=1, early 조건 충족) →
  // 뚝섬(destination 자체, remainingStops=0).
  const progressionSteps = OBSERVED_STATION_SEQUENCE.slice(1);

  it.each(progressionSteps.map((name, i) => [i, name] as const))(
    '실체인(processLocationUpdate 미mock): 역 진행(%s)에서 evaluateAlarmPhase가 non-null alarmEvent를 산출하고 fireLocalAlarmNotification이 실제로 호출된다',
    async (stepIndex, stationName) => {
      const anchorName = OBSERVED_STATION_SEQUENCE[stepIndex];
      const anchorStation = findStationByNameAndLine(anchorName, BOARDING_LINE)!;
      storage.set(
        BG_LAST_STATION_KEY,
        JSON.stringify({ station: anchorStation, distanceKm: 0, timestamp: 1 }),
      );

      mockFetchTrainPositions.mockResolvedValue({
        line: BOARDING_LINE,
        trains: [buildTrainPosition(stationName, 1_000 + stepIndex)],
      });

      const result = await evaluatePositionTrainFire();

      // evaluatePositionTrainFire가 true를 반환한다는 것은 lock/후보/게이트를 모두 통과해
      // processLocationUpdate까지 도달했다는 뜻 — 그러나 그것만으로는 "발사"를 증명하지 않는다
      // (#2385의 절반짜리 증명이 바로 이 지점에서 멈췄다). 아래 fireLocalAlarmNotification
      // assertion이 이 테스트의 진짜 목적지다.
      expect(result).toBe(true);

      // 🔴 핵심 assertion (#2400 acceptance): 실체인이 fireLocalAlarmNotification을 실제로
      // 호출했는가. destinationName은 stations.json BLDN_NM canonical 표기를 SSOT로 사용
      // (canonicalStationName, #1410 drift 흡수).
      expect(mockFireLocalAlarmNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'destination',
          phaseId: 'early',
          stationName: canonicalStationName('뚝섬', BOARDING_LINE),
        }),
        'positionTrain',
      );

      // 발사 성공 후 evaluatePositionTrainFire가 ALARM_EVENT_KEY를 영속화한다는 것은
      // processLocationUpdate가 alarmEvent를 non-null로 반환했다는 방증(별도 채널의 corroboration).
      expect(mockSetItem).toHaveBeenCalledWith(
        ALARM_EVENT_KEY,
        expect.stringContaining(canonicalStationName('뚝섬', BOARDING_LINE)),
      );
    },
  );
});
