/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1513 — multi-signal detection verdict cascade 결합 검증.
 *
 * 2026-06-19 trip 실측 evidence: 어린이대공원역 station-passed fire 0건. 지하 GPS drop
 * (acc 1400~2593m) 구간에서 fusedPasses=false → cascade가 routeResult/gps fallback으로
 * 떨어지고 verdict가 dormant 했던 회귀를 차단한다.
 *
 * 게이트 (false positive 방어 — ADR-010 두 실패 모드 동급):
 *   1. fused 후보 존재 — arrival 신호 기반 fusion 결과가 있어야 station identity 명확.
 *   2. detectionVerdict.detected — ≥2 신호 합의 (barometer-stop + motion-stationary +
 *      arvlcd-arrived 중 2개 이상 true).
 *   3. 근접 게이트 — fused.result.distanceKm ≤ DETECTION_FUSED_MAX_DISTANCE_KM(0.5km),
 *      또는 GPS userLocation 자체 부재 시 자동 면제.
 *
 * 우선순위: wifi > positionTrain > fused(passes) > **detection-verdict** > routeProgress > GPS.
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
// fusedPasses 강제 false — 지하 GPS 부정확(2km+) + lock 활성 시 실거리 게이트 reject를 시뮬레이션.
// 본 슬롯은 fusedPasses=false인 케이스를 다루므로 isolation 위해 mock.
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
import {
  GPS_BASE_DEFAULTS,
  arrivalRet,
  positionRet,
} from '../../../../testUtils/positionApiFixtures';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';
import type { Station } from '../../../../shared/types/station';
import type { BarometerSignal } from '../../../../shared/hooks/useBarometer';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

// 어린이대공원 (line 7) — evidence 시나리오 핵심 역.
const eodae: Station = {
  id: '7-016',
  name: '어린이대공원',
  line: '7',
  lineColor: '#747F00',
  lat: 37.5479,
  lng: 127.0744,
};

// arvlcd=1 (ARRIVED) arrival row — verdict의 arvlcd-arrived 신호 true 활성.
function arrivedAtEodae() {
  return makeArrivalInfo({
    destination: '',
    arrivalSeconds: 0,
    line: '7',
    arrivalCode: 1,
    trainCode: 'T-VERDICT',
  });
}

// barometer-stop=true (정차 패턴 감지). subsurface 키는 케이스별 변경.
function barometerStop(subsurface: boolean): {
  subsurface: boolean;
  signal: BarometerSignal;
} {
  return {
    subsurface,
    signal: {
      stop: true,
      subsurface,
    },
  };
}

interface SetupOpts {
  /** GPS dead zone(완전 dead) — userLocation=null. */
  gpsDead?: boolean;
  /** GPS 부정확 거리 — fused.result.distanceKm가 이 값. fusedPasses 거리 게이트 통과 여부 결정. */
  fusedDistanceKm?: number;
  /** arrival arvlCd=1 (도착) 신호 활성 여부. */
  arrivedSignal?: boolean;
}

function setupGpsDropAtEodae({
  gpsDead = false,
  fusedDistanceKm = 0.3,
  arrivedSignal = true,
}: SetupOpts = {}) {
  const live = { station: eodae, distanceKm: fusedDistanceKm };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [eodae],
    userLocation: gpsDead ? null : { lat: eodae.lat, lng: eodae.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: gpsDead ? null : 2000,
    refresh: jest.fn(),
  });
  // candidates: 어린이대공원만. gpsDead일 때도 fused가 후보 없으면 null이 되어 verdict 슬롯 비활성.
  // 본 fixture는 verdict가 fused 후보 위에서 작동함을 검증하기 위해 gpsDead=true여도 후보 1개 유지.
  mockFindTop.mockReturnValue([{ station: eodae, distanceKm: fusedDistanceKm }]);

  mockArrival.mockImplementation(
    (stationName: string | null, line: string | null) => {
      if (stationName === eodae.name && line === '7' && arrivedSignal) {
        return arrivalRet({
          stationName: eodae.name,
          line: '7',
          up: [arrivedAtEodae()],
          down: [],
          isMock: false,
        });
      }
      return arrivalRet(null);
    },
  );
  mockPos.mockReturnValue(positionRet(null));
}

