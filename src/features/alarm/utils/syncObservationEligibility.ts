import { GPS_QUALITY_GATE_MAX_AGE_MS } from '../../../shared/constants/gpsQualityGate';
import { SYNC_OBSERVATION_FIX_INDEPENDENT_SOURCES } from '../../../shared/constants/boardingLock';
import type { FusionSource } from '../../../shared/types/fusion';

/**
 * #3191 PR-S — 화면에 표시되는 fused 현재역이 `/boarding-lock/sync` 관측역(= backend 판단 입력)으로
 * 새는 것을 막는다. GPS는 표시 권한만 있고 판단 권한이 없다(ADR-039 §D, memory feedback_no_gps_for_decision).
 *
 * 송신 자격: WiFi SSID·lock 출처(fix와 무관하게 역을 확정) 이거나, 신선 fix(나이 < GPS_QUALITY_GATE_MAX_AGE_MS,
 * useFusedNearestStation의 isDecisionGpsStale과 동일 기준). 묵은 fix 위에서 arrival/position 신호로만 고른
 * 결과는 미송신. fix 시각을 모르면(null) 신선을 증명할 수 없으므로 미송신.
 */
export function isSyncObservationEligible(input: {
  source: FusionSource;
  lastFixAtMs: number | null;
  nowMs: number;
}): boolean {
  const { source, lastFixAtMs, nowMs } = input;
  if (SYNC_OBSERVATION_FIX_INDEPENDENT_SOURCES.includes(source)) return true;
  if (lastFixAtMs === null) return false;
  return nowMs - lastFixAtMs < GPS_QUALITY_GATE_MAX_AGE_MS;
}
