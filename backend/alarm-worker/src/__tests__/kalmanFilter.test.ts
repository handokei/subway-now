/**
 * kalmanFilter.ts 단위 테스트 (#824 Phase 3 E2).
 *
 * 검증 범위:
 *   - computeNoiseR: 4 bands (경계값 포함)
 *   - computeNoiseQ: 3 bands (경계값 포함)
 *   - predictKalman: Δt>0 / Δt=0 / Δt<0 (시계 역행)
 *   - updateKalman: K 산출 + v/P 갱신
 *   - runKalmanStep: prior=null / stale / 정상 / 경계값 (Δt === threshold)
 *   - KV roundtrip: read/write/clear + JSON 오류 + 필드 누락 + NaN/Infinity
 *   - 수치 회귀 (RMSE): Kalman vs 단순 평균
 */

import { describe, expect, it } from 'vitest';
import {
  ACCURACY_R_HIGH_M,
  ACCURACY_R_LOW_M,
  ACCURACY_R_MID_M,
  ACCEL_STD_Q_LOW,
  ACCEL_STD_Q_MID,
  DRIFT_WARNING_THRESHOLD_KMH,
  Q_HIGH,
  Q_LOW,
  Q_MID,
  R_HIGH,
  R_LOW,
  R_MID,
  R_REJECT,
  STATE_STALE_THRESHOLD_MS,
  clearKalmanState,
  computeNoiseQ,
  computeNoiseR,
  detectKalmanDrift,
  predictKalman,
  readKalmanState,
  resetKalmanForArrival,
  runKalmanStep,
  updateKalman,
  writeKalmanState,
  type KalmanState,
} from '../kalmanFilter';
import { InMemoryKV } from './inMemoryKv';

// ─────────────────────────────────────────────────────
// computeNoiseR
// ─────────────────────────────────────────────────────

describe('computeNoiseR — accuracy → 관측 분산 단계 함수', () => {
  it('10m (< 20m) → R_LOW=4', () => {
    expect(computeNoiseR(10)).toBe(R_LOW);
  });

  it('0m (경계 최소) → R_LOW=4', () => {
    expect(computeNoiseR(0)).toBe(R_LOW);
  });

  it('경계값 19.9m (<20m) → R_LOW=4', () => {
    expect(computeNoiseR(19.9)).toBe(R_LOW);
  });

  it(`경계값 ${ACCURACY_R_LOW_M}m (정확히 20m) → R_MID=25`, () => {
    // 20m는 < 20m 조건 불만족 → 다음 band
    expect(computeNoiseR(ACCURACY_R_LOW_M)).toBe(R_MID);
  });

  it('30m (20m ≤ x < 50m) → R_MID=25', () => {
    expect(computeNoiseR(30)).toBe(R_MID);
  });

  it(`경계값 ${ACCURACY_R_MID_M}m (정확히 50m) → R_HIGH=100`, () => {
    expect(computeNoiseR(ACCURACY_R_MID_M)).toBe(R_HIGH);
  });

  it('70m (50m ≤ x < 100m) → R_HIGH=100', () => {
    expect(computeNoiseR(70)).toBe(R_HIGH);
  });

  it(`경계값 ${ACCURACY_R_HIGH_M}m (정확히 100m) → R_REJECT=400`, () => {
    expect(computeNoiseR(ACCURACY_R_HIGH_M)).toBe(R_REJECT);
  });

  it('150m (≥ 100m) → R_REJECT=400', () => {
    expect(computeNoiseR(150)).toBe(R_REJECT);
  });

  it('매우 큰 값 → R_REJECT=400', () => {
    expect(computeNoiseR(9999)).toBe(R_REJECT);
  });
});

// ─────────────────────────────────────────────────────
// computeNoiseQ
// ─────────────────────────────────────────────────────

