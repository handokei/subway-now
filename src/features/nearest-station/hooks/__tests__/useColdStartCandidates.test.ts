import { renderHook } from '@testing-library/react-native';
import {
  useColdStartCandidates,
  extractColdStartCandidates,
  COLD_START_ACCURACY_THRESHOLD_M,
  COLD_START_RADIUS_KM,
} from '../useColdStartCandidates';

// ── 공통 픽스처 ───────────────────────────────────────────────────────────────

/**
 * 왕십리 기준점 — bundang 선 좌표 (stations.json 실재 값).
 * 500m 반경 내 entries: 왕십리(성동구청)/line 2, 왕십리(성동구청)/line 5,
 *   왕십리(성동구청)/gyeongui, 왕십리/bundang → 정규화 후 전부 '왕십리' (1개 그룹).
 */
const WANGSIMNI = { lat: 37.561827, lng: 127.038352 };

/**
 * 용마산 기준점 — 7호선 단독역. 500m 반경 내 다른 역 없음 (단일 후보).
 */
const YONGMASAN = { lat: 37.573647, lng: 127.086727 };

/**
 * 신촌(2호선) 기준점 — 500m 반경 내 신촌 + 서강대 2개 정규화 이름.
 */
const SINCHON_LINE2 = { lat: 37.555131, lng: 126.936926 };

/** cold start 진입 조건 충족하는 지하 환경 기본값. */
const UNDERGROUND_ENV = 'underground' as const;
const UNKNOWN_ENV = 'unknown' as const;

/** accuracy > 50m — cold start 게이트 통과. */
const LOW_ACCURACY = COLD_START_ACCURACY_THRESHOLD_M + 1;

// ── 1. cold start 감지 3 조건 AND ────────────────────────────────────────────

describe('cold start 감지 조건 (3개 AND)', () => {
  it('accuracy <= 50m 이면 null (cold start 아님)', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: COLD_START_ACCURACY_THRESHOLD_M },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).toBeNull();
  });

  it('accuracy = 1 (GPS 정확) 이면 null', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: 1 },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).toBeNull();
  });

  it('environment = surface 이면 null', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: LOW_ACCURACY },
        environment: 'surface',
        hasTrip: false,
      }),
    );
    expect(result.current).toBeNull();
  });

  it('environment = hybrid 이면 null', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: LOW_ACCURACY },
        environment: 'hybrid',
        hasTrip: false,
      }),
    );
    expect(result.current).toBeNull();
  });

  it('hasTrip = true 이면 null', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: LOW_ACCURACY },
        environment: UNDERGROUND_ENV,
        hasTrip: true,
      }),
    );
    expect(result.current).toBeNull();
  });

  it('gps = null 이면 null', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: null,
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).toBeNull();
  });

  it('3 조건 모두 충족 시 후보 배열 반환 (underground)', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: LOW_ACCURACY },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).not.toBeNull();
    expect(Array.isArray(result.current)).toBe(true);
  });

  it('3 조건 모두 충족 시 후보 배열 반환 (unknown)', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: LOW_ACCURACY },
        environment: UNKNOWN_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).not.toBeNull();
  });
});

// ── 2. 환승 호선 dedup ────────────────────────────────────────────────────────

describe('환승 호선 dedup (왕십리)', () => {
  it('왕십리 entries (2/5/gyeongui/bundang) → 1개 그룹으로 dedup', () => {
    const candidates = extractColdStartCandidates(WANGSIMNI.lat, WANGSIMNI.lng);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].stationName).toBe('왕십리');
  });

  it('왕십리 그룹에 4개 노선 포함 (2, 5, gyeongui, bundang)', () => {
    const candidates = extractColdStartCandidates(WANGSIMNI.lat, WANGSIMNI.lng);
    const { lines } = candidates[0];
    expect(lines).toContain('2');
    expect(lines).toContain('5');
    expect(lines).toContain('gyeongui');
    expect(lines).toContain('bundang');
    expect(lines).toHaveLength(4);
  });

  it('왕십리 그룹의 stations 배열에 4개 entry 포함', () => {
    const candidates = extractColdStartCandidates(WANGSIMNI.lat, WANGSIMNI.lng);
    expect(candidates[0].stations).toHaveLength(4);
  });

  it('왕십리 그룹 distanceKm은 0에 가까움 (기준점이 역 좌표)', () => {
    const candidates = extractColdStartCandidates(WANGSIMNI.lat, WANGSIMNI.lng);
    expect(candidates[0].distanceKm).toBeLessThan(0.01);
  });
});

