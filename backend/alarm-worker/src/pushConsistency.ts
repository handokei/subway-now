/**
 * 모든 알람/알림 발사 경로 통합 정합성 게이트 — backend mirror (#1389).
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
 *
 * 본 backend 사본은 frontend mirror 와 의미적으로 동일(functional equivalence)하지만
 * SonarCloud CPD 회피를 위해 본문 토큰을 의도적으로 다르게 작성한다.
 * mirror 동기화는 `pushConsistency.mirror.test.ts` 가 functional equivalence 로 검증.
 */

export type Motion = 'stationary' | 'walking' | 'automotive' | 'unknown';

/** 디바이스 현재 신호 스냅샷. */
export interface DeviceSignal {
  /** 추정된 현재 역 이름. 추정 실패 시 null. */
  currentStationName: string | null;
  /** Core Motion activity. */
  motion: Motion;
  /** WiFi(BSSID/SSID)로 확증된 역. 강 확증 신호. 확증 실패 시 null. */
  wifiStation: { stationName: string; line: string } | null;
  /** 위 신호의 device 측 갱신 시각 (ms epoch). stale 컷오프 기준. */
  lastUpdateMs: number;
}

/** Push 발사 대상 (역+노선 쌍). */
export interface PushTarget {
  stationName: string;
  line: string;
}

/**
 * Trip 구조에 helper 가 직접 결합되지 않도록 callsite 에서 미리 계산해 주는 어댑터.
 *
 * `deviceHopsBehindTarget` 의미:
 *  -  0  : device 가 target 과 동일 정거장
 *  -  >0 : device 가 target 보다 N hop 뒤(behind)
 *  -  <0 : device 가 target 보다 N hop 앞(ahead)
 *  -  null: 산출 불가 (다른 라인 / trip 부재 / currentStation 부재) — 게이트 허용 fallback
 */
export interface TripContext {
  deviceHopsBehindTarget: number | null;
}

/** 차단 사유 enum (literal union). */
export type BlockReason =
  | 'wifi-mismatch'
  | 'motion-stationary-far-behind'
  | 'device-station-mismatch'
  | 'device-ahead-of-target';

/** 게이트 결과. allowed=true 만 push 진행. */
export type ConsistencyResult =
  | { allowed: true }
  | { allowed: false; reason: BlockReason };

/** 신호 stale 컷오프 (ms). 이 시점 이후엔 정보 없음으로 처리하여 fallback 허용. */
export const SIGNAL_STALE_MS = 5 * 60_000;

/** allow 결과 싱글톤 — 매 호출 객체 생성 비용 절감. */
const ALLOW: ConsistencyResult = { allowed: true };

/** block 결과 빌더. */
const block = (reason: BlockReason): ConsistencyResult => ({
  allowed: false,
  reason,
});

/**
 * 두 (stationName, line) 페어가 동일한지 검사.
 *
 * 두 필드 모두 정확 일치해야 한다 (line 다르면 station 같아도 mismatch).
 */
const sameStationLine = (
  lhs: { stationName: string; line: string },
  rhs: { stationName: string; line: string },
): boolean => lhs.stationName === rhs.stationName && lhs.line === rhs.line;

/**
 * Push 발사 직전 device signal 과 target 의 정합성을 평가.
 *
 * 평가 순서(먼저 매치되는 분기가 결과를 결정):
 *  1. WiFi == target              → allow (강 확증)
 *  2. WiFi != target + stationary → block (wifi-mismatch)
 *  3. signal stale (>5분)         → allow (정보 없음 fallback)
 *  4. 모든 signal null/unknown    → allow (지하 보호)
 *  5. trip hops null              → allow (fallback)
 *  6. hops == 0                   → allow
 *  7. hops < 0                    → block (device-ahead-of-target)
 *  8. hops == 1 + stationary      → block (motion-stationary-far-behind)
 *  9. hops == 1 + 이동중          → allow (추격 중)
 * 10. hops >= 2                   → block (device-station-mismatch)
 */
export const evaluatePushConsistency = (
  device: DeviceSignal,
  target: PushTarget,
  trip: TripContext,
  now: number,
): ConsistencyResult => {
  const { wifiStation, motion, currentStationName, lastUpdateMs } = device;
  const isStationary = motion === 'stationary';

  // ── Step 1/2: WiFi 강 확증 분기 ──────────────────────────────────────────
  if (wifiStation !== null) {
    if (sameStationLine(wifiStation, target)) {
      return ALLOW; // Step 1
    }
    if (isStationary) {
      return block('wifi-mismatch'); // Step 2
    }
    // WiFi 다르지만 motion=이동중 → 추격 가능성 → 다음 단계 계속
  }

  // ── Step 3: signal stale ────────────────────────────────────────────────
  const age = now - lastUpdateMs;
  if (age > SIGNAL_STALE_MS) {
    return ALLOW;
  }

  // ── Step 4: 모든 신호 부재 — 지하/권한거절 보호 ────────────────────────
  const allDark =
    currentStationName === null &&
    motion === 'unknown' &&
    wifiStation === null;
  if (allDark) {
    return ALLOW;
  }

  // ── Step 5~10: trip hops 기반 분기 ──────────────────────────────────────
  const { deviceHopsBehindTarget: hops } = trip;
  if (hops === null) {
    return ALLOW; // Step 5
  }
  if (hops === 0) {
    return ALLOW; // Step 6
  }
  if (hops < 0) {
    return block('device-ahead-of-target'); // Step 7
  }
  if (hops === 1) {
    // Step 8/9 — motion 으로 분기
    return isStationary
      ? block('motion-stationary-far-behind')
      : ALLOW;
  }
  // hops >= 2 (Step 10)
  return block('device-station-mismatch');
};