describe('computeNoiseQ — accel stddev → 프로세스 분산 단계 함수', () => {
  it('0.1 m/s² (< 0.5) → Q_LOW=1', () => {
    expect(computeNoiseQ(0.1)).toBe(Q_LOW);
  });

  it('0.0 (경계 최소) → Q_LOW=1', () => {
    expect(computeNoiseQ(0.0)).toBe(Q_LOW);
  });

  it('경계값 0.49 (< 0.5) → Q_LOW=1', () => {
    expect(computeNoiseQ(0.49)).toBe(Q_LOW);
  });

  it(`경계값 ${ACCEL_STD_Q_LOW} (정확히 0.5) → Q_MID=9`, () => {
    expect(computeNoiseQ(ACCEL_STD_Q_LOW)).toBe(Q_MID);
  });

  it('1.0 m/s² (0.5 ≤ x < 2.0) → Q_MID=9', () => {
    expect(computeNoiseQ(1.0)).toBe(Q_MID);
  });

  it('경계값 1.99 (< 2.0) → Q_MID=9', () => {
    expect(computeNoiseQ(1.99)).toBe(Q_MID);
  });

  it(`경계값 ${ACCEL_STD_Q_MID} (정확히 2.0) → Q_HIGH=36`, () => {
    expect(computeNoiseQ(ACCEL_STD_Q_MID)).toBe(Q_HIGH);
  });

  it('3.0 m/s² (≥ 2.0) → Q_HIGH=36', () => {
    expect(computeNoiseQ(3.0)).toBe(Q_HIGH);
  });

  it('매우 큰 값 → Q_HIGH=36', () => {
    expect(computeNoiseQ(100)).toBe(Q_HIGH);
  });
});

// ─────────────────────────────────────────────────────
// predictKalman
// ─────────────────────────────────────────────────────

describe('predictKalman — constant-velocity predict step', () => {
  const prior: KalmanState = { v: 30, P: 100, ts: 1000 };

  it('Δt > 0: P_pred = P + Q * dtSec, v 유지, ts=now', () => {
    // Δt = 10_000ms = 10s, accelStd=0.1 → Q_LOW=1 → P_pred = 100 + 1*10 = 110
    const result = predictKalman(prior, 0.1, 11_000);
    expect(result.v).toBe(30);
    expect(result.P).toBeCloseTo(110, 5);
    expect(result.ts).toBe(11_000);
  });

  it('Δt > 0: 다른 Q 밴드 (accelStd=1.0 → Q_MID=9)', () => {
    // Δt = 5_000ms = 5s, Q=9 → P_pred = 100 + 9*5 = 145
    const result = predictKalman(prior, 1.0, 6_000);
    expect(result.P).toBeCloseTo(145, 5);
  });

  it('Δt > 0: Q_HIGH 밴드 (accelStd=3.0 → Q_HIGH=36)', () => {
    // Δt = 2_000ms = 2s, Q=36 → P_pred = 100 + 36*2 = 172
    const result = predictKalman(prior, 3.0, 3_000);
    expect(result.P).toBeCloseTo(172, 5);
  });

  it('Δt = 0 → prior 그대로 반환 (시계 동일)', () => {
    const result = predictKalman(prior, 0.1, 1000);
    expect(result).toBe(prior); // 동일 객체 참조
  });

  it('Δt < 0 → prior 그대로 반환 (시계 역행)', () => {
    const result = predictKalman(prior, 0.1, 500);
    expect(result).toBe(prior); // 동일 객체 참조
  });
});

// ─────────────────────────────────────────────────────
// updateKalman
// ─────────────────────────────────────────────────────