// ── 3. 단일 역 (용마산) ────────────────────────────────────────────────────────

describe('단일 역 후보 (용마산)', () => {
  it('용마산 좌표에서 500m 반경 내 1개 후보 반환', () => {
    const candidates = extractColdStartCandidates(YONGMASAN.lat, YONGMASAN.lng);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].stationName).toBe('용마산');
  });

  it('용마산 그룹 lines에 7호선 포함', () => {
    const candidates = extractColdStartCandidates(YONGMASAN.lat, YONGMASAN.lng);
    expect(candidates[0].lines).toContain('7');
  });
});

// ── 4. 복수 역 (신촌 — 신촌 + 서강대) ────────────────────────────────────────

describe('복수 역 후보 (신촌 인근 2개 정규화 이름)', () => {
  it('신촌(2호선) 좌표에서 500m 반경 내 2개 unique name 반환', () => {
    const candidates = extractColdStartCandidates(SINCHON_LINE2.lat, SINCHON_LINE2.lng);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    const names = candidates.map((c) => c.stationName);
    expect(names).toContain('신촌');
  });

  it('후보는 거리순 정렬 — 신촌이 1순위', () => {
    const candidates = extractColdStartCandidates(SINCHON_LINE2.lat, SINCHON_LINE2.lng);
    expect(candidates[0].stationName).toBe('신촌');
  });

  it('신촌 그룹 distanceKm < 서강대 그룹 distanceKm', () => {
    const candidates = extractColdStartCandidates(SINCHON_LINE2.lat, SINCHON_LINE2.lng);
    const sinchon = candidates.find((c) => c.stationName === '신촌');
    const seogangdae = candidates.find((c) => c.stationName.includes('서강'));
    expect(sinchon).toBeDefined();
    expect(seogangdae).toBeDefined();
    expect(sinchon!.distanceKm).toBeLessThan(seogangdae!.distanceKm);
  });
});

// ── 5. 정확도별 gate (useColdStartCandidates 훅) ────────────────────────────

describe('accuracy gate — useColdStartCandidates 훅', () => {
  it('accuracy = 51m (> 50m) → 후보 반환', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: 51 },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).not.toBeNull();
    expect(result.current!.length).toBeGreaterThan(0);
  });

  it('accuracy = 200m → 후보 반환 (지하 저정확도 대표값)', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: 200 },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).not.toBeNull();
  });

  it('accuracy = 1000m → 후보 반환 (최악 정확도)', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: 1000 },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).not.toBeNull();
  });

  it('accuracy = 50m (경계) → null', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { ...YONGMASAN, accuracy: 50 },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    expect(result.current).toBeNull();
  });
});

// ── 6. 반경 밖 위치 ─────────────────────────────────────────────────────────

describe('반경 외 위치', () => {
  it('한반도 외 좌표에서 0개 후보 → 빈 배열', () => {
    const candidates = extractColdStartCandidates(0, 0);
    expect(candidates).toHaveLength(0);
  });

  it('useColdStartCandidates: 역 없는 위치에서 빈 배열 반환 (null 아님)', () => {
    const { result } = renderHook(() =>
      useColdStartCandidates({
        gps: { lat: 0, lng: 0, accuracy: LOW_ACCURACY },
        environment: UNDERGROUND_ENV,
        hasTrip: false,
      }),
    );
    // cold start 조건 충족 + 반경 내 역 없음 → 빈 배열
    expect(result.current).toEqual([]);
  });
});

// ── 7. 상수 export 검증 ──────────────────────────────────────────────────────

describe('exported constants', () => {
  it('COLD_START_ACCURACY_THRESHOLD_M = 50', () => {
    expect(COLD_START_ACCURACY_THRESHOLD_M).toBe(50);
  });

  it('COLD_START_RADIUS_KM = 0.5', () => {
    expect(COLD_START_RADIUS_KM).toBe(0.5);
  });
});
