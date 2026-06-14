/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #1286 — WiFi SSID fusion cascade 격리 검증.
 *
 * - barometerSubsurface=true + wifiStation 있음 → result = wifiStation (최우선)
 * - barometerSubsurface=false(지상) → wifi 무시 → 기존 cascade(GPS fallback)
 * - wifiStation=null → wifi 무시 → 기존 cascade
 * - 환승역: boardingLock.boardingLine으로 호선 보정
 * - 디버그: wifiSsid candidate가 entries에 기록
 */
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation');
jest.mock('../../../route/utils/findActiveLines');
jest.mock('../../utils/fusionDistanceGate', () => ({
  passesFusionDistanceGate: () => true,
  isWithinArcWindow: () => true,
}));
jest.mock('../../../route/utils/trackTrainProgress', () => ({
  trackTrainProgress: jest.fn(() => null),
}));
jest.mock('../../../arrival/utils/pickCandidateTrains', () => ({
  pickCandidateTrains: jest.fn(() => []),
}));
jest.mock('../../../route/utils/stationProgressEstimator', () => ({
  arcIndexOfStation: () => -1,
  estimateStationProgress: () => null,
}));
jest.mock('../../../route/utils/routeProgress', () => ({
  computeRouteArc: () => null,
}));
// stationLookup: 기본적으로 null 반환하는 jest.fn()으로 mock.
// 환승역 보정 테스트에서 mockReturnValue로 제어.
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByName: jest.fn(() => null),
  findStationByNameAndLine: jest.fn(() => null),
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findActiveLines } from '../../../route/utils/findActiveLines';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';
import type { Station } from '../../../../shared/types/station';

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockFindLines = findActiveLines as jest.Mock;

// 테스트에서 사용하는 WiFi 매칭 결과 역
const yongmasan: Station = {
  id: '7-018',
  name: '용마산',
  line: '7',
  lineColor: '#747F00',
  lat: 37.58,
  lng: 127.08,
};
// 환승역 — 충무로(3호선). 4호선에도 존재.
const chungmuro3: Station = MOCK_STATIONS.chungmuro; // line='3'

function gpsBase(overrides?: Record<string, unknown>) {
  return {
    result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
    variants: [MOCK_STATIONS.gangnam],
    userLocation: { lat: 37.5, lng: 127.0 },
    speedMps: 1,
    accuracyMeters: 50,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    refresh: jest.fn(),
    ...overrides,
  };
}