describe('updateKalman — Bayesian update step', () => {
  it('P=100, R=100 (accuracy=70m → R_HIGH=100) → K=0.5; z=50, v_pred=30 → v_new=40', () => {
    // accuracy=70m → R=R_HIGH=100
    // K = 100 / (100 + 100) = 0.5
    // v_new = 30 + 0.5 * (50 - 30) = 30 + 10 = 40
    // P_new = (1 - 0.5) * 100 = 50
    const predicted: KalmanState = { v: 30, P: 100, ts: 5000 };
    const result = updateKalman(predicted, 50, 70);
    expect(result.v).toBeCloseTo(40, 5);
    expect(result.P).toBeCloseTo(50, 5);
    expect(result.ts).toBe(5000); // ts는 predicted에서 유지
  });

  it('accuracy < 20m (R=4) → K가 높아 GPS에 강하게 수렴', () => {
    // P=100, R=4 → K = 100/104 ≈ 0.9615
    // v_new ≈ 20 + 0.9615*(60-20) ≈ 20 + 38.46 ≈ 58.46
    const predicted: KalmanState = { v: 20, P: 100, ts: 0 };
    const result = updateKalman(predicted, 60, 10);
    const expectedK = 100 / (100 + R_LOW);
    const expectedV = 20 + expectedK * (60 - 20);
    expect(result.v).toBeCloseTo(expectedV, 4);
    expect(result.P).toBeCloseTo((1 - expectedK) * 100, 4);
  });

  it('accuracy > 100m (R=400) → K가 낮아 prediction 유지', () => {
    // P=100, R=400 → K = 100/500 = 0.2
    // v_new = 30 + 0.2*(80-30) = 30 + 10 = 40
    const predicted: KalmanState = { v: 30, P: 100, ts: 0 };
    const result = updateKalman(predicted, 80, 150);
    const expectedK = 100 / (100 + R_REJECT);
    const expectedV = 30 + expectedK * (80 - 30);
    expect(result.v).toBeCloseTo(expectedV, 4);
  });

  it('P=0 → K=0, v_new = v_pred (완전 신뢰 prediction)', () => {
    // K = 0 / (0 + R) = 0
    const predicted: KalmanState = { v: 25, P: 0, ts: 0 };
    const result = updateKalman(predicted, 60, 30);
    expect(result.v).toBeCloseTo(25, 5);
    expect(result.P).toBeCloseTo(0, 5);
  });
});

// ─────────────────────────────────────────────────────
// runKalmanStep
// ─────────────────────────────────────────────────────

