/**
 * 모든 알람/알림 발사 경로 통합 정합성 게이트 (#1389).
 *
 * device가 수신하는 모든 push (silent / boarding-prompt / LA update / pre-scheduled
 * fire / FG fire) 가 device의 현재 신호 (currentStationName / motion / WiFi) 와
 * 모순되지 않도록 발사 직전 검사하는 순수 함수.
 *
 * 정책 원칙:
 *  - 신호가 명백히 다른 station을 확증할 때만 차단 (false positive 최소)
 *  - 신호가 부재/모호하면 허용 (지하 / 권한 거절 회귀 보호)
 *  - WiFi 확증은 GPS/motion보다 우선 (지하에서도 정확한 강 신호)
 *
 * frontend mirror: src/features/alarm/utils/pushConsistency.ts
 * 변경 시 두 파일을 동시에 갱신할 것 (현재 backend/frontend 빌드 분리 구조).
 */

export type Motion = 'stationary' | 'walking' | 'automotive' | 'unknown';

export type DeviceSignal = {
  /** 디바이스가 추정한 현재 역 이름 — 추정 실패 시 null. */
  currentStationName: string | null;
  motion: Motion;
  /** WiFi BSSID/SSID로 확증된 역 — 확증 실패 시 null. 강 확증 신호. */
  wifiStation: { stationName: string; line: string } | null;
  /** 위 신호가 device에서 마지막으로 업데이트된 시각 (ms epoch). stale 컷오프용. */
  lastUpdateMs: number;
};

export type PushTarget = {
  stationName: string;
  line: string;
};

/**
 * Trip 구조를 helper에서 직접 알지 않기 위한 어댑터 타입.
 * Callsite가 `trip.stopSequence` 와 `device.currentStationName`을 비교해
 * 미리 산출한 hop count를 주입한다.
 *
 * - 0  : device == target station
 * - >0 : device가 target보다 N hop behind
 * - <0 : device가 target보다 N hop ahead
 * - null: 산출 불가 (다른 라인 / trip 부재 / currentStationName 없음) → 게이트 허용 fallback
 */
export type TripContext = {
  deviceHopsBehindTarget: number | null;
};

export type ConsistencyResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'wifi-mismatch'
        | 'motion-stationary-far-behind'
        | 'device-station-mismatch'
        | 'device-ahead-of-target';
    };

/** signal age 컷오프 — 이보다 오래되면 stale 처리해 게이트 fallback(허용). */
export const SIGNAL_STALE_MS = 5 * 60_000;

function stationLineEq(
  a: { stationName: string; line: string },
  b: { stationName: string; line: string },
): boolean {
  return a.stationName === b.stationName && a.line === b.line;
}

/**
 * Push 발사 직전 device signal 과 target 의 정합성을 평가.
 *
 * 평가 순서(먼저 매치되는 분기가 결과를 결정):
 *  1. WiFi == target → allow (강 확증)
 *  2. WiFi != target && motion=stationary → block (wifi-mismatch)
 *  3. signal stale (lastUpdate > 5분 전) → allow
 *  4. 모든 signal null/unknown → allow (지하 보호)
 *  5. hops null (trip 모름) → allow (fallback)
 *  6. hops == 0 → allow
 *  7. hops < 0 → block (device-ahead-of-target)
 *  8. hops == 1 && motion=stationary → block (motion-stationary-far-behind)
 *  9. hops == 1 && motion != stationary → allow (추격 중)
 * 10. hops >= 2 → block (device-station-mismatch)
 */
export function evaluatePushConsistency(
  device: DeviceSignal,
  target: PushTarget,
  trip: TripContext,
  now: number,
): ConsistencyResult {
  // 1) WiFi 강 확증 우선
  if (device.wifiStation && stationLineEq(device.wifiStation, target)) {
    return { allowed: true };
  }
  // 2) WiFi != target + 정지 → 차단
  if (
    device.wifiStation &&
    !stationLineEq(device.wifiStation, target) &&
    device.motion === 'stationary'
  ) {
    return { allowed: false, reason: 'wifi-mismatch' };
  }

  // 3) signal stale → 정보 없음 처리, 허용
  if (now - device.lastUpdateMs > SIGNAL_STALE_MS) {
    return { allowed: true };
  }

  // 4) 모든 signal null/unknown → 지하 보호
  if (
    device.currentStationName === null &&
    device.motion === 'unknown' &&
    device.wifiStation === null
  ) {
    return { allowed: true };
  }

  // 5) trip context 부재 → fallback 허용
  const hops = trip.deviceHopsBehindTarget;
  if (hops === null) return { allowed: true };

  // 6) device == target
  if (hops === 0) return { allowed: true };

  // 7) device ahead of target
  if (hops < 0) {
    return { allowed: false, reason: 'device-ahead-of-target' };
  }

  // 8/9) 1 hop behind — motion으로 분기
  if (hops === 1) {
    if (device.motion === 'stationary') {
      return { allowed: false, reason: 'motion-stationary-far-behind' };
    }
    return { allowed: true };
  }

  // 10) 2+ hops behind
  return { allowed: false, reason: 'device-station-mismatch' };
}
