/**
 * #2594 (옵션 D) — 재평가 빈도 계측 단위 테스트.
 *
 * 검증:
 *   1. gpsFix/candidatesRecompute 순수 rate tracker (avg/min/max/perSecond, ring capacity=20).
 *   2. candidateDistance/candidateEnv "발화당 reject 수" 분해(avgRejectPerFire).
 *   3. 표본 부족(0~1개) graceful null.
 *   4. resetReevalInstrumentationForTest로 테스트 간 격리.
 */
import {
  getReevalInstrumentationSnapshot,
  recordCandidateDistanceFire,
  recordCandidateEnvFire,
  recordCandidatesRecompute,
  recordGpsFixArrival,
  resetReevalInstrumentationForTest,
} from '../reevalInstrumentation';

describe('reevalInstrumentation (#2594 옵션 D)', () => {
  beforeEach(() => {
    resetReevalInstrumentationForTest();
  });

  it('표본 0개 — 모든 rate 필드 null, fireTotal/rejectTotal 0', () => {
    const snap = getReevalInstrumentationSnapshot();
    expect(snap.gpsFix).toEqual({
      sampleCount: 0,
      avgIntervalMs: null,
      minIntervalMs: null,
      maxIntervalMs: null,
      perSecond: null,
    });
    expect(snap.candidatesRecompute.sampleCount).toBe(0);
    expect(snap.candidateDistance).toMatchObject({
      fireTotal: 0,
      rejectTotal: 0,
      avgRejectPerFire: null,
    });
    expect(snap.candidateEnv).toMatchObject({
      fireTotal: 0,
      rejectTotal: 0,
      avgRejectPerFire: null,
    });
  });

  it('표본 1개 — rate는 여전히 null(간격 계산 불가)이지만 sampleCount=1', () => {
    recordGpsFixArrival(1000);
    const snap = getReevalInstrumentationSnapshot();
    expect(snap.gpsFix.sampleCount).toBe(1);
    expect(snap.gpsFix.avgIntervalMs).toBeNull();
    expect(snap.gpsFix.perSecond).toBeNull();
  });

  it('gpsFix — 균일 간격 250ms(=4Hz) 5건 기록 시 avg/min/max/perSecond 정확히 산출', () => {
    recordGpsFixArrival(0);
    recordGpsFixArrival(250);
    recordGpsFixArrival(500);
    recordGpsFixArrival(750);
    recordGpsFixArrival(1000);
    const { gpsFix } = getReevalInstrumentationSnapshot();
    expect(gpsFix.sampleCount).toBe(5);
    expect(gpsFix.avgIntervalMs).toBe(250);
    expect(gpsFix.minIntervalMs).toBe(250);
    expect(gpsFix.maxIntervalMs).toBe(250);
    expect(gpsFix.perSecond).toBe(4);
  });

  it('gpsFix — 불균일 간격(burst 후 idle)에서 min/max가 실제 최소/최대를 반영', () => {
    recordGpsFixArrival(0);
    recordGpsFixArrival(30); // burst: 30ms
    recordGpsFixArrival(60); // burst: 30ms
    recordGpsFixArrival(2060); // idle: 2000ms
    const { gpsFix } = getReevalInstrumentationSnapshot();
    expect(gpsFix.minIntervalMs).toBe(30);
    expect(gpsFix.maxIntervalMs).toBe(2000);
    expect(gpsFix.avgIntervalMs).toBeCloseTo((30 + 30 + 2000) / 3);
  });

  it('ring capacity=20 — 오래된 timestamp는 밀려나 최근 20건 구간만 반영', () => {
    // 처음 10건은 매우 넓은 간격(1000ms)으로, 이후 15건은 좁은 간격(100ms)으로 기록.
    // capacity=20이면 최근 20건만 남아, 넓은 간격 구간 일부가 밀려나야 avg가 100ms에 가까워진다.
    for (let i = 0; i < 10; i += 1) recordGpsFixArrival(i * 1000);
    for (let i = 0; i < 15; i += 1) recordGpsFixArrival(10_000 + i * 100);
    const { gpsFix } = getReevalInstrumentationSnapshot();
    expect(gpsFix.sampleCount).toBe(20);
    // 처음 5건(0~4000ms)이 밀려나 남은 20건은 [5000,6000,7000,8000,9000, 10000,10100..11400].
    // 19개 간격 = 1000ms×5(5000→10000 사이) + 100ms×14(10000→11400 사이) = 6400ms 합.
    expect(gpsFix.avgIntervalMs).toBeCloseTo(6400 / 19);
    expect(gpsFix.minIntervalMs).toBe(100);
    expect(gpsFix.maxIntervalMs).toBe(1000);
  });

  it('gpsFix — 동일 timestamp 반복(delta=0)이면 avgIntervalMs=0이라 perSecond는 null', () => {
    recordGpsFixArrival(1000);
    recordGpsFixArrival(1000);
    recordGpsFixArrival(1000);
    const { gpsFix } = getReevalInstrumentationSnapshot();
    expect(gpsFix.avgIntervalMs).toBe(0);
    expect(gpsFix.perSecond).toBeNull();
  });

  it('candidatesRecompute — 독립 tracker, gpsFix와 섞이지 않음', () => {
    recordGpsFixArrival(0);
    recordGpsFixArrival(100);
    recordCandidatesRecompute(0);
    recordCandidatesRecompute(500);
    const snap = getReevalInstrumentationSnapshot();
    expect(snap.gpsFix.avgIntervalMs).toBe(100);
    expect(snap.candidatesRecompute.avgIntervalMs).toBe(500);
  });

  it('candidateDistance — 발화 3회(reject 5,0,3건)에 avgRejectPerFire=8/3', () => {
    recordCandidateDistanceFire(5, 0);
    recordCandidateDistanceFire(0, 100);
    recordCandidateDistanceFire(3, 200);
    const { candidateDistance } = getReevalInstrumentationSnapshot();
    expect(candidateDistance.fireTotal).toBe(3);
    expect(candidateDistance.rejectTotal).toBe(8);
    expect(candidateDistance.avgRejectPerFire).toBeCloseTo(8 / 3);
    // fire 자체의 rate도 함께 노출(재평가 빈도).
    expect(candidateDistance.sampleCount).toBe(3);
    expect(candidateDistance.avgIntervalMs).toBe(100);
  });

  it('candidateEnv — candidateDistance와 완전히 독립된 누적', () => {
    recordCandidateDistanceFire(10, 0);
    recordCandidateEnvFire(2, 0);
    recordCandidateEnvFire(4, 100);
    const snap = getReevalInstrumentationSnapshot();
    expect(snap.candidateDistance.fireTotal).toBe(1);
    expect(snap.candidateDistance.rejectTotal).toBe(10);
    expect(snap.candidateEnv.fireTotal).toBe(2);
    expect(snap.candidateEnv.rejectTotal).toBe(6);
    expect(snap.candidateEnv.avgRejectPerFire).toBe(3);
  });

  it('resetReevalInstrumentationForTest — 모든 tracker/누적값 완전 초기화', () => {
    recordGpsFixArrival(0);
    recordGpsFixArrival(100);
    recordCandidatesRecompute(0);
    recordCandidateDistanceFire(5, 0);
    recordCandidateEnvFire(2, 0);
    resetReevalInstrumentationForTest();
    const snap = getReevalInstrumentationSnapshot();
    expect(snap.gpsFix.sampleCount).toBe(0);
    expect(snap.candidatesRecompute.sampleCount).toBe(0);
    expect(snap.candidateDistance.fireTotal).toBe(0);
    expect(snap.candidateEnv.fireTotal).toBe(0);
  });

  it('기본 인자(ts 생략) — Date.now() 기준으로 기록됨(예외 없이 동작)', () => {
    expect(() => recordGpsFixArrival()).not.toThrow();
    expect(() => recordCandidatesRecompute()).not.toThrow();
    expect(() => recordCandidateDistanceFire(0)).not.toThrow();
    expect(() => recordCandidateEnvFire(0)).not.toThrow();
    const snap = getReevalInstrumentationSnapshot();
    expect(snap.gpsFix.sampleCount).toBe(1);
  });
});