describe('runKalmanStep — predict + update 통합', () => {
  const now = 1_000_000;

  it('prior=null → observation 직접 초기화 (v=gpsAvgKmh, P=R(accuracy), ts=now)', () => {
    const result = runKalmanStep({
      prior: null,
      gpsAvgKmh: 35,
      gpsAccuracyMeters: 10,
      accelMagnitudeStd: 0.1,
      now,
    });
    expect(result).not.toBeNull();
    expect(result!.v).toBe(35);
    expect(result!.P).toBe(R_LOW); // accuracy=10 → R_LOW=4
    expect(result!.ts).toBe(now);
  });

  it('prior=null + accuracy=50m → P=R_HIGH=100', () => {
    const result = runKalmanStep({
      prior: null,
      gpsAvgKmh: 20,
      gpsAccuracyMeters: 50,
      accelMagnitudeStd: 0.5,
      now,
    });
    expect(result!.P).toBe(R_HIGH); // accuracy=50 → R_HIGH=100
  });

  it('stale prior (Δt > STATE_STALE_THRESHOLD_MS) → observation 직접 초기화', () => {
    const stale: KalmanState = {
      v: 10,
      P: 50,
      ts: now - STATE_STALE_THRESHOLD_MS - 1, // 1ms 초과
    };
    const result = runKalmanStep({
      prior: stale,
      gpsAvgKmh: 40,
      gpsAccuracyMeters: 10,
      accelMagnitudeStd: 0.1,
      now,
    });
    expect(result!.v).toBe(40);
    expect(result!.P).toBe(R_LOW);
    expect(result!.ts).toBe(now);
  });

  it('경계값: Δt === STATE_STALE_THRESHOLD_MS → predict+update 실행 (stale 아님)', () => {
    // Δt = STATE_STALE_THRESHOLD_MS이면 now - prior.ts = threshold 이므로
    // > threshold 조건 불만족 → 정상 predict + update
    const prior: KalmanState = {
      v: 20,
      P: 50,
      ts: now - STATE_STALE_THRESHOLD_MS,
    };
    const result = runKalmanStep({
      prior,
      gpsAvgKmh: 30,
      gpsAccuracyMeters: 10,
      accelMagnitudeStd: 0.1,
      now,
    });
    // predict: P_pred = 50 + Q_LOW * dtSec
    const dtSec = STATE_STALE_THRESHOLD_MS / 1000;
    const pPred = 50 + Q_LOW * dtSec;
    // update: K = P_pred / (P_pred + R_LOW)
    const k = pPred / (pPred + R_LOW);
    const vExpected = 20 + k * (30 - 20);
    expect(result!.v).toBeCloseTo(vExpected, 4);
    // observation 직접 초기화가 아님 (v ≠ gpsAvgKmh=30 이여야 함, 블렌딩 값)
    expect(result!.v).not.toBe(30);
  });

  it('정상 prior → predict → update 결합 결과', () => {
    // prior: v=20, P=100, ts=now-10_000
    // accelStd=0.1 → Q=1, Δt=10s → P_pred=100+10=110
    // gpsAccuracy=30 → R=25, K=110/135, v_new = 20 + K*(40-20)
    const prior: KalmanState = { v: 20, P: 100, ts: now - 10_000 };
    const result = runKalmanStep({
      prior,
      gpsAvgKmh: 40,
      gpsAccuracyMeters: 30,
      accelMagnitudeStd: 0.1,
      now,
    });
    const dtSec = 10;
    const pPred = 100 + Q_LOW * dtSec;
    const k = pPred / (pPred + R_MID);
    const vExpected = 20 + k * (40 - 20);
    expect(result!.v).toBeCloseTo(vExpected, 4);
    expect(result!.ts).toBe(now);
  });

  // ─────────────────────────────────────────────────────
  // #2007 archFlag guard (ADR-022 Phase 4-5)
  // ─────────────────────────────────────────────────────

  it('#2007 — archFlag="on" → null (계산 skip, prior/observation 무관)', () => {
    const prior: KalmanState = { v: 20, P: 100, ts: now - 10_000 };
    const result = runKalmanStep(
      {
        prior,
        gpsAvgKmh: 40,
        gpsAccuracyMeters: 10,
        accelMagnitudeStd: 0.1,
        now,
      },
      'on',
    );
    expect(result).toBeNull();
  });

  it('#2007 — archFlag="on" + prior=null 도 null (초기화 자체를 skip)', () => {
    const result = runKalmanStep(
      {
        prior: null,
        gpsAvgKmh: 35,
        gpsAccuracyMeters: 10,
        accelMagnitudeStd: 0.1,
        now,
      },
      'on',
    );
    expect(result).toBeNull();
  });

  it('#2007 — archFlag="off" → 기존 동작 유지 (dormant 아님)', () => {
    const result = runKalmanStep(
      {
        prior: null,
        gpsAvgKmh: 35,
        gpsAccuracyMeters: 10,
        accelMagnitudeStd: 0.1,
        now,
      },
      'off',
    );
    expect(result).not.toBeNull();
    expect(result!.v).toBe(35);
  });

  it('#2007 — archFlag=undefined (legacy caller) → 기존 동작 유지', () => {
    const result = runKalmanStep(
      {
        prior: null,
        gpsAvgKmh: 42,
        gpsAccuracyMeters: 10,
        accelMagnitudeStd: 0.1,
        now,
      },
      undefined,
    );
    expect(result).not.toBeNull();
    expect(result!.v).toBe(42);
  });
});

// ─────────────────────────────────────────────────────
// KV roundtrip
// ─────────────────────────────────────────────────────

