import { renderHook } from '@testing-library/react-native';
import { useStationCandidates } from '../useStationCandidates';
import type { Station } from '../../../../shared/types/station';
import { DEPTH_TO_PRESSURE_HPA_PER_M } from '../../../../shared/constants/barometer';

const YONGMASAN: Station = {
  id: '7-015',
  name: '용마산',
  line: '7',
  lineColor: '#747F00',
  lat: 37.573647,
  lng: 127.086727,
};

// 용마산 좌표 — stations.json에 실재. findTopNearestStations가 거리 1순위로 반환.
const YONGMASAN_LOC = { lat: 37.573647, lng: 127.086727 };

// 한반도 밖 — 1km 반경에 어떤 역도 없음.
const FAR_OFFSHORE = { lat: 0, lng: 0 };

describe('useStationCandidates', () => {
  it('userLocation/wifiStation 모두 없으면 빈 결과', () => {
    const { result } = renderHook(() =>
      useStationCandidates({ userLocation: null, wifiStation: null }),
    );
    expect(result.current.candidates).toEqual([]);
    expect(result.current.topPick).toBeNull();
    expect(result.current.isAutoConfirmed).toBe(false);
  });

  it('wifi 매칭만 있으면 그 역 단일 후보 + 자동 확정', () => {
    const { result } = renderHook(() =>
      useStationCandidates({ userLocation: null, wifiStation: YONGMASAN }),
    );
    expect(result.current.candidates).toEqual([YONGMASAN]);
    expect(result.current.topPick).toBe(YONGMASAN);
    expect(result.current.isAutoConfirmed).toBe(true);
  });

  it('wifi 매칭이 있으면 GPS보다 우선한다', () => {
    // GPS는 용마산이지만 wifi는 임의의 다른 역(목업)을 가리킨다.
    const fakeWifi: Station = { ...YONGMASAN, id: 'fake', name: '가상역' };
    const { result } = renderHook(() =>
      useStationCandidates({ userLocation: YONGMASAN_LOC, wifiStation: fakeWifi }),
    );
    expect(result.current.candidates).toEqual([fakeWifi]);
    expect(result.current.topPick).toBe(fakeWifi);
    expect(result.current.isAutoConfirmed).toBe(true);
  });

  it('GPS 좌표가 역에 가까우면 거리순 후보를 반환하고 1순위가 topPick', () => {
    const { result } = renderHook(() =>
      useStationCandidates({ userLocation: YONGMASAN_LOC, wifiStation: null }),
    );
    expect(result.current.candidates.length).toBeGreaterThan(0);
    expect(result.current.topPick).not.toBeNull();
    expect(result.current.topPick?.name).toBe('용마산');
    // 환승역이 아니므로 후보가 단일이거나 인근 역이 함께. 다음 분기는 후보 수에 의존 안 함.
  });

  it('maxCandidates를 기본 3으로 제한한다', () => {
    const { result } = renderHook(() =>
      useStationCandidates({ userLocation: YONGMASAN_LOC, wifiStation: null }),
    );
    expect(result.current.candidates.length).toBeLessThanOrEqual(3);
  });

  it('maxCandidates 명시 시 그 값으로 제한된다', () => {
    const { result } = renderHook(() =>
      useStationCandidates({
        userLocation: YONGMASAN_LOC,
        wifiStation: null,
        maxCandidates: 2,
      }),
    );
    expect(result.current.candidates.length).toBeLessThanOrEqual(2);
  });

  it('maxCandidates가 0이면 빈 결과 (정의 가드)', () => {
    const { result } = renderHook(() =>
      useStationCandidates({
        userLocation: YONGMASAN_LOC,
        wifiStation: null,
        maxCandidates: 0,
      }),
    );
    expect(result.current.candidates).toEqual([]);
    expect(result.current.topPick).toBeNull();
    expect(result.current.isAutoConfirmed).toBe(false);
  });

  it('maxDistanceKm 반경 밖이면 빈 결과', () => {
    const { result } = renderHook(() =>
      useStationCandidates({
        userLocation: FAR_OFFSHORE,
        wifiStation: null,
      }),
    );
    expect(result.current.candidates).toEqual([]);
    expect(result.current.topPick).toBeNull();
    expect(result.current.isAutoConfirmed).toBe(false);
  });

  it('maxDistanceKm를 매우 작게 주면 좌표가 정확해도 빈 결과', () => {
    const { result } = renderHook(() =>
      useStationCandidates({
        userLocation: { lat: 37.573647 + 0.01, lng: 127.086727 + 0.01 },
        wifiStation: null,
        maxDistanceKm: 0.05,
      }),
    );
    expect(result.current.candidates).toEqual([]);
  });

  it('후보가 정확히 1개면 isAutoConfirmed=true (GPS 경로)', () => {
    // 매우 좁은 반경 → 단일 역만 들어오게.
    const { result } = renderHook(() =>
      useStationCandidates({
        userLocation: YONGMASAN_LOC,
        wifiStation: null,
        maxDistanceKm: 0.05,
      }),
    );
    expect(result.current.candidates.length).toBe(1);
    expect(result.current.isAutoConfirmed).toBe(true);
  });

  it('같은 입력으로 rerender 시 참조 안정성 (useMemo)', () => {
    const props = { userLocation: YONGMASAN_LOC, wifiStation: null };
    const { result, rerender } = renderHook(
      (p: { userLocation: typeof YONGMASAN_LOC; wifiStation: Station | null }) =>
        useStationCandidates(p),
      { initialProps: props },
    );
    const first = result.current;
    rerender(props);
    expect(result.current).toBe(first);
  });

  describe('F3 기압계 절대값 narrow (#920)', () => {
    // 잠실: GPS top-N(이름 dedup) → [잠실, 잠실나루] 같은 deduped 후보 목록.
    // 잠실 line 2 depth_m=16. 잠실나루는 압력 데이터 없음(narrow 시 자동 탈락).
    const JAMSIL_LOC = { lat: 37.513262, lng: 127.100159 };
    const SURFACE = 1013;
    const PRESSURE_AT_16M = SURFACE + 16 * DEPTH_TO_PRESSURE_HPA_PER_M;
    const PRESSURE_FAR_OFF = 950; // 어떤 entry도 매칭 안 됨.

    it('absolutePressure 없으면 GPS 후보 그대로 (narrow skip)', () => {
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: JAMSIL_LOC,
          wifiStation: null,
          absolutePressureHpa: null,
          surfacePressureHpa: SURFACE,
        }),
      );
      const names = result.current.candidates.map((s) => s.name);
      expect(names).toContain('잠실');
      expect(names).toContain('잠실나루');
    });

    it('surfacePressure 없으면 narrow skip → GPS 후보 그대로', () => {
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: JAMSIL_LOC,
          wifiStation: null,
          absolutePressureHpa: PRESSURE_AT_16M,
          surfacePressureHpa: null,
        }),
      );
      const names = result.current.candidates.map((s) => s.name);
      expect(names).toContain('잠실');
      expect(names).toContain('잠실나루');
    });

    it('압력값 모두 주면 narrow 적용 → 데이터 있는 역만 살아남음', () => {
      // 잠실(line2 depth 16m)은 매칭, 잠실나루(데이터 없음)는 탈락.
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: JAMSIL_LOC,
          wifiStation: null,
          absolutePressureHpa: PRESSURE_AT_16M,
          surfacePressureHpa: SURFACE,
        }),
      );
      const names = result.current.candidates.map((s) => s.name);
      expect(names).toContain('잠실');
      expect(names).not.toContain('잠실나루');
    });

    it('narrow 결과 0개면 GPS 후보로 fallback (안전망)', () => {
      // 950 hPa는 어떤 entry도 매칭 안 됨 → GPS 후보 그대로 유지.
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: JAMSIL_LOC,
          wifiStation: null,
          absolutePressureHpa: PRESSURE_FAR_OFF,
          surfacePressureHpa: SURFACE,
        }),
      );
      const names = result.current.candidates.map((s) => s.name);
      expect(names).toContain('잠실');
    });

    it('narrow 후 단일 후보 → isAutoConfirmed=true', () => {
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: JAMSIL_LOC,
          wifiStation: null,
          absolutePressureHpa: PRESSURE_AT_16M,
          surfacePressureHpa: SURFACE,
        }),
      );
      // narrow 후보가 1개로 좁혀지면 자동 확정 신호.
      if (result.current.candidates.length === 1) {
        expect(result.current.isAutoConfirmed).toBe(true);
      }
      expect(result.current.topPick?.name).toBe('잠실');
    });

    it('wifi가 있으면 F3 입력이 와도 wifi 우선', () => {
      const fakeWifi: Station = { ...YONGMASAN, id: 'wifi-pick', name: 'WifiPick' };
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: JAMSIL_LOC,
          wifiStation: fakeWifi,
          absolutePressureHpa: PRESSURE_AT_16M,
          surfacePressureHpa: SURFACE,
        }),
      );
      expect(result.current.topPick).toBe(fakeWifi);
      expect(result.current.candidates).toEqual([fakeWifi]);
    });
  });

  describe('F3 추가 narrow — depth+ETA 결합 (#920 후속)', () => {
    // 광화문(37.5715, 126.9769)과 종로3가(37.5717, 126.9919) 중간 좌표 — 두 역 모두 1km 반경 안.
    // 둘 다 stationAbsolutePressure.json에 depth 등록(광화문 32m, 종로3가 35m). 5호선 인접.
    const MIDPOINT_LOC = { lat: 37.5716, lng: 126.9844 };
    const SEODAEMUN_5: Station = {
      id: '5-023',
      name: '서대문',
      line: '5',
      lineColor: '#996CAC',
      lat: 37.5657,
      lng: 126.9666,
    };
    const SURFACE = 1013;

    it('baseline 후보 ≥2 + previousStation 인접 → 추가 narrow로 단일 후보', () => {
      // 측정 1016.84 hPa(=32m). baseline은 광화문(0) + 종로3가(0.36) 둘 다 매칭 통과.
      // previousStation=서대문(5-023). 서대문↔광화문 hop 90s 존재, 서대문↔종로3가 hop 없음.
      // → 평가 가능한 후보 1개(광화문) → 광화문 단일 반환.
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: MIDPOINT_LOC,
          wifiStation: null,
          maxCandidates: 5,
          maxDistanceKm: 2,
          absolutePressureHpa: SURFACE + 32 * DEPTH_TO_PRESSURE_HPA_PER_M,
          surfacePressureHpa: SURFACE,
          previousStation: SEODAEMUN_5,
          secondsSincePrevious: 90,
        }),
      );
      expect(result.current.candidates.length).toBe(1);
      expect(result.current.topPick?.name).toBe('광화문');
      expect(result.current.isAutoConfirmed).toBe(true);
    });

    it('previousStation 없으면 추가 narrow skip → baseline 후보 유지', () => {
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: MIDPOINT_LOC,
          wifiStation: null,
          maxCandidates: 5,
          maxDistanceKm: 2,
          absolutePressureHpa: SURFACE + 32 * DEPTH_TO_PRESSURE_HPA_PER_M,
          surfacePressureHpa: SURFACE,
        }),
      );
      const names = result.current.candidates.map((s) => s.name);
      expect(names).toContain('광화문');
      expect(names).toContain('종로3가');
    });

    it('secondsSincePrevious 없으면 추가 narrow skip', () => {
      const { result } = renderHook(() =>
        useStationCandidates({
          userLocation: MIDPOINT_LOC,
          wifiStation: null,
          maxCandidates: 5,
          maxDistanceKm: 2,
          absolutePressureHpa: SURFACE + 32 * DEPTH_TO_PRESSURE_HPA_PER_M,
          surfacePressureHpa: SURFACE,
          previousStation: SEODAEMUN_5,
          secondsSincePrevious: null,
        }),
      );
      const names = result.current.candidates.map((s) => s.name);
      expect(names).toContain('광화문');
      expect(names).toContain('종로3가');
    });

    describe('wave 2(#989) — motion + barometer 신호 wire-up', () => {
      // 본 hook은 wave 2 신호를 narrowStationsByDepthAndEta로 그대로 전달한다.
      // 결정 로직의 GAP/TOO_WEAK 완화는 barometerState 단위 테스트에서 검증.
      // 여기서는 입력 옵션이 결과를 깨지 않는지(회귀)와 memoization이 깨지지 않는지만 확인.
      const BASE_INPUT = {
        userLocation: MIDPOINT_LOC,
        wifiStation: null,
        maxCandidates: 5,
        maxDistanceKm: 2,
        absolutePressureHpa: SURFACE + 32 * DEPTH_TO_PRESSURE_HPA_PER_M,
        surfacePressureHpa: SURFACE,
        previousStation: SEODAEMUN_5,
        secondsSincePrevious: 90,
      };

      it('두 신호 모두 true → 결과는 narrow 함수 결정 (회귀 없음)', () => {
        const { result } = renderHook(() =>
          useStationCandidates({
            ...BASE_INPUT,
            motionStationary: true,
            barometerStable: true,
          }),
        );
        expect(result.current.topPick?.name).toBe('광화문');
        expect(result.current.isAutoConfirmed).toBe(true);
      });

      it('두 신호 미제공 → 결과는 narrow 함수 결정 (회귀 없음)', () => {
        const { result } = renderHook(() => useStationCandidates(BASE_INPUT));
        expect(result.current.topPick?.name).toBe('광화문');
      });

      it('motion만 true → narrow 함수로 전달되고 결과 일관성 유지', () => {
        const { result } = renderHook(() =>
          useStationCandidates({ ...BASE_INPUT, motionStationary: true }),
        );
        expect(result.current.topPick?.name).toBe('광화문');
      });

      it('동일 입력 rerender 시 참조 안정성 (signals deps 포함)', () => {
        const props = {
          ...BASE_INPUT,
          motionStationary: true,
          barometerStable: true,
        };
        const { result, rerender } = renderHook(
          (p: typeof props) => useStationCandidates(p),
          { initialProps: props },
        );
        const first = result.current;
        rerender(props);
        expect(result.current).toBe(first);
      });
    });
  });
});
