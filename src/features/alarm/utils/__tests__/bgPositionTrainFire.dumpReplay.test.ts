/**
 * #2385 (Part of #2381) — mechanism-demo. #2384(`evaluatePositionTrainFire`,
 * `bgPositionTrainFire.ts`)가 2026-08-26 덤프(E05A4F244EEB)가 보여준 지하 environment
 * 오분류(`replay_20260826_underground_surface_misclassify.ts`, Deliverable 1)를 실제로
 * "뚫고" 올바른 역을 발사하는지 증명한다.
 *
 * REAL(mock 금지): `evaluatePositionTrainFire`, `trackTrainProgress`, `pickCandidateTrains`,
 * `passesLockedStationGate`, `computeRouteArc` — 실제 로직 검증이 핵심(이슈 #2385 명시 제약).
 * mock 대상만: `getBoardingLock`(boardingLockStorage), AsyncStorage(destination/route/
 * BG_LAST_STATION 영속화), `fetchTrainPositions`(positionApi — realtimePosition 원본
 * fetch), `processLocationUpdate`(stationPipeline — station 채택 후 fusion 진입점, spy).
 *
 * 정직 라벨(필수, 이슈 #2385 명시): `fetchTrainPositions`가 반환하는 `LinePositions`는
 * 덤프에 없어 **재구성**한 것 — `replay_20260809_g4_stale_gps_synthetic.ts`와 동일한
 * "mechanism-demo(합성이나 ground-truth 근거)" 성격이다. **발명이 아님**: 각 step의
 * `currentStationName`은 덤프 `## Raw Signal` 섹션에서 실제로 관측된 station 진행
 * (2호선 건대입구(2-012) → 성수(2-011) → 뚝섬(2-010), Raw Signal L444~L724 구간의
 * enter/exit 전이가 보여주는 실제 순서)을 그대로 가져온 것이고, trainNo/receivedAtMs 등
 * LinePositions의 다른 필드만 테스트 목적상 합성이다.
 *
 * 환경 독립 증명: 이 테스트는 environment/subsurface/barometer 관련 입력을 일절 세팅하지
 * 않는다 — `evaluatePositionTrainFire`(`bgPositionTrainFire.ts`)가애초에 그런 입력을 받지도
 * 참조하지도 않기 때문이다(파일 헤더 참고: "isUndergroundProfile()/wifiStation 게이트를 걸지
 * 않는다"). Deliverable 1(red fixture)이 증명한 "그 구간에서 environment가 surface로
 * 오분류된다"는 사실과 무관하게 이 경로가 정확한 역을 발사한다는 것 자체가 "환경 입력이 이
 * 코드 경로에 없다"는 증명이다.
 */
// evaluatePositionTrainFire는 isMinimalAlarmEnabled()(EXPO_PUBLIC_MINIMAL_ALARM 플래그) 게이트
// 뒤에 있다 — 이 mechanism-demo는 플래그 게이트 자체가 아니라 그 뒤 로직을 검증 대상으로 한다.
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

const mockProcessLocationUpdate = jest.fn();
jest.mock('../stationPipeline', () => ({
  processLocationUpdate: (...args: unknown[]) => mockProcessLocationUpdate(...args),
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
import type { TrainPosition } from '../../../../shared/types/position';
import {
  DESTINATION_KEY,
  SLEEP_MODE_KEY,
  ROUTE_KEY,
  BG_LAST_STATION_KEY,
} from '../../../../shared/constants/storageKeys';

// 덤프 `## Raw Signal` 실관측 순서(#2385 Deliverable 1 fixture와 동일 근거) — 2호선
// 건대입구(2-012) 탑승 → 성수(2-011) → 뚝섬(2-010) 단일 leg 진행.
const BOARDING_LINE = '2';
const ORIGIN_NAME = '건대입구';
const OBSERVED_STATION_SEQUENCE = ['건대입구', '성수', '뚝섬'] as const;

const DESTINATION = findStationByNameAndLine('뚝섬', BOARDING_LINE)!;
const ORIGIN = findStationByNameAndLine(ORIGIN_NAME, BOARDING_LINE)!;
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

describe('evaluatePositionTrainFire — 2026-08-26 덤프 mechanism-demo (real trackTrainProgress/pickCandidateTrains)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    storage.clear();
    storage.set(DESTINATION_KEY, JSON.stringify(DESTINATION));
    storage.set(SLEEP_MODE_KEY, 'false');
    storage.set(ROUTE_KEY, JSON.stringify(ROUTE));
    // BG_LAST_STATION_KEY 미설정 = anchor는 탑승역(건대입구) — 최초 step 전제.

    mockGetBoardingLock.mockResolvedValue(LOCK);
    mockProcessLocationUpdate.mockResolvedValue({ alarmEvent: null, nearest: null });
  });

  // OBSERVED_STATION_SEQUENCE[0](건대입구)은 탑승역 자체 — lock 등록 시점 station이라 이
  // 경로가 새로 발사할 대상이 아니다. 열차가 실제로 "진행"하는 다음 두 step만 검증한다.
  const progressionSteps = OBSERVED_STATION_SEQUENCE.slice(1);

  it.each(progressionSteps.map((name, i) => [i, name] as const))(
    'step %#: 실제 역 진행(%s)에서 REAL trackTrainProgress/pickCandidateTrains가 올바른 station 좌표 + fusionSource=position-train으로 processLocationUpdate를 호출한다',
    async (stepIndex, stationName) => {
      // anchor window(±3역) 보장 — BG_LAST_STATION을 직전 step 역으로 세팅(issue #2385 명시).
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

      const expectedStation = findStationByNameAndLine(stationName, BOARDING_LINE)!;
      expect(result).toBe(true);
      expect(mockProcessLocationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          lat: expectedStation.lat,
          lng: expectedStation.lng,
          fusionSource: 'position-train',
          source: 'bg',
        }),
      );
    },
  );

  it('environment/subsurface/barometer 입력을 일절 세팅하지 않아도(환경 독립) 발사한다', async () => {
    storage.set(
      BG_LAST_STATION_KEY,
      JSON.stringify({ station: ORIGIN, distanceKm: 0, timestamp: 1 }),
    );
    mockFetchTrainPositions.mockResolvedValue({
      line: BOARDING_LINE,
      trains: [buildTrainPosition('성수', 2_000)],
    });

    const result = await evaluatePositionTrainFire();

    expect(result).toBe(true);
    // AsyncStorage에 environment/subsurface 관련 키를 저장한 적 없음 — 이 경로는 그런 입력을
    // 참조조차 하지 않는다는 것을 mockFetchTrainPositions/mockProcessLocationUpdate 호출
    // 인자에 그런 필드가 전혀 등장하지 않는 것으로 재확인한다.
    expect(mockFetchTrainPositions).toHaveBeenCalledWith(BOARDING_LINE);
    const [[callArg]] = mockProcessLocationUpdate.mock.calls;
    expect(callArg).not.toHaveProperty('subsurface');
    expect(callArg).not.toHaveProperty('environment');
  });
});