describe('readKalmanState / writeKalmanState / clearKalmanState — KV 입출력', () => {
  it('write → read 시 동일 state 복원', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const state: KalmanState = { v: 35.5, P: 42.0, ts: 1_700_000_000_000 };
    await writeKalmanState(kv, 'tok1', state);
    const loaded = await readKalmanState(kv, 'tok1');
    expect(loaded).toEqual(state);
  });

  it('clear → read 시 null 반환', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const state: KalmanState = { v: 10, P: 5, ts: 1000 };
    await writeKalmanState(kv, 'tok2', state);
    await clearKalmanState(kv, 'tok2');
    expect(await readKalmanState(kv, 'tok2')).toBeNull();
  });

  it('KV에 데이터 없으면 null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    expect(await readKalmanState(kv, 'nonexistent')).toBeNull();
  });

  it('JSON parse 실패 → null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await (kv as unknown as InMemoryKV).put('kalman:tok3', 'not-valid-json');
    expect(await readKalmanState(kv, 'tok3')).toBeNull();
  });

  it('배열 저장 → null (객체가 아님)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await (kv as unknown as InMemoryKV).put('kalman:tok4', JSON.stringify([1, 2, 3]));
    expect(await readKalmanState(kv, 'tok4')).toBeNull();
  });

  it('null 저장 → null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await (kv as unknown as InMemoryKV).put('kalman:tok5', JSON.stringify(null));
    expect(await readKalmanState(kv, 'tok5')).toBeNull();
  });

  it('v 필드 누락 → null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await (kv as unknown as InMemoryKV).put('kalman:tok6', JSON.stringify({ P: 10, ts: 1000 }));
    expect(await readKalmanState(kv, 'tok6')).toBeNull();
  });

  it('P 필드 누락 → null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await (kv as unknown as InMemoryKV).put('kalman:tok7', JSON.stringify({ v: 30, ts: 1000 }));
    expect(await readKalmanState(kv, 'tok7')).toBeNull();
  });

  it('ts 필드 누락 → null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await (kv as unknown as InMemoryKV).put('kalman:tok8', JSON.stringify({ v: 30, P: 10 }));
    expect(await readKalmanState(kv, 'tok8')).toBeNull();
  });

  it('v=NaN → null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    // JSON.stringify(NaN)은 'null'이므로 직접 문자열로 삽입
    await (kv as unknown as InMemoryKV).put('kalman:tok9', '{"v":null,"P":10,"ts":1000}');
    expect(await readKalmanState(kv, 'tok9')).toBeNull();
  });

  it('P=Infinity → null (isFiniteNumber 실패)', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    // JSON에서 Infinity는 직접 표현 불가 → 문자열로 삽입
    await (kv as unknown as InMemoryKV).put(
      'kalman:tok10',
      '{"v":30,"P":1e+9999,"ts":1000}',
    );
    // 1e+9999는 Infinity로 파싱되므로 isFiniteNumber 실패 → null
    expect(await readKalmanState(kv, 'tok10')).toBeNull();
  });

  it('ts=NaN (문자열) → null', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    await (kv as unknown as InMemoryKV).put(
      'kalman:tok11',
      '{"v":30,"P":10,"ts":"not-a-number"}',
    );
    expect(await readKalmanState(kv, 'tok11')).toBeNull();
  });

  it('서로 다른 token은 독립적으로 저장/조회됨', async () => {
    const kv = new InMemoryKV() as unknown as KVNamespace;
    const s1: KalmanState = { v: 10, P: 5, ts: 100 };
    const s2: KalmanState = { v: 50, P: 20, ts: 200 };
    await writeKalmanState(kv, 'alice', s1);
    await writeKalmanState(kv, 'bob', s2);
    expect(await readKalmanState(kv, 'alice')).toEqual(s1);
    expect(await readKalmanState(kv, 'bob')).toEqual(s2);
  });
});

// ─────────────────────────────────────────────────────
// DRIFT_WARNING_THRESHOLD_KMH 상수
// ─────────────────────────────────────────────────────

describe('DRIFT_WARNING_THRESHOLD_KMH 상수 (#826 E4)', () => {
  it('DRIFT_WARNING_THRESHOLD_KMH === 15', () => {
    expect(DRIFT_WARNING_THRESHOLD_KMH).toBe(15);
  });
});

// ─────────────────────────────────────────────────────
// resetKalmanForArrival
// ─────────────────────────────────────────────────────

