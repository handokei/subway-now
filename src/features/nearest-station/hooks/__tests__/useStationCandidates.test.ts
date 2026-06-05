import { renderHook } from '@testing-library/react-native';
import { useStationCandidates } from '../useStationCandidates';
import type { Station } from '../../../../shared/types/station';

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
});
