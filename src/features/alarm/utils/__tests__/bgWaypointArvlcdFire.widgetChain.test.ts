/**
 * #2993 — 매역 arvlCd 발사 → **위젯/BG_LAST_STATION 갱신** 사슬 축 게이트.
 *
 * ## 왜 별도 파일인가 (측정 근거)
 *
 * `bgWaypointArvlcdFire.test.ts`는 **`../bgFirePersist`를 mock한다**(그 파일 L24). 그래서 그
 * 스위트는 "`persistBgFireResult`가 호출됐다"까지만 보고 **그 안에서 위젯이 갱신되는지는
 * 원리적으로 볼 수 없다** — 사슬이 mock 경계에서 끊긴다.
 *
 * 실측(2026-10-15, device healthy env): `bgWaypointArvlcdFire.ts`의
 * `persistBgFireResult({ ..., nearest })`를 `nearest: null`로 바꿔 **이 경로만** 위젯 갱신을
 * 상실시켰더니 **11093개 테스트가 전부 green**이었다. 아무도 안 보고 있었다.
 *
 * 형제 경로는 덮여 있다 — `persistBgFireResult`의 caller 3개 중 2개만:
 *   - `bgPositionTrainFire.ts:193`     → `bgPositionTrainFire.test.ts:492`가 위젯 assert ✅
 *   - `undergroundConsensusFire.ts:137` → 위젯 assert ✅
 *   - `bgWaypointArvlcdFire.ts:154`     → **0건** ❌  ← 이 파일이 메운다
 *
 * ## 편측 패턴 (주석이 caller를 2개로 선언했다)
 *
 * `bgFirePersist.ts`의 doc이 *"BG 자가감지 발사 경로(`bgPositionTrainFire.ts` /
 * `undergroundConsensusFire.ts`)가 공유하는 ... **두 경로 모두** ..."* 라고 **범위를 2개로
 * 선언**하는데 실제 caller는 3개다. `tasks/HANDOFF-2026-10-14.md` §2의 편측 패턴 4건과 같은
 * 모양("한 분기만 다루고, 주석에 범위를 선언하고, 다음 작성자가 그 선언을 보증으로 읽는다").
 * 그 주석은 이 PR에서 3개로 정정했고, 이 테스트가 세 번째 caller를 **강제**한다.
 *
 * ## 사용자 영향
 *
 * 이 경로는 **매역 arvlCd 발사**(lock 활성 + GPS 독립, 지하 포함)다. 배선이 끊기면 알림은
 * 뜨지만 홈 위젯 현재역이 갱신되지 않고 `BG_LAST_STATION_KEY`도 안 써진다 — 지하에서는 GPS
 * 경로가 침묵하므로 그 stale이 길어진다.
 *
 * ## 규율
 *
 * `bgFirePersist`를 **mock하지 않는다**(이 파일의 존재 이유). leaf(`widgetStorage` /
 * `buildTripContext` / AsyncStorage)에서만 관측한다 — 형제 경로의 선례
 * (`bgPositionTrainFire.test.ts`)와 동일한 assert 모양.
 */
const mockGetItem = jest.fn();
const mockSetItem = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (...args: unknown[]) => mockGetItem(...args),
  setItem: (...args: unknown[]) => mockSetItem(...args),
}));

const mockProcessLocationUpdate = jest.fn();
jest.mock('../stationPipeline', () => ({
  processLocationUpdate: (...args: unknown[]) => mockProcessLocationUpdate(...args),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
}));

const mockGetFiredAlarms = jest.fn();
const mockSetFiredAlarms = jest.fn();
jest.mock('../notificationState', () => ({
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

// 의도적으로 `../bgFirePersist`를 mock하지 않는다 — 이 파일이 게이트하려는 사슬 구간이다.

const mockSaveStationToWidget = jest.fn();
jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
}));

const mockBuildWidgetTripContext = jest.fn();
jest.mock('../../../widget/utils/buildTripContext', () => ({
  buildWidgetTripContext: (...args: unknown[]) => mockBuildWidgetTripContext(...args),
}));

const mockIsMinimalAlarmEnabled = jest.fn();
jest.mock('../../../../shared/constants/debugFlags', () => ({
  isMinimalAlarmEnabled: () => mockIsMinimalAlarmEnabled(),
}));

jest.mock('../alarmLog', () => ({
  logWaypointArvlcdFireDiagnostic: jest.fn(),
}));

const mockPollWaypointArrivalIfDue = jest.fn();
jest.mock('../../../nearest-station/tasks/bgWaypointArrivalPoll', () => ({
  pollWaypointArrivalIfDue: (...args: unknown[]) => mockPollWaypointArrivalIfDue(...args),
}));

