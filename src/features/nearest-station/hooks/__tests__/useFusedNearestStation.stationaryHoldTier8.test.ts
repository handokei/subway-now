/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */
/**
 * #3191 PR-2 (2) - tier8(detection-verdict) 좋은 GPS 가드의 fix 나이 조건에 hold를 포함한다.
 *
 * D(2026-10-19 17:44~17:46, 뚝섬 사무실, trip 없음): GPS 최근접은 뚝섬(2호선) 161m, acc 3m인데
 * fix가 15초 이상 지나자 cascade가 서울숲(분당선) 471m로 넘어갔다. goodGpsOverridesTier8의
 * "fix age <= 30s" 때문에 정지한 사용자의 오래된 fix가 가드를 못 켰다.
 * 행 원문은 replay_20261021_sagajeong_hold.ts. 열차 신호는 합성(arvlCd 도착 + barometer stop).
 *
 * tier7(fused) 거리 게이트는 mock으로 끈다 - tier8 가드 자체를 격리(tier8GoodGpsGuard.test.ts와 같은 방식).
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
import { haversine } from '../../../../shared/utils/haversine';
import { arrivalRet, positionRet } from '../../../../testUtils/positionApiFixtures';
import { makeArrivalInfo } from '../../../../testUtils/fixtures';
import {
  appendBarometerReading,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../../../../shared/utils/barometerState';
import {
  D_19_OCT_TTUKSEOM_OFFICE,
  parseRawRow,
} from '../../../../testUtils/fixtures/replay_20261021_sagajeong_hold';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

const ttukseom = findStationByNameAndLine('뚝섬', '2')!;
const seoulForest = findStationByNameAndLine('서울숲', 'bundang')!;

const { header, rows } = D_19_OCT_TTUKSEOM_OFFICE;
// 17:46:25 - fix 17:44:49 (age 96s), acc 3m.
const row = parseRawRow(rows[2], header.kstDate);

function setup(opts: { baroLastAgoMs: number }) {
  jest.setSystemTime(row.nowMs);
  appendBarometerReading({ t: row.nowMs - 600_000, pressureHpa: row.hpa });
  appendBarometerReading({ t: row.nowMs - opts.baroLastAgoMs, pressureHpa: row.hpa });

  const live = { station: ttukseom, distanceKm: header.nearestDistanceM / 1000 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [ttukseom],
    userLocation: { lat: header.lat, lng: header.lng },
    speedMps: null,
    accuracyMeters: row.accuracyMeters,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    gpsActive: 'fg' as const,
    lastFixAtMs: row.fixAtMs,
    lastFixFromBg: false,
    isWatchActive: () => true,
    refresh: jest.fn(),
  });
  const forestKm = haversine(header.lat, header.lng, seoulForest.lat, seoulForest.lng);
  mockFindTop.mockReturnValue([live, { station: seoulForest, distanceKm: forestKm }]);
  mockArrival.mockImplementation((name: string | null, line: string | null) => {
    if (name === seoulForest.name && line === seoulForest.line) {
      return arrivalRet({
        up: [
          makeArrivalInfo({
            destination: '',
            arrivalSeconds: 0,
            line: seoulForest.line,
            arrivalCode: 1,
            trainCode: 'T-D',
            receivedAtMs: row.nowMs,
          }),
        ],
        down: [],
        isMock: false,
      });
    }
    return arrivalRet(null);
  });
  mockPos.mockReturnValue(positionRet(null));
  return renderHook(() =>
    useFusedNearestStation(undefined, undefined, undefined, undefined, undefined, undefined, {
      subsurface: false,
      signal: { subsurface: false, stop: true },
    }),
  );
}

describe('#3191 PR-2 (2) tier8 goodGpsOverridesTier8 - hold이면 fix 나이 무관', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetBarometerState();
    resetBarometerInstrumentationForTest();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('전제: 서울숲은 뚝섬 사무실에서 ~471m, 뚝섬 161m', () => {
    const forestM = Math.round(haversine(header.lat, header.lng, seoulForest.lat, seoulForest.lng) * 1000);
    expect(forestM).toBe(471);
    expect(header.nearestDistanceM).toBe(161);
  });

  it('D 17:46:25 - hold(fix 96s, acc 3, 기압계 관측 중)면 가드가 켜져 서울숲(분당선) detection-fused를 보류한다', () => {
    const hook = setup({ baroLastAgoMs: 1_000 });
    expect(hook.result.current.confidence).not.toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(ttukseom.id);
  });

  it('거부 - 기압 공백(마지막 reading 45초 전)이라 hold 불가면 현행 그대로 서울숲 채택', () => {
    const hook = setup({ baroLastAgoMs: 45_000 });
    expect(hook.result.current.confidence).toBe('detection-fused');
    expect(hook.result.current.result?.station.id).toBe(seoulForest.id);
  });
});
