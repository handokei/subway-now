/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #2876 — lockless에서 tier8 detection-fused가 좋은 GPS를 무시하고 타 노선 원거리 역을
 * 현재역으로 채택하는 회귀 차단.
 *
 * 10/3 실측 (13:42:24~13:43:00, 트립 종료 직후): GPS가 을지로입구(2호선) d=17~26m
 * (accuracy 27~33m, 신선)인데 fusion cycle 소스가 `detection-fused` 종각(1호선) d=472m /
 * 시청(1호선) d=450m로 전환됨 (덤프 Fusion log L416-427).
 *
 * root: useFusedNearestStation.ts의 detectionVerdictAccepts 게이트는
 *   1. fused 후보 존재
 *   2. detectionVerdict.detected (2+ 신호 합의)
 *   3. fused.result.distanceKm ≤ 0.5km
 *   4. boardingLock 활성 시에만 line 일치 가드
 * lockless(boardingLock=null)에서는 ④가 비활성 → 500m 이내 cross-line 후보가 신선한
 * 좋은 GPS fix를 이긴다.
 *
 * fix 방향: lock 유무와 무관하게 — 신선한 좋은 GPS fix(accuracy ≤ GPS_DERIVED_ACCURACY_MAX_M)가
 * 있고, 그 GPS 최근접역(gpsTopCandidate)이 fused 후보와 노선·거리 양쪽 모두 어긋나면
 * tier8 채택을 보류한다. 지하(좋은 fix 부재)와 lock+line 일치 케이스는 무변경.
 */

jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
// tier7('fused')이 거리 게이트(delta/absolute)를 통과해 tier8 평가 전에 먼저 채택되는 것을 막아
// tier8(detection-verdict) 가드 자체를 isolation 테스트한다 (#1513 detectionVerdictCascade.test.ts와
// 동일 패턴). 실측 root(test1)는 delta mismatch로 자연히 fusedPasses=false가 되지만, 회귀 가드
// ②③은 GPS==fused 같은 역이라 delta=0으로 실제 게이트가 통과해버려 tier7이 tier8보다 먼저
// 채택되므로, tier8 고유 동작 검증을 위해 강제 isolation한다.
jest.mock('../../utils/fusionDistanceGate', () => ({
  passesFusionDistanceGate: () => false,
  isWithinArcWindow: () => true,
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import {
  GPS_BASE_DEFAULTS,
  arrivalRet,
  positionRet,
} from '../../../../testUtils/positionApiFixtures';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';
import { GPS_DERIVED_ACCURACY_MAX_M } from '../../../../shared/constants/realtime';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

const T0 = 1_000_000_000;

// 10/3 실측 핵심 역 — 을지로입구(2호선)와 종각(1호선)은 지리적으로 가깝지만 서로 다른 노선/역.
const eulji = findStationByNameAndLine('을지로입구', '2')!;
const jonggak = findStationByNameAndLine('종각', '1')!;
// 동일노선(1호선) 근거리 비교용 — 종각과 같은 1호선, GPS top candidate로 사용.
const sichung1 = findStationByNameAndLine('시청', '1')!;

function arrivedAt(line: string) {
  return makeArrivalInfo({
    destination: '',
    arrivalSeconds: 0,
    line,
    arrivalCode: 1,
    trainCode: 'T-2876',
    receivedAtMs: T0, // bestPriorityForArrival이 receivedAtMs<=0을 stale로 skip하므로 신선값 필수.
  });
}

interface SetupOpts {
  /** GPS top candidate (candidates[0]) — null이면 userLocation 자체를 비움 (지하 dead). */
  gpsStation?: typeof eulji | null;
  gpsDistanceKm?: number;
  gpsAccuracyMeters?: number | null;
  gpsFreshAgeMs?: number;
  /** fused가 채택할 후보(candidates[1]) — arvlCd=1로 arrival 신호를 줘서 fused.result로 승격. */
  fusedStation: typeof jonggak;
  fusedDistanceKm: number;
  boardingLock?: BoardingLock | null;
  motionStationary?: boolean;
  barometerStop?: boolean;
}

function setup({
  gpsStation = eulji,
  gpsDistanceKm = 0.02,
  gpsAccuracyMeters = GPS_DERIVED_ACCURACY_MAX_M - 17, // 실측(33m) ≤ 50m 좋은 fix
  gpsFreshAgeMs = 0,
  fusedStation,
  fusedDistanceKm,
}: SetupOpts) {
  const gpsDead = gpsStation === null;
  const live = gpsDead ? null : { station: gpsStation, distanceKm: gpsDistanceKm };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: gpsDead ? [] : [gpsStation],
    userLocation: gpsDead ? null : { lat: gpsStation.lat, lng: gpsStation.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: gpsDead ? null : gpsAccuracyMeters,
    lastFixAtMs: gpsDead ? null : T0 - gpsFreshAgeMs,
    refresh: jest.fn(),
  });

  // candidates[0] = GPS top candidate(제공 시), candidates[1] = fused가 승격할 후보.
  const candidateList = gpsDead
    ? [{ station: fusedStation, distanceKm: fusedDistanceKm }]
    : [
        { station: gpsStation, distanceKm: gpsDistanceKm },
        { station: fusedStation, distanceKm: fusedDistanceKm },
      ];
  mockFindTop.mockReturnValue(candidateList);

  mockArrival.mockImplementation((stationName: string | null, line: string | null) => {
    if (stationName === fusedStation.name && line === fusedStation.line) {
      return arrivalRet({ up: [arrivedAt(fusedStation.line)], down: [], isMock: false });
    }
    return arrivalRet(null);
  });
  mockPos.mockReturnValue(positionRet(null));
}

describe('#2876 tier8(detection-verdict) 좋은 GPS 가드', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('10/3 실측 재구성: lockless + 신선한 좋은 GPS(을지로입구 d=20m acc=33m) + fused 종각(1호선) d=472m cross-line → detection-fused 채택 X, GPS(을지로입구) 유지', () => {
    setup({
      gpsStation: eulji,
      gpsDistanceKm: 0.02,
      gpsAccuracyMeters: 33,
      gpsFreshAgeMs: 0,
      fusedStation: jonggak,
      fusedDistanceKm: 0.472,
    });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // lockless
        // motionStationary 미전달 — lockless + motionStationary===true면 #2418 정지 backoff가
        // candidate enumeration 자체를 skip해(stationaryBackoffActive) fused가 영구 null이
        // 되어 본 시나리오(tier8 cross-line 채택)를 재현할 수 없다. barometer-stop +
        // arvlcd-arrived 2신호 합의만으로 AGREEMENT_THRESHOLD(2) 충족.
        undefined,
        { subsurface: false, signal: { stop: true, subsurface: false } },
      ),
    );

    expect(hook.result.current.confidence).not.toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(eulji.id);
  });

  it('회귀 가드 ① 지하(좋은 fix 부재, accuracy=null) → 기존 tier8 채택 경로 무변경', () => {
    setup({
      gpsStation: eulji,
      gpsDistanceKm: 0.02,
      gpsAccuracyMeters: null, // 좋은 fix 부재 — 가드 비활성 조건
      fusedStation: jonggak,
      fusedDistanceKm: 0.3,
    });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // motionStationary 미전달 (lockless backoff 회피, 위 설명과 동일)
        { subsurface: true, signal: { stop: true, subsurface: true } },
      ),
    );

    expect(hook.result.current.confidence).toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(jonggak.id);
  });

  it('회귀 가드 ② lock 활성 + fused.line이 lock.boardingLine과 일치 → 무변경 (gpsTopCandidate도 같은 역/노선)', () => {
    const lock: BoardingLock = {
      destinationId: 'dest-1',
      trainCode: 'T-LOCK',
      boardingLine: jonggak.line,
      boardingStationId: jonggak.id,
      boardedAt: T0,
      expectedDurationMs: 600_000,
    };
    setup({
      gpsStation: jonggak, // GPS도 같은 역 — line/station 모두 fused와 동일 → 가드 미적용
      gpsDistanceKm: 0.3,
      gpsAccuracyMeters: 33,
      fusedStation: jonggak,
      fusedDistanceKm: 0.3,
    });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        lock.trainCode,
        lock,
        true,
        { subsurface: false, signal: { stop: true, subsurface: false } },
      ),
    );

    expect(hook.result.current.confidence).toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(jonggak.id);
  });

  it('회귀 가드 ③ 동일노선 근거리 fused 후보(정상 보강 케이스) → 여전히 채택', () => {
    // GPS top candidate(시청, 1호선)와 fused(종각, 1호선)가 같은 노선 — line 불일치 조건 미충족 → 가드 비활성.
    setup({
      gpsStation: sichung1,
      gpsDistanceKm: 0.3,
      gpsAccuracyMeters: 33,
      fusedStation: jonggak,
      fusedDistanceKm: 0.35,
    });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // motionStationary 미전달 (lockless backoff 회피, 위 설명과 동일)
        { subsurface: false, signal: { stop: true, subsurface: false } },
      ),
    );

    expect(hook.result.current.confidence).toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(jonggak.id);
  });
});
