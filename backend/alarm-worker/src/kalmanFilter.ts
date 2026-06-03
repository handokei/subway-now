/**
 * 1D Kalman filter — smoothed velocity 추정 (#824 Phase 3 E2).
 *
 * positionSeries.evaluateWindow의 `gpsAvgKmh` (관측)와 accelSeries.evaluateAccelWindow의
 * magnitude 통계(프로세스 노이즈 driver)를 fuse해 transient noise — 터널 진입/정거장
 * 정차/짧은 GPS dropout — 에 robust한 속도를 산출한다. 결과는 `fusedSpeed.kalmanKmh`에
 * weighted average로 합류한다.
 *
 * ADR: https://app.notion.com/p/37430c0194b6819c8323e37d4c31a777 Section 5 (Phase 3).
 *
 * # State
 *  - `v`  scalar velocity (km/h)
 *  - `P`  uncertainty covariance (km/h)²
 *  - `ts` 마지막 update 시각 (epoch ms) — Δt 산출
 *
 * # Predict (random walk + uncertainty inflation)
 *   v_pred = v_prev
 *   P_pred = P_prev + Q(accelStd) · Δt
 *
 * 의도적 단순화: E1 `magnitudeMean`은 unsigned positive라 가/감속을 구분 못한다.
 * 직접 driver로 `v_prev + a·Δt`를 쓰면 정거장 정차 phase에서도 위로 drift한다.
 * 대신 stddev를 process noise Q로 인코딩 — 가속도 흔들림이 크면 predict 분산이
 * 커져 GPS update가 더 강하게 보정. E3/E4에서 signed direction 또는 phase 추정으로
 * 정밀화 가능.
 *
 * # Update (Bayesian fusion)
 *   K = P_pred / (P_pred + R(accuracy))
 *   v_new = v_pred + K · (z - v_pred)   // z = gpsAvgKmh
 *   P_new = (1 - K) · P_pred
 *
 * # Noise tables (PR 본문 표와 SSOT)
 *  관측 R — accuracy 단계 함수 (km/h)²
 *    < 20m  →  4   (~±2  km/h, urban canyon 정상)
 *    < 50m  →  25  (~±5  km/h, 일반 도시 GPS)
 *    < 100m →  100 (~±10 km/h, 신뢰 낮음)
 *    ≥ 100m →  400 (~±20 km/h, observation 거의 무시)
 *
 *  프로세스 Q — accel stddev 단계 함수 (km/h)²/s
 *    < 0.5 m/s² →  1  (정거장 정차/정속 cruise)
 *    < 2.0 m/s² →  9  (도보/일반 가속)
 *    ≥ 2.0 m/s² →  36 (열차 출발·감속 phase)
 *
 *  초기 P₀ = R(accuracy) — 첫 관측의 분산이 prior 부재 시 가장 정확한 사전.
 *
 * # State 만료
 *  - prior 부재 또는 Δt > STATE_STALE_THRESHOLD_MS → observation 직접 초기화.
 *  - Δt ≤ 0 → predict skip (시계 역행 보호; prior 그대로 update만).
 */

/** KV 키 prefix — device token 1개당 1 state. */
const KALMAN_STATE_PREFIX = 'kalman:';
/** KV TTL — positionSeries/accelSeries와 정합 (1h 미활동 시 자연 폐기). */
const STATE_TTL_SEC = 60 * 60;
/** 상태 만료 임계 — Δt 이 값 초과면 stale로 간주해 observation으로 초기화. */
export const STATE_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** R 단계 함수 임계 (m). */
export const ACCURACY_R_LOW_M = 20;
export const ACCURACY_R_MID_M = 50;
export const ACCURACY_R_HIGH_M = 100;
/** R 단계 함수 분산 (km/h)². */
export const R_LOW = 4;
export const R_MID = 25;
export const R_HIGH = 100;
export const R_REJECT = 400;

/** Q 단계 함수 임계 (m/s²). */
export const ACCEL_STD_Q_LOW = 0.5;
export const ACCEL_STD_Q_MID = 2;
/** Q 단계 함수 분산 (km/h)²/s — Δt 곱해서 사용. */
export const Q_LOW = 1;
export const Q_MID = 9;
export const Q_HIGH = 36;

export interface KalmanState {
  /** 추정 속도 km/h. */
  v: number;
  /** 추정 분산 (km/h)². */
  P: number;
  /** 마지막 update 시각 (epoch ms). */
  ts: number;
}