describe('#1513 detection-verdict cascade slot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GPS drop + verdict 합의(barometer+motion+arvlcd) + 근접 게이트 통과 → detection-fused 채택', () => {
    setupGpsDropAtEodae({ fusedDistanceKm: 0.3, arrivedSignal: true });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true, // motionStationary
        barometerStop(true),
      ),
    );

    expect(hook.result.current.confidence).toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(eodae.id);
  });

  it('GPS userLocation=null(완전 dead) → candidates=[] → fused=null → 슬롯 자연 비활성', () => {
    // 지하 dead zone 완전 GPS 실패. station identity 산출은 wifi/positionTrain/lock cascade가 담당하며
    // 본 슬롯은 비활성. confidence는 'gps-only-underground'(barometerSubsurface=true 강등) 또는 'gps-only'.
    setupGpsDropAtEodae({ gpsDead: true, fusedDistanceKm: 999, arrivedSignal: true });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        barometerStop(true),
      ),
    );

    expect(hook.result.current.confidence).not.toBe('detection-fused');
  });

  it('verdict 단일 신호(< AGREEMENT_THRESHOLD)이면 채택 X — false positive 방어', () => {
    // arrival arvlcd-arrived 단일 신호만 활성. motion/barometer 미제공 → signalsAgreed=1 < 2.
    setupGpsDropAtEodae({ fusedDistanceKm: 0.8, arrivedSignal: true });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // motion 미제공
        undefined, // barometer 미제공
      ),
    );

    // verdict 미합의 → cascade는 detection-fused 슬롯을 거부. fusedPasses=false(거리 0.8>0.6)이고
    // routeResult 없음 → gps-only fallback (또는 arrival 점수로 fused 통과 시 arrival-confirmed).
    expect(hook.result.current.confidence).not.toBe('detection-fused');
  });

  it('verdict 합의해도 fused.distance > 0.5km + GPS 있음 → 거리 게이트 reject, detection-fused 채택 X', () => {
    // fused 후보는 1km 떨어진 역. GPS는 살아있어 거리 검증 비면제. verdict는 detected지만 거리 fail.
    setupGpsDropAtEodae({
      gpsDead: false,
      fusedDistanceKm: 1.0,
      arrivedSignal: true,
    });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        barometerStop(true),
      ),
    );

    expect(hook.result.current.confidence).not.toBe('detection-fused');
  });

  it('lock 활성 + fused.line이 lock.boardingLine과 불일치 → cross-line reject (cascade slot line 가드)', () => {
    // 사용자가 line=2 lock인데 fused가 line=7 → 본 슬롯 line 가드 reject (ADR-015 §9 정신).
    setupGpsDropAtEodae({ fusedDistanceKm: 0.3, arrivedSignal: true });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        'LOCK-2',
        {
          trainCode: 'LOCK-2',
          boardingLine: '2',
          boardingStationId: '0201',
          boardedAt: 1000,
        },
        true,
        // barometer.subsurface=false — 'gps-only-underground'→'detection-fused' 사후 승격(line 998)
        // 경로를 차단해 본 슬롯의 line 가드만 평가되도록 격리.
        { subsurface: false, signal: { stop: true, subsurface: false } },
      ),
    );

    expect(hook.result.current.confidence).not.toBe('detection-fused');
  });

  it('lock 활성 + fused.line이 lock.boardingLine과 일치 → cascade slot 정상 작동', () => {
    // 사용자가 line=7 lock + line=7 어린이대공원 fused → 본 슬롯 line 가드 통과.
    setupGpsDropAtEodae({ fusedDistanceKm: 0.3, arrivedSignal: true });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        'LOCK-7',
        {
          trainCode: 'LOCK-7',
          boardingLine: '7',
          boardingStationId: eodae.id,
          boardedAt: 1000,
        },
        true,
        barometerStop(true),
      ),
    );

    expect(hook.result.current.confidence).toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(eodae.id);
  });
});
