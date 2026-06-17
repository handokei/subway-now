/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1418 — 환경 인지 fusion arbitration. lockless-route-hop / default-hop(Tier 5 시간 적분) forward
 * ratchet reject 게이트 회귀 방지. 22:32:41 청담 false fire 시나리오 재현:
 *
 * 1. lockless trip (boardingLock=null, destination 설정만 됨)
 * 2. 정적 사용자 (GPS @ 용마산, accuracy 14m → Tier 1 surfaceSSOT 합의 후보)
 * 3. 시간 경과 → lockless-route-hop이 청담(arc 7번 hop)을 가리킴
 * 4. surfaceSSOT 활성 → Tier 5 reject → result는 cascade 산출 그대로(gps-only)
 */

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import {
  arrivalRet,
  positionRet,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';

jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const chungdam = findStationByNameAndLine('청담', '7')!;
const konkuk = findStationByNameAndLine('건대입구', '7')!;

function setupLocklessTripAtYongmasan({
  gpsAccuracy = 14,
  arrivalAtYongmasan = null,
}: {
  gpsAccuracy?: number | null;
  arrivalAtYongmasan?: ReturnType<typeof makeArrivalInfo> | null;
} = {}) {
  // lockless trip — boardingLock 없음, route만 활성. tripStartedAt 5분 전 → lockless-route-hop
  // 적분이 arc 끝 청담을 가리킴.
  const T0 = 1_700_000_000_000;
  jest.setSystemTime(T0);

  // GPS 용마산 정적 보고. accuracy 변경으로 surfaceSSOT 활성/비활성 전환.
  mockNearest.mockReturnValue({
    result: { station: yongmasan, distanceKm: 0 },
    variants: [yongmasan],
    userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: gpsAccuracy,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);

  // arrival mock: 용마산 슬롯에 arvlCd=1(도착) row를 가진 response.
  mockArrival.mockImplementation((stationName: string | null, line: string | null) => {
    if (stationName === yongmasan.name && line === '7' && arrivalAtYongmasan !== null) {
      return arrivalRet({ up: [arrivalAtYongmasan], down: [] });
    }
    return arrivalRet(null);
  });
  // 열차 위치 없음 → positionTrainResult null.
  mockPos.mockReturnValue(positionRet(null));

  const route = makeDirectRoute(8, '7'); // 8 hops from yongmasan
  const routeContext = { route, origin: yongmasan, destination: chungdam };

  const hook = renderHook(() => useFusedNearestStation(undefined, undefined, routeContext));

  // tripStartedAt fallback = T0. 시간 경과 → lockless-route-hop 적분이 arc 끝으로 진행.
  jest.setSystemTime(T0 + 60 * 60_000); // 60분 경과 → 가능한 모든 hop 적분 완료
  hook.rerender({});

  return hook;
}

describe('#1418 Tier 5 reject — lockless-route-hop forward ratchet 차단', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('surfaceSSOT 활성(GPS 정상 + Arrival arvlCd=1) → Tier 5 차단, lockless-route-hop override X', () => {
    // 22:32:41 청담 회귀 재현: GPS 용마산 14m, 같은 역 arrival 도착 → Tier 1 합의.
    const result = setupLocklessTripAtYongmasan({
      gpsAccuracy: 14,
      arrivalAtYongmasan: makeArrivalInfo({
        destination: '',
        arrivalSeconds: 0,
        line: '7',
        arrivalCode: 1,
        trainCode: 'T-SSOT',
      }),
    });

    // Tier 5(lockless-route-hop)가 청담(arc 끝)을 가리켜도 surfaceSSOT가 reject.
    // 결과는 cascade 산출 그대로 — GPS 용마산.
    expect(result.result.current.source).not.toBe('boarding-lock-interp');
    expect(result.result.current.result?.station.id).toBe(yongmasan.id);
    expect(result.result.current.environment).toBe('surface');
    expect(result.result.current.surfaceSSOTActive).toBe(true);
  });

  it('실측 신호 없음(arrival 없음) → Tier 5 fallback 허용 (dead zone)', () => {
    // 진짜 dead zone: GPS만 있고 arrival 신호 없음 → surfaceSSOT 미합의.
    // lockless-route-hop이 적분 결과로 forward ratchet 가능.
    const result = setupLocklessTripAtYongmasan({
      gpsAccuracy: 14,
      arrivalAtYongmasan: null,
    });

    // 실측 신호 부재 → Tier 5 허용 → estimator override → boarding-lock-interp.
    expect(result.result.current.source).toBe('boarding-lock-interp');
    expect(result.result.current.surfaceSSOTActive).toBe(false);
  });

  it('GPS accuracy 너무 큼(>30m) → surfaceSSOT 미합의 → 실측 신호 부재 → Tier 5 허용', () => {
    // 지하 fallback 등으로 accuracy 50m → Tier 1 surface 미충족.
    const result = setupLocklessTripAtYongmasan({
      gpsAccuracy: 50,
      arrivalAtYongmasan: makeArrivalInfo({
        destination: '',
        arrivalSeconds: 0,
        line: '7',
        arrivalCode: 1,
      }),
    });

    expect(result.result.current.surfaceSSOTActive).toBe(false);
    // Tier 5 허용 → estimator override.
    expect(result.result.current.source).toBe('boarding-lock-interp');
  });
});
