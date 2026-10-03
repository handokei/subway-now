/**
 * #823 — 가속도 raw 샘플 → 1초 window 요약 변환 유틸 (Phase 3 E1).
 *
 * 정책:
 *   - 클라이언트는 100Hz raw 샘플을 backend로 직접 보내지 않는다 (BG 배터리/네트워크 불가).
 *   - 1초 window의 평균/표준편차/피크 magnitude만 backend로 송신 → KV ring buffer 적재 →
 *     E2 Kalman/E3 phase 감지가 입력으로 사용한다.
 *
 * 중력 제거: expo-sensors `Accelerometer`는 g 단위 raw 값(중력 포함)을 반환한다.
 *   1초 window 안에서는 디바이스 자세가 거의 일정하다고 가정하고 window 평균 벡터를 중력으로
 *   간주해 각 sample에서 뺀다 — high-pass filter의 1차 근사(단일 window). 정거장 정차 1~2초
 *   구간에는 충분한 정확도이며, 더 정교한 분리(Kalman, complementary)는 E2 단계로 미룬다.
 *
 * 단위: 입력/출력 모두 **m/s²** (raw g를 GRAVITY_MS2로 곱해 SI로 표준화).
 *   backend KV는 단위 변환 없이 그대로 저장한다.
 *
 * 단순성 (CLAUDE.md §2): raw → summary 변환만 담당. 송신 빈도/시점/네트워크는 호출자 결정.
 */

/** 표준 중력가속도 (m/s²) — 1g를 SI 단위로. */
export const GRAVITY_MS2 = 9.80665;

/**
 * 단일 가속도 raw 샘플. expo-sensors 콜백이 주는 형태.
 * 단위: m/s² (호출자가 g → m/s² 변환 후 전달).
 */
export interface AccelSample {
  /** epoch ms — 디바이스 측정 시각. */
  t: number;
  /** x축 (좌우) */
  x: number;
  /** y축 (상하) */
  y: number;
  /** z축 (전후) */
  z: number;
}

/**
 * 1초 window의 가속도 요약값. backend로 송신 + KV ring buffer 저장 단위.
 * 모든 axis는 중력 제거 후의 **linear acceleration** (m/s²).
 */
export interface AccelSummary {
  /** window 시작 시각 (epoch ms). */
  startTs: number;
  /** window 종료 시각 (epoch ms). */
  endTs: number;
  /** window 내 sample 개수. 미달 시(<MIN_SAMPLES) summary 자체가 만들어지지 않는다. */
  count: number;
  /** linear ax 평균 (m/s²). */
  ax: number;
  /** linear ay 평균 (m/s²). */
  ay: number;
  /** linear az 평균 (m/s²). */
  az: number;
  /** linear magnitude `√(ax²+ay²+az²)` 평균 (m/s²). 정거장 phase 감지의 1차 신호. */
  magnitudeMean: number;
  /** linear magnitude의 표준편차 (m/s²). 도보/지하철 noise 패턴 구분용. */
  magnitudeStd: number;
  /** linear magnitude의 max (m/s²). 출발/감속 피크 감지용. */
  magnitudePeak: number;
}

/**
 * 신뢰할 수 있는 요약을 만들기 위한 최소 sample 수.
 * 100Hz × 1s → 100 정도 기대. 50 미만이면 미정확/누락 큰 window로 보고 폐기.
 */
export const MIN_SAMPLES_FOR_SUMMARY = 50;

/**
 * raw 샘플 배열(g 단위)을 SI(m/s²) 단위 `AccelSample`로 변환.
 *
 * @param raw expo-sensors 형식의 g 단위 sample 배열. 빈 배열은 그대로 반환.
 */
export function toSiSamples(
  raw: readonly { t: number; x: number; y: number; z: number }[],
): AccelSample[] {
  return raw.map((s) => ({
    t: s.t,
    x: s.x * GRAVITY_MS2,
    y: s.y * GRAVITY_MS2,
    z: s.z * GRAVITY_MS2,
  }));
}

/**
 * window 평균 벡터를 중력으로 가정해 각 sample에서 빼서 linear acceleration 추출.
 *
 * 가정: 1초 window 동안 디바이스 자세는 거의 일정 → 평균이 중력 벡터.
 *   - 정거장 정차 1~2초에 충분한 정확도. 빠른 회전 중에는 잔류 노이즈가 남지만 표준편차에 흡수.
 *   - 더 정교한 분리는 E2 Kalman complementary filter에서 처리.
 */
export function removeGravity(samples: readonly AccelSample[]): AccelSample[] {
  if (samples.length === 0) return [];
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (const s of samples) {
    sumX += s.x;
    sumY += s.y;
    sumZ += s.z;
  }
  const meanX = sumX / samples.length;
  const meanY = sumY / samples.length;
  const meanZ = sumZ / samples.length;
  return samples.map((s) => ({
    t: s.t,
    x: s.x - meanX,
    y: s.y - meanY,
    z: s.z - meanZ,
  }));
}

/**
 * linear acceleration window를 backend 송신용 `AccelSummary`로 압축.
 *
 * `MIN_SAMPLES_FOR_SUMMARY` 미만이면 null 반환 — 호출자는 윈도우를 skip하고 다음으로.
 *
 * @param linearSamples 중력이 이미 제거된 sample 배열. 단위 m/s².
 */
export function summarizeLinear(
  linearSamples: readonly AccelSample[],
): AccelSummary | null {
  if (linearSamples.length < MIN_SAMPLES_FOR_SUMMARY) return null;

  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let sumMag = 0;
  let sumMagSq = 0;
  let peakMag = 0;
  for (const s of linearSamples) {
    sumX += s.x;
    sumY += s.y;
    sumZ += s.z;
    const mag = Math.hypot(s.x, s.y, s.z);
    sumMag += mag;
    sumMagSq += mag * mag;
    if (mag > peakMag) peakMag = mag;
  }
  const n = linearSamples.length;
  const meanMag = sumMag / n;
  // 분산은 E[X²] - E[X]² — 부동소수 음수 방지로 max(0) 클램프.
  const variance = Math.max(0, sumMagSq / n - meanMag * meanMag);

  return {
    startTs: linearSamples[0].t,
    endTs: linearSamples[n - 1].t,
    count: n,
    ax: sumX / n,
    ay: sumY / n,
    az: sumZ / n,
    magnitudeMean: meanMag,
    magnitudeStd: Math.sqrt(variance),
    magnitudePeak: peakMag,
  };
}

/**
 * raw g 단위 → SI 변환 → 중력 제거 → 요약까지의 pipeline 1줄.
 * 호출자(useAccelerometer)는 이 함수만 알면 된다.
 */
export function summarizeWindow(
  raw: readonly { t: number; x: number; y: number; z: number }[],
): AccelSummary | null {
  return summarizeLinear(removeGravity(toSiSamples(raw)));
}
