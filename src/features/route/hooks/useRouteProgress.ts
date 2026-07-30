import { useEffect, useMemo, useRef, useState } from 'react';
import {
  computeRouteArc,
  currentHopDistanceM,
  nearestArcPoint,
  stationAtProgress,
  type RouteArc,
  type RoutePositionInfo,
} from '../utils/routeProgress';
import type { Route } from '../../../shared/utils/stationRoute';
import type { Station } from '../../../shared/types/station';
import {
  MAX_PERP_M,
  MAX_PLAUSIBLE_MPS,
  ACCURACY_WEIGHT_SCALE_M,
  DEFAULT_ACCURACY_WEIGHT,
  ARC_OVERSHOOT_HOP_MULTIPLIER,
  ROUTE_PROGRESS_RESEED_STALE_MS,
  ROUTE_PROGRESS_RESEED_ACCURACY_M,
} from '../../../shared/constants/routeProgress';

/**
 * GPS 관측의 progress 갱신 가중치. 정확도가 좋을수록 GPS를 더 신뢰한다.
 * acc=100m → w≈0.9, acc=300m → w≈0.5, acc=1000m → w≈0.08.
 * accuracy null이면 expo-location이 값 못 준 경우라 보수적으로 DEFAULT_ACCURACY_WEIGHT.
 */
export function accuracyToWeight(accuracyMeters: number | null): number {
  if (accuracyMeters == null) return DEFAULT_ACCURACY_WEIGHT;
  const k = accuracyMeters / ACCURACY_WEIGHT_SCALE_M;
  return 1 / (1 + k * k);
}

interface ProgressState {
  /** dead-reckoning 포함 현재 진행도(m). 표시·position 계산에 사용. */
  progressM: number;
  /** 마지막 dead-reckoning tick 시각. progressM 진행 계산용. */
  lastTickMs: number;
  /** 마지막으로 채택된(blend된) progress(m). 점프 거부 baseline. */
  lastTrustedProgressM: number;
  /** 마지막 채택 관측 시각. 점프 거부 baseline. */
  lastTrustedTickMs: number;
  /** dead-reckoning에 쓸 직전 속도(m/s). */
  speedMps: number;
  initialized: boolean;
}

export interface UseRouteProgressInputs {
  route: Route;
  origin: Station | null;
  destination: Station | null;
  userLocation: { lat: number; lng: number } | null;
  speedMps: number | null;
  accuracyMeters: number | null;
}

export interface UseRouteProgressReturn {
  /** 경로 호출 가능한 arc 테이블. route/origin/destination 누락 또는 유효성 실패 시 null. */
  arc: RouteArc | null;
  /** 경로 위 진행도(m). 첫 GPS 관측 전엔 null. */
  progressM: number | null;
  /** progressM이 가리키는 현재/다음/이전 역 정보. null = 정보 없음. */
  position: RoutePositionInfo | null;
}

/**
 * 경로가 설정된 동안 사용자 상태를 1D 진행도로 추적한다.
 * - 모션 모델: 직전 속도 × 경과 시간으로 progress 자동 증가(GPS tick 사이 보간).
 * - 관측 모델: GPS 좌표를 경로에 사영해 progress 보정. accuracy 가중치로 dead-reckoning과 blend.
 * - 점프 거부: implied speed가 200 km/h 초과면 그 관측은 무시(GPS 튐 방지).
 *   baseline은 마지막 채택 관측 — 연속 점프도 끝까지 거부한다.
 * - 경로 이탈: 경로에서 1.5km 이상 벗어난 좌표는 progress 보정에 쓰지 않음.
 * - 초기화: 첫 관측이 경로 안(perp ≤ 1.5km)이면 사영점에 snap. 밖이면 origin(arc=0)에서 시작.
 */