describe('useFusedNearestStation — #1286 WiFi SSID fusion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseNearest.mockReturnValue(gpsBase());
    mockFindTop.mockReturnValue([{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
    mockFindLines.mockReturnValue(['2']);
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
  });

  describe('지하 GPS dead zone — SSID 매칭 성공', () => {
    it('subsurface=true + wifiStation 있음 → wifi-ssid confidence로 해당 역 채택', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: true },
          yongmasan,
        ),
      );
      expect(result.current.confidence).toBe('wifi-ssid');
      expect(result.current.source).toBe('wifi-ssid');
      expect(result.current.result?.station.id).toBe(yongmasan.id);
      expect(result.current.result?.station.name).toBe(yongmasan.name);
    });

    it('subsurface=true + wifiStation → source=wifi-ssid (GPS gpsResult는 유지)', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: true },
          yongmasan,
        ),
      );
      // gpsResult는 GPS 원본 그대로
      expect(result.current.gpsResult?.station.id).toBe(MOCK_STATIONS.gangnam.id);
      expect(result.current.source).toBe('wifi-ssid');
    });

    it('GPS userLocation=null(완전 dead)이어도 wifi-ssid 채택 — distanceKm=0', () => {
      // 지하 GPS 완전 실패(좌표 자체 없음). wifi가 잡히면 거리 산정 없이 wifi 역 채택.
      mockUseNearest.mockReturnValue(gpsBase({ userLocation: null, result: null }));
      mockFindTop.mockReturnValue([]);

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: true },
          yongmasan,
        ),
      );
      expect(result.current.confidence).toBe('wifi-ssid');
      expect(result.current.result?.station.id).toBe(yongmasan.id);
      expect(result.current.result?.distanceKm).toBe(0);
    });
  });

  describe('지상(subsurface=false) — WiFi 무시, 기존 cascade', () => {
    it('subsurface=false + wifiStation 있어도 GPS fallback(gps-only)', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: false },
          yongmasan,
        ),
      );
      expect(result.current.confidence).toBe('gps-only');
      expect(result.current.result?.station.id).toBe(MOCK_STATIONS.gangnam.id);
    });

    it('subsurface 미전달(undefined) + wifiStation 있어도 GPS fallback', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          yongmasan,
        ),
      );
      expect(result.current.confidence).toBe('gps-only');
    });
  });

  describe('SSID 미매칭(wifiStation=null) — 기존 cascade', () => {
    it('subsurface=true + wifiStation=null → gps-only-underground (wifi 무시)', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: true },
          null,
        ),
      );
      // wifi null → #903 가드만 적용 → gps-only-underground
      expect(result.current.confidence).toBe('gps-only-underground');
    });

    it('wifiStation 파라미터 자체 미전달 → gps-only', () => {
      const { result } = renderHook(() => useFusedNearestStation());
      expect(result.current.confidence).toBe('gps-only');
    });
  });

  describe('환승역 호선 보정 — boardingLock.boardingLine', () => {
    const mockFindByNameAndLine = findStationByNameAndLine as jest.Mock;

    beforeEach(() => {
      mockFindByNameAndLine.mockReturnValue(null);
    });

    it('wifiStation.line이 boardingLock.boardingLine과 다르면 findStationByNameAndLine으로 보정', () => {
      // wifiSsidLookup은 충무로를 3호선으로 반환하지만, 사용자가 4호선으로 탑승 중인 상황.
      const chungmuro4: Station = {
        ...chungmuro3,
        id: '0401',
        line: '4',
        lineColor: '#00A2D1',
      };
      mockFindByNameAndLine.mockReturnValue(chungmuro4);

      const boardingLock = {
        trainCode: 'T-LOCK',
        boardingLine: '4',
        boardingStationId: '0401',
        boardedAt: 1000,
      };

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          boardingLock as unknown as import('../../../../shared/types/boardingLock').BoardingLock,
          undefined,
          { subsurface: true },
          chungmuro3,
        ),
      );

      expect(mockFindByNameAndLine).toHaveBeenCalledWith('충무로', '4');
      expect(result.current.confidence).toBe('wifi-ssid');
      expect(result.current.result?.station.line).toBe('4');
    });

    it('boardingLock이 없으면 wifiStation.line 그대로 채택', () => {
      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: true },
          yongmasan,
        ),
      );

      expect(mockFindByNameAndLine).not.toHaveBeenCalled();
      expect(result.current.result?.station.line).toBe(yongmasan.line);
    });

    it('boardingLock.boardingLine === wifiStation.line이면 findStationByNameAndLine 미호출', () => {
      const boardingLock = {
        trainCode: 'T-LOCK',
        boardingLine: '7',
        boardingStationId: yongmasan.id,
        boardedAt: 1000,
      };

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          boardingLock as unknown as import('../../../../shared/types/boardingLock').BoardingLock,
          undefined,
          { subsurface: true },
          yongmasan,
        ),
      );

      expect(mockFindByNameAndLine).not.toHaveBeenCalled();
      expect(result.current.result?.station.line).toBe('7');
    });

    it('findStationByNameAndLine이 null(매핑 실패)이면 wifiStation 원본 채택', () => {
      // mockFindByNameAndLine.mockReturnValue(null) — beforeEach 기본값

      const boardingLock = {
        trainCode: 'T-LOCK',
        boardingLine: '99',
        boardingStationId: 'x99',
        boardedAt: 1000,
      };

      const { result } = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          boardingLock as unknown as import('../../../../shared/types/boardingLock').BoardingLock,
          undefined,
          { subsurface: true },
          yongmasan,
        ),
      );

      expect(result.current.confidence).toBe('wifi-ssid');
      // 매핑 실패 → wifiStation 원본(line='7')
      expect(result.current.result?.station.line).toBe('7');
    });
  });

  describe('디버그 buffer — wifiSsid candidate 기록', () => {
    it('wifi-ssid 채택 시 wifiSsid candidate가 fusion debug entry에 포함', () => {
      const {
        clearFusionDebugEntries,
        getFusionDebugEntries,
      } = jest.requireActual(
        '../../utils/fusionDebugBuffer',
      ) as typeof import('../../utils/fusionDebugBuffer');
      clearFusionDebugEntries();

      renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: true },
          yongmasan,
        ),
      );

      const entries = getFusionDebugEntries();
      const last = entries[entries.length - 1];
      expect(last.kind).toBe('fusion');
      if (last.kind !== 'fusion') throw new Error('expected fusion entry');
      const wifiCandidate = last.candidates.find((c) => c.key === 'wifiSsid');
      expect(wifiCandidate).toBeDefined();
      expect(wifiCandidate?.stationName).toBe(yongmasan.name);
      expect(wifiCandidate?.line).toBe(yongmasan.line);
    });

    it('wifi 미채택(subsurface=false) 시 wifiSsid candidate 없음', () => {
      const {
        clearFusionDebugEntries,
        getFusionDebugEntries,
      } = jest.requireActual(
        '../../utils/fusionDebugBuffer',
      ) as typeof import('../../utils/fusionDebugBuffer');
      clearFusionDebugEntries();

      renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { subsurface: false },
          yongmasan,
        ),
      );

      const entries = getFusionDebugEntries();
      const last = entries[entries.length - 1];
      if (last?.kind !== 'fusion') return; // entry가 없거나 다른 종류
      const wifiCandidate = last.candidates.find((c) => c.key === 'wifiSsid');
      expect(wifiCandidate).toBeUndefined();
    });
  });
});
