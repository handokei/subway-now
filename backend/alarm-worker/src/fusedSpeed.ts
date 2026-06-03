/**
 * Phase 1 fused speed 계산 (#819 게이트 #7).
 *
 * GPS 좌표 series 평균속도 + Motion sanity + (Phase 2부터) map-matched speed의
 * 가중 평균. iOS client.speed가 `-1`/빈 값으로 자주 떨어지는 회귀(#812 cold start) 때문에
 * raw client.speed를 신뢰하지 않고 좌표 series로 직접 산출한다.
 *
 * ADR: https://app.notion.com/p/37430c0194b6819c8323e37d4c31a777 Section 5.
 */

export type Motion = 'stationary' | 'walking' | 'automotive' | 'unknown';

export interface FusedSpeedInputs {
  /** 좌표 series 60s 평균 km/h. */
  gpsAvgKmh: number;
  /** 평균 계산에 사용된 윈도우의 평균 accuracy meters — 가중치 단계 결정용. */
  gpsAccuracyMeters: number;
  /** CMMotionActivity 분류 결과 — 'stationary'는 즉시 0 km/h로 강등. */
  motion: Motion;
  /** Phase 2 map matching 결과. 미사용 단계는 null — 가중치 0으로 자연 무시. */
  mapMatchedKmh: number | null;
}

export interface FusedSpeed {
  /** km/h. motion clamp 적용 후 값. */
  speed: number;
  /** 가중치 합 기반 신뢰도. 'low'면 게이트 #7 차단 (보수). */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * 좌표 series 60s 평균 + motion clamp + (Phase 2부터) map matching weighted fusion.
 *
 * - motion=stationary면 다른 신호 무시하고 0 km/h 강등 (false positive 1차 차단).
 * - GPS 가중치는 accuracy 단계 함수 — < 20m: 0.7, < 50m: 0.5, < 100m: 0.2, 그 외: 0.
 *   (50m 컷오프 자체는 호출자가 게이트 #3에서 series 필터로 처리. 여기서는 평균
 *   accuracy 기반 신뢰도 조정만.)
 * - mapMatchedKmh가 있으면 0.5 추가 — Phase 2까지는 null로 호출되므로 GPS only.
 * - clamp: walking은 10 km/h 상한, automotive는 5 km/h 하한 — sensor 불일치를 완화.
 */
export function fusedSpeed(opts: FusedSpeedInputs): FusedSpeed {
  if (opts.motion === 'stationary') return { speed: 0, confidence: 'high' };

  const gpsWeight =
    opts.gpsAccuracyMeters < 20
      ? 0.7
      : opts.gpsAccuracyMeters < 50
        ? 0.5
        : opts.gpsAccuracyMeters < 100
          ? 0.2
          : 0;
  const mapWeight = opts.mapMatchedKmh != null ? 0.5 : 0;
  const totalW = gpsWeight + mapWeight;
  if (totalW === 0) return { speed: 0, confidence: 'low' };

  const raw =
    (opts.gpsAvgKmh * gpsWeight + (opts.mapMatchedKmh ?? 0) * mapWeight) / totalW;
  const speed =
    opts.motion === 'walking'
      ? Math.min(raw, 10)
      : opts.motion === 'automotive'
        ? Math.max(raw, 5)
        : raw;
  const confidence: FusedSpeed['confidence'] =
    totalW >= 1.0 ? 'high' : totalW >= 0.5 ? 'medium' : 'low';
  return { speed, confidence };
}
