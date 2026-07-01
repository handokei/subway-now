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
 *   - 권한 거절/미지원: motionStationary=false → speed/positionStability 가드로 fallback.
 *
 * #1013 — warmup window 보호 + positionStability 60s fallback:
 *   - fg-hydrate 직후 30s warmup window 동안 motionStationary=undefined (아직 초기화 중).
 *     이 상태에서 speedMps=null + positionStability='unknown'이면 신호 부재 구간 → 'motion-warmup'으로 차단.
 *   - motion 권한 거절(motionStationary=false 고정) 시 speed 미측정이면 positionStability fallback이
 *     유일한 정적 판정 수단. positionStability 60s 수집이 완료되면 'static'/'moving'으로 정상 동작.
 *   - 평가 순서 확장: stale > accuracy > motion-stationary(=true) > speed > position > **motion-warmup**
 *     (motion=undefined + speed=null + positionStability=unknown일 때 마지막 보호막).
 *
 * #1401 (Epic #1396) — 열차 진행(trainProgressing) 신호 추가:
 *   - device 모션(CMMotionActivity) + GPS speed는 지하철 내부에서 불신뢰. iOS Core Location은
 *     정적 사용자에게 speed=-1(미측정)을 보고하기도 하고, CMMotionActivity는 지하철에서
 *     stationary/automotive를 애매하게 보고한다. 결과: 실제 이동 중인데 "정적"으로 판정해
 *     도착 알람을 누락(역삼 13:37 회귀).
 *   - 반면 fusion 결과가 arc 위에서 advance(prev → cur idx 증가)하면, 열차는 device 모션과
 *     무관하게 물리적으로 진행 중. 호출자가 `trainProgressing=true`를 전달하면 정적 reason
 *     3종(motion-stationary / static-speed / static-position) 가드를 우회한다.
 *   - 유지되는 reason: no-location / stale-timestamp / low-accuracy / motion-warmup —
 *     fusion advance는 device 신호 신뢰성을 보장하지 않으므로 GPS lock·warmup·신호 부재 분기는 유지.
 *   - false positive 방어: trainProgressing 판정은 호출자(useFusedNearestStation) 책임 —
 *     arc 위 idx 증가만 신호로 사용(forward-only, monotone). fusion이 잘못된 lock에 흔들려도
 *     arc 진행은 정의상 명시적 trip arc 위에서만 일어나므로 false positive 위험 작다.
 *
 * 입력 필드는 모두 옵션 — 호출자가 측정 가능한 신호만 전달하면 된다. 누락된 신호는
 * 해당 분기 검증을 skip (false negative보다 false positive 차단 우선).
 *
 * ADR-022 Phase 4-3 (#2005) — flag guard (dormant):
 *   `isSimpleArchEnabled()` (env `EXPO_PUBLIC_SIMPLE_ARRIVAL_ARCH` OR backend KV
 *   `arch:simple-arrival-v1`) 가 ON 이면 `evaluateMovement` 는 즉시 `{ reliable: true }` 를
 *   반환한다. arrival API SSoT 아키텍처에서는 fire 판정이 backend `arvlCd` 만으로 결정되며
 *   device motion / GPS speed / positionStability 는 오히려 정확한 알림을 억제한다
 *   (예: 지하 깊은 구간에서 speed=-1 + motion=stationary 오검출로 정상 알림 miss).
 *   flag OFF (기본) 시에는 기존 로직 100% 유지 — dormant.
 *
 *   `shouldDowngradeFusion` / `isStaticSpeedSignal` / `isStaticMovementResult` 는 fusion
 *   downgrade layer 별개로 flag guard 미적용 — Phase 4 다른 sub-issue 에서 결정한다.
 *   `accelMotion.ts` 의 pattern 판정도 DebugModal / backend 송신용으로 유지 (dormant).
 */

import { isSimpleArchEnabled } from '../../../shared/config/archFlag';
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
  | 'motion-stationary'
  // #1013 — fg-hydrate 직후 warmup window(~30s) 동안 motion 신호가 아직 초기화되지 않은 상태.
  // motionStationary=undefined + speedMps=null + positionStability='unknown' 동시 발생 시 신호 부재
  // 구간으로 차단. positionStability 60s 수집 또는 motion 초기화 완료 후 자연 해소.
  | 'motion-warmup';

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
 * #1357 (S1) — preschedule 시점 motion gate에서 "정적 확정" 신호를 판정하는 helper.
 *
 * 사전예약 schedule 진입 직후 호출자가 `evaluateMovement` 결과를 본 helper에 통과시켜
 * `true`면 schedule을 skip한다. preschedule path는 OS local notification이 ETA 시점에
 * OS 레벨로 발사되므로, JS가 fire 시점에 가로채지 못한다 — 진입 시점 차단이 유일한 게이트.
 *
 * 포함되는 reason (정적 확정 카테고리):
 *   - `motion-stationary`: OS 가속도계(CMMotionActivity) 정적 신호 — 가장 강한 정적 증거
 *   - `static-speed`: GPS speed < 0.5 m/s
 *   - `static-position`: speed 미측정 + positionStability='static'
 *
 * 명시적으로 포함되지 않는 reason (신호 부재 / 다른 원인):
 *   - `no-location`, `stale-timestamp`, `low-accuracy`: 신호 신뢰성 부족이지 정적 확정 아님
 *   - `motion-warmup`: warmup window 한시 차단으로 정적 확정 아님 — preschedule은 진행
 *
 * 호출자가 가드 없이 reason에 접근하면 컴파일 에러 (discriminated union) — 미정의 reason
 * 추가 시 본 helper도 함께 갱신해야 한다.
 */
const STATIC_MOVEMENT_REASONS = new Set<MovementReason>([
  'motion-stationary',
  'static-speed',
  'static-position',
]);

export function isStaticMovementResult(reason: MovementReason | undefined): boolean {
  if (reason === undefined) return false;
  return STATIC_MOVEMENT_REASONS.has(reason);
}

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
  'motion-warmup': 'movement-motion-warmup',
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
 *
 * #1401 — `trainProgressing=true` 시 즉시 false (정적 신호 무효화). 열차 진행이 확인된 상황에서는
 * device 모션/GPS speed 정적 신호가 noise이므로 fusion downgrade 금지. accuracy 가드는 별도로
 * 우선 평가 — accuracy noise는 trainProgressing과 무관하게 GPS 자체 신뢰 불가.
 */
export function isStaticSpeedSignal(
  speedMps: number | null | undefined,
  accuracyM?: number | null,
  positionStability?: PositionStability,
  motionStationary?: boolean,
  trainProgressing?: boolean,
): boolean {
  if (accuracyM != null && accuracyM > MAX_ACCURACY_M) return false;
  // #1401 — 열차 진행이 확인되면 device 신호 단독으로 정적 판정 금지.
  if (trainProgressing === true) return false;
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
  /**
   * #1401 — 호출자가 직전 tick 대비 fusion result가 arc 위에서 advance했음을 확인한 신호.
   * true면 device 모션/GPS speed 정적 신호가 noise로 간주되어 강등 금지. accuracy 가드는 별도 적용.
   */
  trainProgressing?: boolean;
}): boolean {
  if (!isFusionDowngradeTarget(input.confidence)) return false;
  // accuracy 가드: GPS lock이 끊긴 노이즈는 정적 신호로 보지 않는다(기존 정책 유지).
  if (input.accuracyM != null && input.accuracyM > MAX_ACCURACY_M) return false;
  // #1401 — 열차 진행 확정 시 정적 신호 합의해도 강등 금지(false positive 차단).
  if (input.trainProgressing === true) return false;

  // #1363 — single-signal downgrade 회귀(fu jumping) 차단. consensus 게이트(≥2 신호).
  // 회귀 패턴: iOS에서 motion=null/unknown이 자주 발생 → 단일 신호(speed alone)로 fusion-elevated
  // confidence(position-train / boarding-lock / arrival-arriving)가 gps-only로 강등됐다가 다음
  // tick에 재승격 → 사용자 화면에서 현재역(fu)이 튄다.
  //
  // 합의 후보(독립 신호):
  //   1. speedMps < STATIC_SPEED_THRESHOLD_MPS — GPS 속도 정적
  //   2. motionStationary === true            — CMMotionActivity 정적
  //   3. positionStability === 'static'       — 좌표 이력 60s 정적
  // motionStationary === undefined / positionStability === undefined는 warmup으로 간주해 합의에
  // 포함하지 않는다(neutral). 강등은 ≥2 합의 시에만 허용. positionStability === 'moving'이거나
  // motionStationary === false는 명시 비-정적 신호로 합의 카운트를 차감하지 않지만, 어떤 정적
  // 후보도 active하지 않으면 자연스럽게 강등 보류된다.
  let staticSignalCount = 0;
  if (typeof input.speedMps === 'number' && input.speedMps < STATIC_SPEED_THRESHOLD_MPS) {
    staticSignalCount += 1;
  }
  if (input.motionStationary === true) staticSignalCount += 1;
  if (input.positionStability === 'static') staticSignalCount += 1;
  return staticSignalCount >= FUSION_DOWNGRADE_CONSENSUS_MIN;
}

