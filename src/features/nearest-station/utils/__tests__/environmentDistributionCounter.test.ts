/**
 * #1430 — 환경 분포 측정 인프라 단위 테스트.
 *
 * State 4종 누적 정확성 + 전환 카운트 + 진행분 포함 snapshot + observedMs=0 시 percentage 0%.
 */

import {
  createEnvironmentDistributionCounter,
  type EnvironmentDistributionSnapshot,
} from '../environmentDistributionCounter';

const T0 = 1_700_000_000_000;

describe('createEnvironmentDistributionCounter', () => {
  it('첫 snapshot은 totals/transitions/observedMs 모두 0', () => {
    const counter = createEnvironmentDistributionCounter();
    const snap = counter.snapshot(T0);
    expect(snap.totals).toEqual({ surface: 0, underground: 0, hybrid: 0, unknown: 0 });
    expect(snap.percentages).toEqual({ surface: 0, underground: 0, hybrid: 0, unknown: 0 });
    expect(snap.transitions).toBe(0);
    expect(snap.observedMs).toBe(0);
  });

  it('첫 tick은 진입 기록만 — 누적 없음, transitions=0', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    const snap = counter.snapshot(T0);
    expect(snap.totals.surface).toBe(0);
    expect(snap.transitions).toBe(0);
  });

  it('동일 state 연속 tick → 누적만, transitions=0', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    counter.tick('surface', T0 + 1000);
    counter.tick('surface', T0 + 3000);
    const snap = counter.snapshot(T0 + 3000);
    expect(snap.totals.surface).toBe(3000);
    expect(snap.totals.underground).toBe(0);
    expect(snap.transitions).toBe(0);
    expect(snap.observedMs).toBe(3000);
  });

  it('state 전환 시 transitions++ 및 누적 정확성', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    counter.tick('underground', T0 + 2000); // surface 누적 2000
    counter.tick('underground', T0 + 5000); // underground 누적 3000
    counter.tick('surface', T0 + 9000); // underground 추가 4000
    const snap = counter.snapshot(T0 + 10_000); // surface 추가 1000
    expect(snap.totals.surface).toBe(3000);
    expect(snap.totals.underground).toBe(7000);
    expect(snap.transitions).toBe(2);
    expect(snap.observedMs).toBe(10_000);
  });

  it('unknown 경유 transition도 카운트에 포함 (단순 정책)', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    counter.tick('unknown', T0 + 1000); // +1
    counter.tick('underground', T0 + 2000); // +1
    const snap = counter.snapshot(T0 + 3000);
    expect(snap.transitions).toBe(2);
    expect(snap.totals.surface).toBe(1000);
    expect(snap.totals.unknown).toBe(1000);
    expect(snap.totals.underground).toBe(1000);
  });

  it('hybrid state도 동등하게 누적', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('hybrid', T0);
    counter.tick('hybrid', T0 + 5000);
    const snap = counter.snapshot(T0 + 5000);
    expect(snap.totals.hybrid).toBe(5000);
    expect(snap.observedMs).toBe(5000);
  });

  it('snapshot 시 현재 state 진행분 포함', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    // tick 호출 없이 snapshot 시각이 6000 후
    const snap = counter.snapshot(T0 + 6000);
    expect(snap.totals.surface).toBe(6000);
    expect(snap.observedMs).toBe(6000);
  });

  it('snapshot 호출이 내부 totals를 변경하지 않는다 (재호출 동일)', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    const a = counter.snapshot(T0 + 1000);
    const b = counter.snapshot(T0 + 1000);
    expect(a.totals.surface).toBe(1000);
    expect(b.totals.surface).toBe(1000);
  });

  it('percentages: 단일 state 100%', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    counter.tick('surface', T0 + 1000);
    const snap = counter.snapshot(T0 + 1000);
    expect(snap.percentages.surface).toBe(100);
    expect(snap.percentages.underground).toBe(0);
    expect(snap.percentages.hybrid).toBe(0);
    expect(snap.percentages.unknown).toBe(0);
  });

  it('percentages: 분포 합=100%', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    counter.tick('underground', T0 + 2500); // surface 2500
    counter.tick('hybrid', T0 + 5000); // underground 2500
    counter.tick('unknown', T0 + 7500); // hybrid 2500
    const snap = counter.snapshot(T0 + 10_000); // unknown 2500
    const pctSum =
      snap.percentages.surface +
      snap.percentages.underground +
      snap.percentages.hybrid +
      snap.percentages.unknown;
    expect(pctSum).toBeCloseTo(100, 5);
    expect(snap.percentages.surface).toBeCloseTo(25, 5);
  });

  it('percentages: observedMs=0이면 모두 0%', () => {
    const counter = createEnvironmentDistributionCounter();
    const snap = counter.snapshot(T0);
    expect(snap.percentages.surface).toBe(0);
    expect(snap.percentages.underground).toBe(0);
    expect(snap.percentages.hybrid).toBe(0);
    expect(snap.percentages.unknown).toBe(0);
    expect(snap.observedMs).toBe(0);
  });

  it('snapshot 시각이 lastTickMs와 같으면 진행분 0 (방어)', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    const snap = counter.snapshot(T0);
    expect(snap.totals.surface).toBe(0);
    expect(snap.observedMs).toBe(0);
  });

  it('snapshot 시각이 lastTickMs보다 작아도 진행분 0 (방어 — 비정상 입력)', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0 + 5000);
    const snap = counter.snapshot(T0);
    expect(snap.totals.surface).toBe(0);
  });

  it('tick 시각이 lastTickMs보다 작아도 누적 0 (방어 — 시계 역행)', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0 + 5000);
    counter.tick('underground', T0); // backwards
    const snap = counter.snapshot(T0 + 10_000);
    // surface 누적은 0 (시계 역행 보호) — underground 신호 진입 후 10s 진행분만 카운트.
    expect(snap.totals.surface).toBe(0);
    expect(snap.totals.underground).toBe(10_000);
    expect(snap.transitions).toBe(1);
  });

  it('동일 시각 연속 tick (시계 정지) → 누적 0, transitions=0', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    counter.tick('surface', T0);
    const snap = counter.snapshot(T0);
    expect(snap.totals.surface).toBe(0);
    expect(snap.transitions).toBe(0);
  });

  it('snapshot return은 EnvironmentDistributionSnapshot 형태', () => {
    const counter = createEnvironmentDistributionCounter();
    counter.tick('surface', T0);
    const snap: EnvironmentDistributionSnapshot = counter.snapshot(T0 + 1000);
    // 컴파일 타임 타입 보장 + 런타임 키 존재 확인.
    expect(Object.keys(snap.totals).sort((a, b) => a.localeCompare(b))).toEqual(
      ['hybrid', 'surface', 'underground', 'unknown'],
    );
    expect(Object.keys(snap.percentages).sort((a, b) => a.localeCompare(b))).toEqual(
      ['hybrid', 'surface', 'underground', 'unknown'],
    );
    expect(typeof snap.transitions).toBe('number');
    expect(typeof snap.observedMs).toBe('number');
  });
});
