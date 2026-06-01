/**
 * 정적 misfire 가드 (#727 PR A) — 모든 알람 발사 경로의 SSOT.
 *
 * 알람 발사 4개 채널(useStationAlarm ETA / API imminent / silent push / 사전 예약) 가운데
 * ETA phase만 speed+accuracy 게이트를 갖고 있던 회귀를 보완. 사용자가 정적인데 다음의
 * 두 가지 경로로 알람이 잘못 발사되던 상황을 차단한다:
 *   1) API 도착정보 imminent — speedMps/accuracy 검증 없이 trackedTrainCode 매칭만으로 발사
 *   2) silent push — distance 게이트는 통과하지만 speed 무관
 *   3) fusion=position-train — 인근 통과 열차를 momentary lock 후 진행 추적 → 잘못된 lock
 *   4) boardingLock 예약 — 정적인데 사용자가 열차 탭하면 사전 예약 생성
 *
 * 한계: 이미 예약된 사전 알람의 *발사 시점* 차단은 OS-level이라 본 helper 범위 외.
 *      PR C(#729 fire-time re-validation)에서 별도 처리.
 *
 * 입력 필드는 모두 옵션 — 호출자가 측정 가능한 신호만 전달하면 된다. 누락된 신호는
 * 해당 분기 검증을 skip (false negative보다 false positive 차단 우선).
 */

/** 30s 이전 좌표는 stale로 간주 (Bumble Tech 권고). 새 location이 timestamp 동반일 때만 검증. */
export const STALE_AGE_MS = 30_000;

/** 100m 초과 accuracy는 wifi/cell tower fallback 의심 (transistorsoft #892). drop. */
export const MAX_ACCURACY_M = 100;

/** 사람 걸음 평균 1.4 m/s. 0.5 미만은 정적 확정 (GPS noise floor ~0.3 m/s). */
export const STATIC_SPEED_THRESHOLD_MPS = 0.5;

export type MovementReason =
  | 'no-location'
  | 'stale-timestamp'
  | 'low-accuracy'
  | 'static-speed';

interface MovementSignalShared {
  speedMps?: number;
  accuracyM?: number;
  ageMs?: number;
}

/**
 * discriminated union — `reliable=false`면 `reason` 필수, `reliable=true`면 reason 부재.
 * 호출자가 가드 없이 reason에 접근하면 컴파일 에러 — 신규 호출자 safety 보장.
 */
export type MovementSignal =
  | ({ reliable: true; reason?: undefined } & MovementSignalShared)
  | ({ reliable: false; reason: MovementReason } & MovementSignalShared);

/**
 * MovementReason → AlarmLogReason 매핑. 가드가 차단한 알람을 alarmLog에 적재할 때 사용.
 * 'movement-' 접두사로 일관 — 다른 gate-/dedup- reason과 시각적으로 구분.
 */
export const MOVEMENT_TO_ALARM_LOG_REASON = {
  'no-location': 'movement-no-location',
  'stale-timestamp': 'movement-stale-timestamp',
  'low-accuracy': 'movement-low-accuracy',
  'static-speed': 'movement-static-speed',
} as const satisfies Record<MovementReason, string>;

/**
 * fusion downgrade(#727)용 빠른 정지 판정.
 *
 * 단순히 `speedMps < 임계값`만 보지 않고 **GPS accuracy도 함께** 검증한다:
 *   - accuracyM이 MAX_ACCURACY_M(100m) 초과면 GPS 신호 자체 신뢰 불가 → speed 신호도 noise 가능성 → false
 *   - accuracyM이 정상이거나 미측정이고 speed < 임계값이면 → true (정적 확정)
 *
 * 이렇게 한 이유: 지하 깊은 구간에서 accuracy=1500m, speed=0 시그널은 GPS lock이 끊긴 noise일
 * 가능성이 매우 높다. 그런데 fusion(position/arrival)은 그 시점에 *유일하게 정확한 신호*이므로
 * 강등하면 false negative(누락) 발생. accuracy 정상 + speed=0일 때만 정적 확정으로 다룬다.
 *
 * evaluateMovement는 평가 순서가 stale > accuracy > speed라 accuracy>100m 케이스에서 static-speed
 * 분기를 못 탄다 — 단일 책임 helper로 분리해 정책 차이를 명시.
 */