/** #1363 — fusion downgrade 합의 최소 신호 수(2). 단일 신호 강등 회귀 차단. */
export const FUSION_DOWNGRADE_CONSENSUS_MIN = 2;

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
 *   4. (#1401) trainProgressing === true → 정적 가드 3종(4·5·6) 우회. fusion arc advance가 확인되면
 *      device 모션/GPS speed 정적 신호는 noise로 간주.
 *   5. (#728) motionStationary === true → 'motion-stationary'
 *      - speed/position 신호보다 우선. 16:14:22 회귀(speed=0.69 임계 우회)와
 *        destination/transfer 카테고리 무방비를 동시 차단하는 핵심 신호.
 *   6. speedMps 있으면서 < STATIC_SPEED_THRESHOLD_MPS → 'static-speed'
 *   7. (#733) speedMps 없고 positionStability='static' → 'static-position'
 *   8. (#1013) motionStationary=undefined + speedMps=null + positionStability='unknown' → 'motion-warmup'
 *      - fg-hydrate 직후 warmup window. 모든 신호가 부재할 때 한시적 차단.
 *      - trainProgressing=true여도 평가 도달 X — 평가 순서상 (4)에서 정적 가드만 우회되고
 *        warmup은 신호 부재(GPS lock도 안 잡힘) 분기라 별도 유지.
 *   9. 그 외 → reliable=true
 *
 * 호출자는 결과의 reason으로 logSuppressedGate/logSilentPushSkipped 등 적재.
 */
export function evaluateMovement(
  loc: LocationSignalInput | null,
  now: number = Date.now(),
  positionStability?: PositionStability,
  /**
   * CMMotionActivity stationary 신호.
   *   - `true`  : OS 가속도계가 정적 확정 → 즉시 차단 (speed보다 우선).
   *   - `false` : 이동 중 또는 motion 권한 거절/미지원 → motion 가드 스킵, speed/position fallback.
   *   - `undefined` : 초기화 중 warmup 상태(fg-hydrate 직후 ~30s). speed=null + positionStability=unknown
   *                   동시 발생 시 'motion-warmup'으로 차단해 신호 부재 구간 게이트 우회 방지 (#1013).
   */
  motionStationary?: boolean,
  /**
   * #1401 — 열차 진행(arc advance) 신호. true면 정적 reason 3종(motion-stationary / static-speed /
   * static-position) 가드를 우회한다. device 모션/GPS speed가 지하철 내부에서 불신뢰하므로,
   * fusion arc advance가 확인되면 그쪽이 더 강한 진행 신호. 단 stale/low-accuracy/warmup은
   * fusion advance와 무관한 GPS 자체 신뢰성 분기라 그대로 유지.
   */
  trainProgressing?: boolean,
): MovementSignal {
  // ADR-022 Phase 4-3 (#2005) — arrival API SSoT flag ON 시 motion gate 전면 bypass.
  // fire 판정을 backend arvlCd 로 단일화하므로 device motion / GPS speed / warmup 게이트가
  // 알림을 억제하면 오히려 miss 유발. flag OFF (기본) 시엔 이 분기 skip → 기존 로직 100% 유지.
  if (isSimpleArchEnabled()) {
    return { reliable: true };
  }

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

  // #1401 — 열차 진행 확정 시 device 정적 신호 우회. fusion advance가 device 모션/GPS speed보다
  // 강한 진행 증거이므로 motion-stationary / static-speed / static-position 가드 모두 skip.
  // stale/low-accuracy/motion-warmup은 이 분기 도달 전 처리되므로 영향 없음.
  if (trainProgressing === true) {
    const result: MovementSignal = { reliable: true };
    if (loc.speedMps != null) result.speedMps = loc.speedMps;
    if (loc.accuracyM != null) result.accuracyM = loc.accuracyM;
    if (loc.timestamp != null) result.ageMs = now - loc.timestamp;
    return result;
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

  // #1013 — warmup window 보호. fg-hydrate 직후 motionStationary=undefined(초기화 중) +
  // speedMps=null + positionStability='unknown' 동시 발생 = 모든 신호 부재 구간.
  // 이 상태에서 gate를 통과시키면 stale 좌표 기반 잘못된 알람 발사 위험.
  // positionStability 60s 수집 또는 motion 초기화 완료 후 자연 해소 — 한시적 차단.
  if (motionStationary === undefined && loc.speedMps == null && positionStability === 'unknown') {
    return { reliable: false, reason: 'motion-warmup' };
  }

  const result: MovementSignal = { reliable: true };
  if (loc.speedMps != null) result.speedMps = loc.speedMps;
  if (loc.accuracyM != null) result.accuracyM = loc.accuracyM;
  if (loc.timestamp != null) result.ageMs = now - loc.timestamp;
  return result;
}