export interface KalmanStepInputs {
  /** 직전 cycle의 state. 미존재(null)거나 stale이면 observation으로 초기화. */
  prior: KalmanState | null;
  /** GPS 관측 km/h — positionSeries.evaluateWindow.gpsAvgKmh. */
  gpsAvgKmh: number;
  /** 윈도우 평균 accuracy meters — R 단계 함수 입력. */
  gpsAccuracyMeters: number;
  /** accel 윈도우 stddev (m/s²) — Q 단계 함수 입력. 0이면 Q_LOW. */
  accelMagnitudeStd: number;
  /** 현 시각 epoch ms — Δt 산출. */
  now: number;
}

/** R 단계 함수 — accuracy → 관측 분산. */
export function computeNoiseR(accuracyMeters: number): number {
  if (accuracyMeters < ACCURACY_R_LOW_M) return R_LOW;
  if (accuracyMeters < ACCURACY_R_MID_M) return R_MID;
  if (accuracyMeters < ACCURACY_R_HIGH_M) return R_HIGH;
  return R_REJECT;
}

/** Q 단계 함수 — accel stddev → 프로세스 분산 per second. */
export function computeNoiseQ(accelStd: number): number {
  if (accelStd < ACCEL_STD_Q_LOW) return Q_LOW;
  if (accelStd < ACCEL_STD_Q_MID) return Q_MID;
  return Q_HIGH;
}

/**
 * Predict step — constant velocity, uncertainty grows by Q · Δt.
 * Δt ≤ 0은 시계 역행 보호로 prior 그대로 반환 (다음 update가 이어받음).
 */
export function predictKalman(
  prior: KalmanState,
  accelMagnitudeStd: number,
  now: number,
): KalmanState {
  const dtMs = now - prior.ts;
  if (dtMs <= 0) return prior;
  const dtSec = dtMs / 1000;
  const Q = computeNoiseQ(accelMagnitudeStd);
  return {
    v: prior.v,
    P: prior.P + Q * dtSec,
    ts: now,
  };
}

/** Update step — Kalman gain으로 prediction과 GPS 관측을 가중평균. */
export function updateKalman(
  predicted: KalmanState,
  gpsAvgKmh: number,
  gpsAccuracyMeters: number,
): KalmanState {
  const R = computeNoiseR(gpsAccuracyMeters);
  const K = predicted.P / (predicted.P + R);
  return {
    v: predicted.v + K * (gpsAvgKmh - predicted.v),
    P: (1 - K) * predicted.P,
    ts: predicted.ts,
  };
}

/**
 * 한 cycle의 Kalman step (predict + update).
 *
 *   1. prior 부재 또는 Δt > STATE_STALE_THRESHOLD_MS → observation 직접 초기화
 *      (v=gpsAvgKmh, P=R(accuracy), ts=now). 첫 관측의 분산이 prior 부재 시 가장
 *      정확한 사전.
 *   2. 정상 prior → predict → update.
 *
 * 반환된 state는 호출자가 fusedSpeed에 `kalmanKmh = state.v`로 전달하고 KV에 persist.
 */
export function runKalmanStep(inputs: KalmanStepInputs): KalmanState {
  const { prior, gpsAvgKmh, gpsAccuracyMeters, accelMagnitudeStd, now } = inputs;
  if (!prior || now - prior.ts > STATE_STALE_THRESHOLD_MS) {
    return { v: gpsAvgKmh, P: computeNoiseR(gpsAccuracyMeters), ts: now };
  }
  const predicted = predictKalman(prior, accelMagnitudeStd, now);
  return updateKalman(predicted, gpsAvgKmh, gpsAccuracyMeters);
}

/** KV state load — 없거나 invalid JSON이면 null. */
export async function readKalmanState(
  kv: KVNamespace,
  token: string,
): Promise<KalmanState | null> {
  const raw = await kv.get(stateKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isKalmanState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** KV state 저장 — TTL 1h. */
export async function writeKalmanState(
  kv: KVNamespace,
  token: string,
  state: KalmanState,
): Promise<void> {
  await kv.put(stateKey(token), JSON.stringify(state), {
    expirationTtl: STATE_TTL_SEC,
  });
}

/** 명시 삭제 — trip 종료/cleanup 시 사용. */
export async function clearKalmanState(
  kv: KVNamespace,
  token: string,
): Promise<void> {
  await kv.delete(stateKey(token));
}

function stateKey(token: string): string {
  return `${KALMAN_STATE_PREFIX}${token}`;
}

function isKalmanState(value: unknown): value is KalmanState {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    isFiniteNumber(o.v) && isFiniteNumber(o.P) && isFiniteNumber(o.ts)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
