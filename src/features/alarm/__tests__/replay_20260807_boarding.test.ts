/* eslint-disable import/no-restricted-paths --
 * Evidence-replay 통합 테스트: arrivalApi(arrival feature) truncation → useBoardingLockController
 * (alarm feature) auto-lock 오노선 선택까지 두 feature에 걸친 실제 회귀 chain을 한 fixture로
 * 재현하기 위해 두 feature의 export를 모두 필요로 한다. 프로덕션 코드는 이 import 경계를
 * 넘지 않음 — 본 파일은 test-only evidence replay (Issue #2207 / ADR-027 epic #2206).
 */
/**
 * 2026-08-07 건대입구(2·7호선) 환승역 boarding 후보 truncation + auto-lock 오노선 red fixture
 * (Issue #2207, Part of ADR-027 epic #2206).
 *
 * evidence: `/Users/kimdohan/Downloads/텍스트-123E02178164-1.txt` 덤프.
 *   - 건대입구서 line-2 boarding 후보가 빈 리스트로 노출 (성수 도착쯤에야 2038(line2) 등장).
 *   - Auto-lock Candidate 섹션: `candidate=trainCode=7377 line=7` (엉뚱한 7호선 열차 선택).
 *     BoardingLock Lifecycle: lock-create가 결국 user-tap 2038(line2) @성수로 뒤늦게 발생.
 *
 * 근본 원인:
 *   1. `arrivalApi.ts:106` — Seoul API `/0/10/` 전노선(전 line) 응답을 line 필터 없이
 *      `:169`에서 방향(up/down)별 slice(0, maxPerDirection=2)만 적용한다. 환승역에서 한
 *      line의 열차가 응답 앞쪽을 채우면 다른 line 후보가 통째로 truncation된다.
 *   2. `useBoardingLockController.ts:484` — autoLock effect가 `pickAutoTrainCodeFromArrivals`로
 *      고른 후보를 `allowedLines`(trip route 허용 line 집합)로만 검증한다. 건대입구 환승
 *      route(2↔7)는 allowedLines={2,7}라 line-7 후보(7377)도 그대로 통과 — "지금 서 있는
 *      플랫폼의 line"과 무관하게 arvlCd 우선순위(DEPARTED>ARRIVED>ENTERING)만으로 결정된다.
 *
 * 본 테스트는 ADR-027(#2206)의 green flip 전, 현재 코드에서 위 두 증상이 그대로 재현됨을
 * 증명하는 red fixture다. `it.failing`으로 감싸 CI green을 유지하면서 "버그가 존재함"을
 * 고정한다. 프로덕션 코드는 건드리지 않는다 — #2208(arrivalApi line 필터)/#2209(auto-lock
 * line 필터)가 fix + green flip을 담당한다.
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { fetchArrivalInfo } from '../../arrival/api/arrivalApi';
import {
  useBoardingLockController,
  type UseBoardingLockControllerInputs,
} from '../hooks/useBoardingLockController';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { makeTransferRoute } from '../../../testUtils/routeFixtures';
import { canonicalStationName } from '../../../testUtils/canonicalStationName';
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { Station } from '../../../shared/types/station';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'Light', Medium: 'Medium', Heavy: 'Heavy' },
  NotificationFeedbackType: { Success: 'Success', Warning: 'Warning', Error: 'Error' },
  notificationAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockGetBoardingLock = jest.fn();
const mockSetBoardingLock = jest.fn();
const mockClearBoardingLock = jest.fn();
jest.mock('../utils/boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
  setBoardingLock: (...args: unknown[]) => mockSetBoardingLock(...args),
  clearBoardingLock: (...args: unknown[]) => mockClearBoardingLock(...args),
}));

// 건대입구는 환승역이라 resolveTripDirection이 방향을 못 정하는 경우를 재현 — null이면
// directionalArrivals가 up+down 합집합이라 두 line 후보가 그대로 섞인다 (오늘 evidence와 정합).
const mockResolveTripDirection = jest.fn<null, unknown[]>(() => null);
jest.mock('../../route/utils/tripDirection', () => ({
  resolveTripDirection: (...args: unknown[]) => mockResolveTripDirection(...args),
}));

const mockFindStationByNameAndLine = jest.fn<null, unknown[]>(() => null);
jest.mock('../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
}));

jest.mock('../../nearest-station/utils/movementGate', () => ({
  STATIC_SPEED_THRESHOLD_MPS: 0.5,
}));

jest.mock('../store/useUserIntentStore', () => ({
  useUserIntentStore: {
    getState: () => ({ setInfoModeEnabled: jest.fn(() => Promise.resolve()) }),
  },
}));

describe('#2207 건대입구(2·7) arrivalApi truncation red fixture — flip in #2208', () => {
  const GUNDAE_LINE2_NAME = canonicalStationName('건대입구', '2');

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
    jest.restoreAllMocks();
  });

  it.failing(
    '건대입구 전노선(2·7) 혼합 realtimeArrivalList — 상행 line-2 후보가 slice(0,2) truncation으로 0건',
    async () => {
      // evidence 재구성: Seoul API가 상행 방향에 7호선 3대 → 2호선 2대 순서로 응답. 앱은
      // maxPerDirection=2로 line 구분 없이 잘라, 2호선 두 대가 통째로 사라진다.
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          realtimeArrivalList: [
            { subwayId: '1007', btrainNo: '7370', barvlDt: 60, updnLine: '상행', trainLineNm: '장암행', arvlCd: 3 },
            { subwayId: '1007', btrainNo: '7371', barvlDt: 180, updnLine: '상행', trainLineNm: '장암행', arvlCd: 3 },
            { subwayId: '1007', btrainNo: '7372', barvlDt: 300, updnLine: '상행', trainLineNm: '장암행', arvlCd: 3 },
            { subwayId: '1002', btrainNo: '2036', barvlDt: 420, updnLine: '상행', trainLineNm: '성수행', arvlCd: 3 },
            { subwayId: '1002', btrainNo: '2038', barvlDt: 540, updnLine: '상행', trainLineNm: '성수행', arvlCd: 3 },
          ],
        }),
      });

      const result = await fetchArrivalInfo(GUNDAE_LINE2_NAME);

      // 수리 후 기대치 (#2208): line-2 상행 후보 > 0. 현재는 line 필터 없는 slice(0,2)가
      // 두 line-7 열차만 남기고 line-2를 전부 truncation — evidence의 "빈 리스트"를 그대로 재현.
      const line2Up = result.up.filter((arrival: ArrivalInfo) => arrival.line === '2');
      expect(line2Up.length).toBeGreaterThan(0);
    },
  );
});

describe('#2207 건대입구(2·7) auto-lock 오노선 red fixture — flip in #2209', () => {
  // 건대입구(2·7) — 사용자는 실제로 2호선 플랫폼에 서 있는 상태 (evidence: 최종 lock은 2호선).
  const GUNDAE_LINE2_STATION: Station = {
    id: '2-012',
    name: canonicalStationName('건대입구', '2'),
    line: '2',
    lineColor: '#009D3E',
    lat: 37.540373,
    lng: 127.069191,
  };

  // 건대입구 환승 route(2↔7) — allowedLines={2,7}. 두 line 모두 route상 유효하므로
  // allowedLines 검증만으로는 "지금 서 있는 line"을 구분할 수 없다 (근본 원인의 핵심).
  const gundaeTransferRoute = makeTransferRoute({
    transferName: canonicalStationName('건대입구', '7'),
    fromLine: '2',
    toLine: '7',
    stopsToTransfer: 3,
    stopsFromTransfer: 6,
  });

  function makeTrain(overrides: Partial<ArrivalInfo> = {}): ArrivalInfo {
    return {
      destination: '종착',
      arrivalMinutes: 1,
      arrivalSeconds: 60,
      statusMessage: '',
      trainCode: 'X',
      line: '2',
      receivedAtMs: 0,
      arrivalCode: -1,
      isLastTrain: false,
      trainType: 'normal',
      ...overrides,
    };
  }

  // evidence 재구성: line-7 열차(7377)가 DEPARTED(2, 최우선 tier)로 관측되고, 실제 탑승
  // 대상인 line-2 열차(2038)는 ARRIVED(1, 후순위 tier)로만 관측된다. Seoul API가 두 line
  // 응답을 함께 실어 보내는 환승역 특성상 실제로 흔한 순서다 (직전 describe의 truncation과
  // 별개로, truncation을 뚫고 살아남은 후보 조합만으로도 오선택이 재현됨을 보인다).
  const mixedLineArrival: StationArrival = {
    up: [makeTrain({ trainCode: '7377', line: '7', arrivalCode: ARRIVAL_CODE.DEPARTED })],
    down: [makeTrain({ trainCode: '2038', line: '2', arrivalCode: ARRIVAL_CODE.ARRIVED })],
  };

  const defaultInputs: UseBoardingLockControllerInputs = {
    destinationId: 'dest-seongsu',
    destinationName: canonicalStationName('성수', '2'),
    route: gundaeTransferRoute,
    arrival: mixedLineArrival,
    currentStation: GUNDAE_LINE2_STATION,
    expectedDurationMinutes: 20,
    // #1926 4-signal consensus를 pass 상태로 고정 — 이 red fixture의 관심사는 line 오선택이라,
    // consensus gate 자체는 기존 회귀 스코프 밖.
    barometerSubsurface: false,
    accelerometerPattern: 'automotive',
    cellularEnvironmentVote: 'surface',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveTripDirection.mockReturnValue(null);
    mockFindStationByNameAndLine.mockReturnValue(null);
    mockGetBoardingLock.mockResolvedValue(null);
    mockSetBoardingLock.mockResolvedValue(undefined);
    mockClearBoardingLock.mockResolvedValue(undefined);
    useBoardingLockStore.setState({ lock: null });
  });

  it(
    '건대입구 환승(2·7) 혼합 후보 — auto-lock이 line=7(7377) 대신 line=2(2038)을 선택 ' +
      '(#2209: directionalArrivals가 approachLine 확정값으로 사전필터)',
    async () => {
      const createLockMock = jest.fn().mockResolvedValue(undefined);
      useBoardingLockStore.setState({ lock: null, createLock: createLockMock });

      renderHook(() => useBoardingLockController(defaultInputs));

      await waitFor(() => {
        expect(createLockMock).toHaveBeenCalled();
      });
      const created = createLockMock.mock.calls[0][0];

      // 수리 후 기대치 (#2209): 사용자가 실제로 서 있는 2호선 플랫폼 기준 line=2
      // (trainCode=2038)로 lock이 생성돼야 한다. 현재는 pickAutoTrainCodeFromArrivals가
      // line 구분 없이 arvlCd=DEPARTED(2) 최우선 tier인 7377(line=7)을 그대로 골라
      // auto-lock까지 통과한다 (evidence의 `candidate=trainCode=7377 line=7` 그대로 재현).
      expect(created.boardingLine).toBe('2');
      expect(created.trainCode).toBe('2038');
    },
  );
});