const mockFindStationByNameAndLine = jest.fn();
jest.mock('../../../../shared/utils/stationRoute', () => {
  const actual = jest.requireActual('../../../../shared/utils/stationRoute');
  return {
    ...actual,
    findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
  };
});

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { evaluateWaypointArvlcdFire } from '../bgWaypointArvlcdFire';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
  BG_LAST_STATION_KEY,
} from '../../../../shared/constants/storageKeys';
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';

const DESTINATION = { id: 'dest-1', name: '강남', line: '2', lat: 1, lng: 2 };
const DIRECT_ROUTE = { type: 'direct', line: '2', stops: 3 };
const LOCK_TRAIN_CODE = '2026090201';
const LOCK = {
  destinationId: 'dest-1',
  trainCode: LOCK_TRAIN_CODE,
  boardingStationId: 'S0',
  boardingLine: '7',
  boardedAt: 0,
  expectedDurationMs: 600_000,
};
const TARGET_STATION = { id: 'dest-1', name: '강남', line: '2', lat: 37.5, lng: 127.05 };
/** `processLocationUpdate`가 확정한 현재역 — 위젯에 그대로 forward돼야 하는 값. */
const RESOLVED_STATION = { id: 'S-resolved', name: '건대입구', line: '7', lat: 37.54, lng: 127.07 };
const RESOLVED_DISTANCE_KM = 0.042;
const TRIP_CONTEXT = { destinationName: '강남', stopsRemaining: 3 };

describe('#2993 매역 arvlCd 발사 → 위젯/BG_LAST_STATION 사슬 (bgFirePersist 실물)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetItem.mockResolvedValue(undefined);
    mockIsMinimalAlarmEnabled.mockReturnValue(true);
    mockGetBoardingLock.mockResolvedValue(LOCK);
    mockGetItem.mockImplementation((key: string) => {
      const map: Record<string, string> = {
        [DESTINATION_KEY]: JSON.stringify(DESTINATION),
        [SLEEP_MODE_KEY]: 'false',
        [ROUTE_KEY]: JSON.stringify(DIRECT_ROUTE),
      };
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null,
      );
    });
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    mockPollWaypointArrivalIfDue.mockResolvedValue({
      up: [{ trainCode: LOCK_TRAIN_CODE, arrivalCode: ARRIVAL_CODE.ENTERING }],
      down: [],
    });
    mockFindStationByNameAndLine.mockReturnValue(TARGET_STATION);
    // 사슬이 실제로 흐르려면 `nearest`가 있어야 한다(없으면 persist가 위젯 구간을 skip).
    mockProcessLocationUpdate.mockResolvedValue({
      alarmEvent: null,
      nearest: { station: RESOLVED_STATION, distanceKm: RESOLVED_DISTANCE_KM },
    });
    mockBuildWidgetTripContext.mockReturnValue(TRIP_CONTEXT);
  });

  it('arvlCd로 확정된 현재역이 위젯으로 forward된다 (mock 경계에서 끊기지 않는다)', async () => {
    const engaged = await evaluateWaypointArvlcdFire();

    // 전제 — 이 경로가 실제로 채택(engaged)됐다. false면 아래 assert가 "다른 이유로" 실패한다.
    expect(engaged).toBe(true);

    // 사슬 끝 — 위젯이 **확정된 그 역/거리/trip 컨텍스트**로 갱신된다. 형제 경로
    // (`bgPositionTrainFire.test.ts:492`)와 동일한 assert 모양.
    expect(mockSaveStationToWidget).toHaveBeenCalledWith(
      RESOLVED_STATION,
      RESOLVED_DISTANCE_KM,
      undefined,
      undefined,
      TRIP_CONTEXT,
    );
  });

  it('BG_LAST_STATION_KEY에도 같은 역이 적재된다 (다음 tick의 BG 컨텍스트 복원원)', async () => {
    await evaluateWaypointArvlcdFire();

    const entry = mockSetItem.mock.calls.find(([key]) => key === BG_LAST_STATION_KEY);
    expect(entry).toBeDefined();
    const persisted = JSON.parse(entry![1] as string) as {
      station: { name: string };
      distanceKm: number;
    };
    expect(persisted.station.name).toBe(RESOLVED_STATION.name);
    expect(persisted.distanceKm).toBe(RESOLVED_DISTANCE_KM);
  });

  // 거부 — 역이 확정되지 않은 tick(`nearest: null`)에는 위젯을 건드리지 않는다. stale보다
  // **잘못된 역**이 더 나쁘다(사용자가 다른 역을 현재역으로 본다).
  it('[거부] nearest가 없으면 위젯/BG_LAST_STATION을 쓰지 않는다', async () => {
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });

    await evaluateWaypointArvlcdFire();

    expect(mockSaveStationToWidget).not.toHaveBeenCalled();
    expect(mockSetItem.mock.calls.some(([key]) => key === BG_LAST_STATION_KEY)).toBe(false);
  });
});