describe('resetKalmanForArrival — 정거장 도착 ground truth hard reset (#826 E4)', () => {
  it('now=1000 → { v: 0, P: R_LOW(=4), ts: 1000, lastResetTs: 1000 }', () => {
    const result = resetKalmanForArrival(1000);
    // #837 P2-2 — lastResetTs stamp는 drift grace window 활성화 입력.
    expect(result).toEqual({ v: 0, P: R_LOW, ts: 1000, lastResetTs: 1000 });
  });

  it('now=0 → ts=0, v=0, P=R_LOW, lastResetTs=0', () => {
    const result = resetKalmanForArrival(0);
    expect(result.v).toBe(0);
    expect(result.P).toBe(R_LOW);
    expect(result.ts).toBe(0);
    expect(result.lastResetTs).toBe(0);
  });

  it('큰 ts 값도 그대로 반영 (ts와 lastResetTs 동일)', () => {
    const ts = 1_700_000_000_000;
    const result = resetKalmanForArrival(ts);
    expect(result.ts).toBe(ts);
    expect(result.v).toBe(0);
    expect(result.P).toBe(R_LOW);
    expect(result.lastResetTs).toBe(ts);
  });

  it('v는 항상 0 — 어떤 now에서도 불변', () => {
    [100, 5_000, 9_999_999].forEach((now) => {
      expect(resetKalmanForArrival(now).v).toBe(0);
    });
  });

  it('P는 항상 R_LOW(=4) — 어떤 now에서도 불변', () => {
    [1, 500, 1_000_000].forEach((now) => {
      expect(resetKalmanForArrival(now).P).toBe(R_LOW);
    });
  });

  it('매 호출마다 새 객체를 반환 (객체 동일성 아님)', () => {
    const a = resetKalmanForArrival(1000);
    const b = resetKalmanForArrival(1000);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ─────────────────────────────────────────────────────
// detectKalmanDrift
// ─────────────────────────────────────────────────────

describe('detectKalmanDrift — drift 측정 (#826 E4)', () => {
  const makeState = (v: number): KalmanState => ({ v, P: 10, ts: 1000 });

  it('state.v=20, gpsAvg=5 → delta=15, warning=true (정확히 임계)', () => {
    const result = detectKalmanDrift(makeState(20), 5);
    expect(result.delta).toBe(15);
    expect(result.warning).toBe(true);
  });

  it('state.v=10, gpsAvg=5 → delta=5, warning=false (임계 미달)', () => {
    const result = detectKalmanDrift(makeState(10), 5);
    expect(result.delta).toBe(5);
    expect(result.warning).toBe(false);
  });

  it('state.v=5, gpsAvg=25 → delta=-20, warning=true (음수 delta, 절댓값 임계 초과)', () => {
    const result = detectKalmanDrift(makeState(5), 25);
    expect(result.delta).toBe(-20);
    expect(result.warning).toBe(true);
  });

  it('state.v=gpsAvg → delta=0, warning=false', () => {
    const result = detectKalmanDrift(makeState(30), 30);
    expect(result.delta).toBe(0);
    expect(result.warning).toBe(false);
  });

  it('경계값: |delta| = 14.99 → warning=false', () => {
    // state.v=19.99, gpsAvg=5 → delta=14.99
    const result = detectKalmanDrift(makeState(19.99), 5);
    expect(Math.abs(result.delta)).toBeCloseTo(14.99, 5);
    expect(result.warning).toBe(false);
  });

  it('경계값: |delta| = 15 → warning=true', () => {
    const result = detectKalmanDrift(makeState(20), 5);
    expect(Math.abs(result.delta)).toBe(15);
    expect(result.warning).toBe(true);
  });

  it('경계값: |delta| = 15.01 → warning=true', () => {
    const result = detectKalmanDrift(makeState(20.01), 5);
    expect(result.warning).toBe(true);
  });

  it('delta는 signed: state.v - gpsAvgKmh (음수 포함)', () => {
    // state.v=10, gpsAvg=30 → delta = -20
    const result = detectKalmanDrift(makeState(10), 30);
    expect(result.delta).toBe(-20);
  });
});

// ─────────────────────────────────────────────────────
// 수치 회귀 (RMSE) 골든 케이스
// ─────────────────────────────────────────────────────

describe('수치 회귀 — Kalman RMSE vs 단순 평균', () => {
  /**
   * 결정론적 "노이즈 추가" GPS 시뮬레이션.
   * trueSpeed에 sin 기반 deterministic noise를 추가한다 (Math.random 대신).
   * noise amplitude는 σ에 해당하는 피크 진폭으로 설정.
   */
  function simulateGpsSeries(opts: {
    trueSpeedKmh: number;
    noiseAmplitude: number;
    count: number;
    startTs: number;
    dtMs: number;
  }): Array<{ ts: number; v: number }> {
    const { trueSpeedKmh, noiseAmplitude, count, startTs, dtMs } = opts;
    return Array.from({ length: count }, (_, i) => ({
      ts: startTs + i * dtMs,
      // sin 기반 결정론적 노이즈 (i에 따라 변화하는 패턴)
      v: trueSpeedKmh + noiseAmplitude * Math.sin(i * 0.7),
    }));
  }

  function rmse(predictions: number[], truth: number): number {
    const mse = predictions.reduce((sum, p) => sum + (p - truth) ** 2, 0) / predictions.length;
    return Math.sqrt(mse);
  }

  it('정속 시나리오: Kalman RMSE ≤ 단순 평균 RMSE (노이즈 평활화 효과)', () => {
    const TRUE_SPEED = 30; // km/h
    const NOISE_AMP = 5;   // 피크 amplitude ≈ σ
    const COUNT = 60;
    const START_TS = 1_700_000_000_000;
    const DT_MS = 1000; // 1s 간격

    const samples = simulateGpsSeries({
      trueSpeedKmh: TRUE_SPEED,
      noiseAmplitude: NOISE_AMP,
      count: COUNT,
      startTs: START_TS,
      dtMs: DT_MS,
    });

    // Kalman filter 순차 처리
    let state: KalmanState | null = null;
    const kalmanResults: number[] = [];
    const rawResults: number[] = [];

    for (const s of samples) {
      state = runKalmanStep({
        prior: state,
        gpsAvgKmh: s.v,
        gpsAccuracyMeters: 15, // 15m → R_LOW=4 (좋은 GPS)
        accelMagnitudeStd: 0.1, // 정속 → Q_LOW=1
        now: s.ts,
      });
      // archFlag 미전달 시 runKalmanStep 은 항상 non-null 반환.
      kalmanResults.push(state!.v);
      rawResults.push(s.v);
    }

    const kalmanRmse = rmse(kalmanResults, TRUE_SPEED);
    const rawRmse = rmse(rawResults, TRUE_SPEED);

    // Kalman이 단순 raw보다 RMSE가 작거나 같아야 함
    expect(kalmanRmse).toBeLessThanOrEqual(rawRmse + 0.01); // 수치 오차 허용
  });

  it('정차 → 정속 시나리오: 감속 구간에서 Kalman이 안정적으로 수렴', () => {
    // 처음 30s: 30 km/h 정속 → 다음 30s: 0 km/h (정차)
    const START_TS = 2_000_000_000_000;
    const PHASE1_TRUE = 30;
    const PHASE2_TRUE = 0;

    const phase1Samples = simulateGpsSeries({
      trueSpeedKmh: PHASE1_TRUE,
      noiseAmplitude: 3,
      count: 30,
      startTs: START_TS,
      dtMs: 1000,
    });
    const phase2Samples = simulateGpsSeries({
      trueSpeedKmh: PHASE2_TRUE,
      noiseAmplitude: 1,
      count: 30,
      startTs: START_TS + 30_000,
      dtMs: 1000,
    });

    const allSamples = [...phase1Samples, ...phase2Samples];

    let state: KalmanState | null = null;
    const kalmanResults: number[] = [];
    const rawResults: number[] = [];

    for (const s of allSamples) {
      state = runKalmanStep({
        prior: state,
        gpsAvgKmh: s.v,
        gpsAccuracyMeters: 15,
        accelMagnitudeStd: 0.3,
        now: s.ts,
      });
      // archFlag 미전달 시 runKalmanStep 은 항상 non-null 반환.
      kalmanResults.push(state!.v);
      rawResults.push(s.v);
    }

    // phase2(정차)의 마지막 10 sample 기준 RMSE
    const kalmanPhase2 = kalmanResults.slice(50);
    const rawPhase2 = rawResults.slice(50);
    const kalmanRmse = rmse(kalmanPhase2, PHASE2_TRUE);
    const rawRmse = rmse(rawPhase2, PHASE2_TRUE);

    // 정차 구간에서 Kalman은 raw보다 크지 않거나 비슷해야 한다 (smoothing 효과)
    // Kalman은 prior를 유지하므로 약간 더 클 수 있지만, raw의 2배를 넘지 않아야 함
    expect(kalmanRmse).toBeLessThan(rawRmse * 2 + 1);
    // phase2의 마지막 시점에서 state.v는 유한수여야 함
    expect(Number.isFinite(state!.v)).toBe(true);
  });
});
