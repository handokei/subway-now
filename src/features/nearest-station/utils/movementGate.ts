/**
 * 정적 misfire 가드 (#727 PR A → #733 PR D → #728 PR B 확장) — 모든 알람 발사 경로의 SSOT.
 *
 * 알람 발사 4개 채널(useStationAlarm ETA / API imminent / silent push / 사전 예약) 가운데
 * ETA phase만 speed+accuracy 게이트를 갖고 있던 회귀를 보완. 사용자가 정적인데 다음의
 * 두 가지 경로로 알람이 잘못 발사되던 상황을 차단한다:
 *   1) API 도착정보 imminent — speedMps/accuracy 검증 없이 trackedTrainCode 매칭만으로 발사
 *   2) silent push — distance 게이트는 통과하지만 speed 무관
 *   3) fusion=position-train/arrival-arriving — 인근 통과 열차를 momentary lock 후 진행 추적
 *   4) boardingLock 예약 — 정적인데 사용자가 열차 탭하면 사전 예약 생성
 *
 * 한계: 이미 예약된 사전 알람의 *발사 시점* 차단은 OS-level이라 본 helper 범위 외.
 *      PR C(#729 fire-time re-validation)에서 별도 처리.
 *
 * #733 (PR D) 확장:
 *   - speedMps가 null인 경우(iOS Core Location이 정적 사용자에게 speed=-1 보고하는 경우)
 *     positionStability(usePositionStability) 신호로 fallback. 위치 이력이 정적이면 'static-position'으로 차단.
 *   - FUSION_DOWNGRADE_TARGETS에 'arrival-arriving' 추가 — arrival ENTERING 신호로 fusion이
 *     elevated 되어도 정적이면 강등 대상.
 *
 * #728 (PR B) 확장:
 *   - CMMotionActivity(iOS) motion=stationary 신호 추가. OS 가속도계 기반 정적 판정.
 *   - 평가 순서: stale > accuracy > **motion-stationary** > speed > position.
 *     motion이 speed보다 우선 — 16:14:22 회귀에서 snapshot speed=0.69 m/s가 STATIC_SPEED_THRESHOLD_MPS=0.5를
 *     우회한 phantom 케이스를 잡기 위함. destination/transfer 카테고리도 같은 가드로 보호.
 *   - 권한 거절/미지원: motionStationary 미전달 → 기존 가드만 동작 (graceful fallback).
 *
 * 입력 필드는 모두 옵션 — 호출자가 측정 가능한 신호만 전달하면 된다. 누락된 신호는
 * 해당 분기 검증을 skip (false negative보다 false positive 차단 우선).
 */

import type { PositionStability } from './positionStaticDetector';

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
  | 'static-speed'
  // #733 — speed 미측정 시 위치 이력(usePositionStability)으로 정적 확정.
  | 'static-position'
  // #728 — CMMotionActivity(iOS) motion=stationary 신호. OS 가속도계 기반 정적 판정.
  // speed=0.69 m/s 같은 임계 우회 phantom과 destination/transfer 카테고리 무방비 회귀를 동시에 차단.
  | 'motion-stationary';

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
  | ({ reliable: true; reason?: never } & MovementSignalShared)
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
  'static-position': 'movement-static-position',
  'motion-stationary': 'movement-motion-stationary',
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
 *
 * #733 — speedMps가 null/undefined인 경우 `positionStability` fallback. iOS 정적 사용자에게서
 * speed=-1(미측정)이 자주 발생하는 케이스 보강. positionStability='static'이면 정적 확정,
 * 'moving'/'unknown'이면 보수적 false. accuracy 가드(MAX_ACCURACY_M)는 fallback 경로에도 적용.
 *
 * #728 — speedMps가 null/undefined인 경우 motionStationary(CMMotionActivity) 신호를 positionStability보다
 * 우선 적용. motion=true면 즉시 정적 확정. motion 신호는 OS 가속도계 기반이라 GPS 좌표 이력보다
 * 신뢰성 있다. accuracy 가드는 motion fallback 경로에도 동일 적용 (지하 GPS 노이즈 보호).
 */