export function isStaticSpeedSignal(
  speedMps: number | null | undefined,
  accuracyM?: number | null,
): boolean {
  if (speedMps == null || speedMps >= STATIC_SPEED_THRESHOLD_MPS) return false;
  // accuracy 알 수 없으면 speed 신호 그대로 신뢰. 알 수 있고 임계값 초과면 noise로 판정.
  if (accuracyM != null && accuracyM > MAX_ACCURACY_M) return false;
  return true;
}

/** fusion downgrade(#727) 대상 confidence. 사용자 정적 신호가 잡히면 gps-only로 강등. */
const FUSION_DOWNGRADE_TARGETS = ['position-train', 'boarding-lock', 'boarding-lock-interp'] as const;
export type FusionDowngradeTarget = (typeof FUSION_DOWNGRADE_TARGETS)[number];

export function isFusionDowngradeTarget(confidence: string): confidence is FusionDowngradeTarget {
  return (FUSION_DOWNGRADE_TARGETS as readonly string[]).includes(confidence);
}

/**
 * fusion downgrade 결정 (#727).
 *   - 사용자가 정적(isStaticSpeedSignal)이고
 *   - 현재 confidence가 fusion 승격 라벨(position-train / boarding-lock / boarding-lock-interp)일 때만
 * true. 호출자는 result/confidence/source를 gps 원본으로 되돌린다.
 */
export function shouldDowngradeFusion(input: {
  confidence: string;
  speedMps: number | null | undefined;
  accuracyM: number | null | undefined;
}): boolean {
  if (!isFusionDowngradeTarget(input.confidence)) return false;
  return isStaticSpeedSignal(input.speedMps, input.accuracyM);
}

export interface LocationSignalInput {
  /** epoch ms — 없으면 stale-timestamp 검증 skip. */
  timestamp?: number;
  /** meters — 없으면 low-accuracy 검증 skip. */
  accuracyM?: number;
  /** m/s — 없으면 static-speed 검증 skip. */
  speedMps?: number;
}

/**
 * 사용자 이동 신호를 평가해 알람 발사 적합성을 반환한다.
 *
 * 평가 순서 (먼저 매칭되는 reason으로 즉시 반환):
 *   1. loc === null → 'no-location'
 *   2. timestamp 있으면서 (now - timestamp) > STALE_AGE_MS → 'stale-timestamp'
 *   3. accuracyM 있으면서 > MAX_ACCURACY_M → 'low-accuracy'
 *   4. speedMps 있으면서 < STATIC_SPEED_THRESHOLD_MPS → 'static-speed'
 *   5. 그 외 → reliable=true
 *
 * 호출자는 결과의 reason으로 logSuppressedGate/logSilentPushSkipped 등 적재.
 */
export function evaluateMovement(
  loc: LocationSignalInput | null,
  now: number = Date.now(),
): MovementSignal {
  if (!loc) return { reliable: false, reason: 'no-location' };

  if (loc.timestamp != null) {
    const ageMs = now - loc.timestamp;
    if (ageMs > STALE_AGE_MS) {
      return { reliable: false, reason: 'stale-timestamp', ageMs };
    }
  }

  if (loc.accuracyM != null && loc.accuracyM > MAX_ACCURACY_M) {
    return { reliable: false, reason: 'low-accuracy', accuracyM: loc.accuracyM };
  }

  if (loc.speedMps != null && loc.speedMps < STATIC_SPEED_THRESHOLD_MPS) {
    return { reliable: false, reason: 'static-speed', speedMps: loc.speedMps };
  }

  const result: MovementSignal = { reliable: true };
  if (loc.speedMps != null) result.speedMps = loc.speedMps;
  if (loc.accuracyM != null) result.accuracyM = loc.accuracyM;
  if (loc.timestamp != null) result.ageMs = now - loc.timestamp;
  return result;
}