export function useRouteProgress({
  route,
  origin,
  destination,
  userLocation,
  speedMps,
  accuracyMeters,
}: UseRouteProgressInputs): UseRouteProgressReturn {
  const arc = useMemo(() => {
    if (!route || !origin || !destination) return null;
    return computeRouteArc(route, origin, destination);
  }, [route, origin, destination]);

  const [progressM, setProgressM] = useState<number | null>(null);
  const stateRef = useRef<ProgressState>({
    progressM: 0,
    lastTickMs: 0,
    lastTrustedProgressM: 0,
    lastTrustedTickMs: 0,
    speedMps: 0,
    initialized: false,
  });

  // arc 변경(경로 재설정) 시 상태 초기화. 다음 GPS 관측에서 첫 사영점 또는 origin으로 snap.
  useEffect(() => {
    stateRef.current = {
      progressM: 0,
      lastTickMs: 0,
      lastTrustedProgressM: 0,
      lastTrustedTickMs: 0,
      speedMps: 0,
      initialized: false,
    };
    setProgressM(null);
  }, [arc]);

  useEffect(() => {
    if (!arc || !userLocation) return;
    const proj = nearestArcPoint(arc, userLocation.lat, userLocation.lng);
    const now = Date.now();
    const current = stateRef.current;
    const nextSpeed = speedMps != null && speedMps >= 0 ? speedMps : current.speedMps;

    // 초기화: 첫 관측이 경로 안(perp ≤ MAX_PERP_M)이면 사영점에 snap.
    // 밖이면 origin(arc=0)에서 시작 — 첫 관측 outlier로 진행도가 잘못 고정되는 사고 방지.
    if (!current.initialized) {
      const seedArcM = proj.perpDistanceM <= MAX_PERP_M ? proj.arcM : 0;
      stateRef.current = {
        progressM: seedArcM,
        lastTickMs: now,
        lastTrustedProgressM: seedArcM,
        lastTrustedTickMs: now,
        speedMps: nextSpeed,
        initialized: true,
      };
      setProgressM(seedArcM);
      return;
    }

    // #2093 (item D) — 장기 무신호(마지막 신뢰 관측 이후 ROUTE_PROGRESS_RESEED_STALE_MS 이상 경과) 후
    // 재기동 시, 정확도가 좋고(< ROUTE_PROGRESS_RESEED_ACCURACY_M) 경로 위에서 합의(perp ≤ MAX_PERP_M)되는
    // fix라면 dead-reckoning/jump-reject 판정을 우회하고 그 지점으로 즉시 re-seed한다. lock_position_tier
    // 8분 stuck류 회귀(원점=탑승역에 고착돼 표시가 플래핑)를 GPS 합의 지점 재앵커로 해소.
    // 저품질(지하) 좌표로는 re-seed하지 않는다 — accuracyMeters 게이트가 GPS 결정 권한을 지상 고품질
    // fix로만 제한(feedback_no_gps_for_decision).
    const staleMs = now - current.lastTrustedTickMs;
    const reseedEligible =
      staleMs > ROUTE_PROGRESS_RESEED_STALE_MS &&
      accuracyMeters != null &&
      accuracyMeters < ROUTE_PROGRESS_RESEED_ACCURACY_M &&
      proj.perpDistanceM <= MAX_PERP_M;
    if (reseedEligible) {
      stateRef.current = {
        progressM: proj.arcM,
        lastTickMs: now,
        lastTrustedProgressM: proj.arcM,
        lastTrustedTickMs: now,
        speedMps: nextSpeed,
        initialized: true,
      };
      setProgressM(proj.arcM);
      return;
    }

    // 모션 모델: 직전 tick부터 dead reckoning.
    const dt = (now - current.lastTickMs) / 1000;
    const rawPredicted = current.progressM + current.speedMps * dt;

    // #2093 (item C) — arc 시간적분 오버슛 gate. lastTrustedProgressM 대비 dead-reckoning 예측치가
    // 현재 hop 거리 × ARC_OVERSHOOT_HOP_MULTIPLIER를 초과하면 무효화 — trusted anchor로 되돌려 재적분.
    // 정지 상태에서도 시간 적분만 계속 누적되는 회귀(lesson_arc_time_integration_overshoot) 차단.
    const hopDistanceM = currentHopDistanceM(arc, current.lastTrustedProgressM);
    const overshotM = Math.abs(rawPredicted - current.lastTrustedProgressM);
    const predicted =
      hopDistanceM > 0 && overshotM > hopDistanceM * ARC_OVERSHOOT_HOP_MULTIPLIER
        ? current.lastTrustedProgressM
        : rawPredicted;

    // 경로 이탈: 관측 무시, dead reckoning만 적용. trusted baseline은 그대로.
    if (proj.perpDistanceM > MAX_PERP_M) {
      stateRef.current = {
        ...current,
        progressM: predicted,
        lastTickMs: now,
        speedMps: nextSpeed,
      };
      setProgressM(predicted);
      return;
    }

    // 점프 거부: 마지막 채택 관측 기준 implied speed가 물리적으로 불가능하면 거부.
    // baseline을 dead-reckoned predicted가 아닌 trusted로 유지해 연속 점프도 계속 차단.
    const trustedDt = (now - current.lastTrustedTickMs) / 1000;
    if (trustedDt > 0) {
      const trustedDelta = Math.abs(proj.arcM - current.lastTrustedProgressM);
      const impliedMps = trustedDelta / trustedDt;
      if (impliedMps > MAX_PLAUSIBLE_MPS) {
        stateRef.current = {
          ...current,
          progressM: predicted,
          lastTickMs: now,
          speedMps: nextSpeed,
        };
        setProgressM(predicted);
        return;
      }
    }

    const w = accuracyToWeight(accuracyMeters);
    const blended = predicted * (1 - w) + proj.arcM * w;
    stateRef.current = {
      progressM: blended,
      lastTickMs: now,
      lastTrustedProgressM: blended,
      lastTrustedTickMs: now,
      speedMps: nextSpeed,
      initialized: true,
    };
    setProgressM(blended);
  }, [arc, userLocation?.lat, userLocation?.lng, speedMps, accuracyMeters]);

  const position = useMemo<RoutePositionInfo | null>(() => {
    if (!arc || progressM === null) return null;
    return stationAtProgress(arc, progressM);
  }, [arc, progressM]);

  return { arc, progressM, position };
}