export function isStaticSpeedSignal(
  speedMps: number | null | undefined,
  accuracyM?: number | null,
  positionStability?: PositionStability,
  motionStationary?: boolean,
): boolean {
  if (accuracyM != null && accuracyM > MAX_ACCURACY_M) return false;
  if (speedMps != null) {
    return speedMps < STATIC_SPEED_THRESHOLD_MPS;
  }
  // #728 — speed 미측정 시 motion 신호(OS 가속도계)가 위치 이력보다 우선.
  // CMMotionActivity는 직접 측정값이라 noisy한 GPS 좌표 이력보다 신뢰 가능.
  if (motionStationary === true) return true;
  return positionStability === 'static';
}

/** fusion downgrade(#727) 대상 confidence. 사용자 정적 신호가 잡히면 gps-only로 강등.
 *  #733 — 'arrival-arriving' 추가. arrival ENTERING 신호로 fusion이 elevated 된 경우도 강등 대상. */
const FUSION_DOWNGRADE_TARGETS = [
  'position-train',
  'boarding-lock',
  'boarding-lock-interp',
  'arrival-arriving',
] as const;
export type FusionDowngradeTarget = (typeof FUSION_DOWNGRADE_TARGETS)[number];

export function isFusionDowngradeTarget(confidence: string): confidence is FusionDowngradeTarget {
  return (FUSION_DOWNGRADE_TARGETS as readonly string[]).includes(confidence);
}

/**
 * fusion downgrade 결정 (#727 / #733).
 *   - 사용자가 정적(isStaticSpeedSignal)이고
 *   - 현재 confidence가 fusion 승격 라벨(position-train / boarding-lock / boarding-lock-interp / arrival-arriving)일 때만
 * true. 호출자는 result/confidence/source를 gps 원본으로 되돌린다.
 *
 * #733 — speedMps가 null인 경우 positionStability fallback. snapshot 2(speed=null, fusion=arrival-arriving)
 * 같은 회귀가 더 이상 fusion을 elevated 상태로 유지하지 못한다.
 */
export function shouldDowngradeFusion(input: {
  confidence: string;
  speedMps: number | null | undefined;
  accuracyM: number | null | undefined;
  positionStability?: PositionStability;
  /** #728 — CMMotionActivity stationary 신호. speed=null 경로에서 positionStability보다 우선. */
  motionStationary?: boolean;
}): boolean {
  if (!isFusionDowngradeTarget(input.confidence)) return false;
  return isStaticSpeedSignal(
    input.speedMps,
    input.accuracyM,
    input.positionStability,
    input.motionStationary,
  );
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
 *   4. (#728) motionStationary === true → 'motion-stationary'
 *      - speed/position 신호보다 우선. 16:14:22 회귀(speed=0.69 임계 우회)와
 *        destination/transfer 카테고리 무방비를 동시 차단하는 핵심 신호.
 *   5. speedMps 있으면서 < STATIC_SPEED_THRESHOLD_MPS → 'static-speed'
 *   6. (#733) speedMps 없고 positionStability='static' → 'static-position'
 *   7. 그 외 → reliable=true
 *
 * 호출자는 결과의 reason으로 logSuppressedGate/logSilentPushSkipped 등 적재.
 */
export function evaluateMovement(
  loc: LocationSignalInput | null,
  now: number = Date.now(),
  positionStability?: PositionStability,
  motionStationary?: boolean,
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

  // #728 — CMMotionActivity 정적 신호. speed/position보다 우선.
  // 핵심 동기: speed=0.69 m/s (임계값 0.5 우회 phantom) 같은 회귀를 잡고,
  // destination/transfer 카테고리도 같은 가드로 보호.
  if (motionStationary === true) {
    return { reliable: false, reason: 'motion-stationary' };
  }

  if (loc.speedMps != null && loc.speedMps < STATIC_SPEED_THRESHOLD_MPS) {
    return { reliable: false, reason: 'static-speed', speedMps: loc.speedMps };
  }

  // #733 — speed 미측정 시 위치 이력 fallback. positionStability가 명시적으로 'static'일 때만
  // 차단. 'unknown'/'moving'은 신뢰성 없음 → 기존 path 유지 (reliable).
  if (loc.speedMps == null && positionStability === 'static') {
    return { reliable: false, reason: 'static-position' };
  }

  const result: MovementSignal = { reliable: true };
  if (loc.speedMps != null) result.speedMps = loc.speedMps;
  if (loc.accuracyM != null) result.accuracyM = loc.accuracyM;
  if (loc.timestamp != null) result.ageMs = now - loc.timestamp;
  return result;
}
