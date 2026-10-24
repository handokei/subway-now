import { describe, expect, it } from 'vitest';
import {
  computeCandidateWindow,
  DEMOTE_MISMATCH_STREAK,
  initLegConsensus,
  isDepartureEligible,
  MISSED_TICK_MISMATCH_COUNT,
  stepLegConsensus,
  SUPPRESS_HOPS_TO_TERMINUS,
  type LegConsensusRecord,
} from '../transferLegConsensus';

// 08-12 저녁 페이퍼 시뮬레이션 (design SSoT #2323 코멘트 (7)): W=278s(건대입구 2→7),
// H=210s, hop 80s×4. T0=epoch 0 기준으로 상대 offset만 사용(절대 시각 무관, 순수 엔진).
const T0 = 0;
const TRANSFER_TIME_SEC = 278;
const HEADWAY_SEC = 210;
const HOP_MS = 80_000;

describe('computeCandidateWindow / isDepartureEligible', () => {
  it('core 창 = [T0+W, T0+W+H], 허용 범위 = [T0+0.5W, T0+1.5W+H]', () => {
    const window = computeCandidateWindow(T0, TRANSFER_TIME_SEC, HEADWAY_SEC);
    expect(window.coreStartEpochMs).toBe(278_000);
    expect(window.coreEndEpochMs).toBe(488_000);
    expect(window.earliestAllowedEpochMs).toBe(139_000);
    expect(window.latestAllowedEpochMs).toBe(627_000);
  });

  it('0.5W 이전 출발(앞차/반대방향) → hard reject', () => {
    const window = computeCandidateWindow(T0, TRANSFER_TIME_SEC, HEADWAY_SEC);
    expect(isDepartureEligible(window, 100_000)).toBe(false);
  });

  it('1.5W+H 이후 출발 → hard reject', () => {
    const window = computeCandidateWindow(T0, TRANSFER_TIME_SEC, HEADWAY_SEC);
    expect(isDepartureEligible(window, 950_000)).toBe(false);
  });

  it('core 창 내부 출발 → eligible', () => {
    const window = computeCandidateWindow(T0, TRANSFER_TIME_SEC, HEADWAY_SEC);
    expect(isDepartureEligible(window, 300_000)).toBe(true);
  });
});

describe('initLegConsensus', () => {
  it('단일 eligible 후보 → tracking', () => {
    const record = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: '장암행-1', departureEpochMs: 300_000 }],
      T0,
    );
    expect(record.status).toBe('tracking');
    expect(record.candidates).toHaveLength(1);
  });

  it('0.5W 이전 출발 후보 → 후보 자체가 필터링(candidates 0)', () => {
    const record = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: '앞차', departureEpochMs: 100_000 }],
      T0,
    );
    expect(record.candidates).toHaveLength(0);
    expect(record.status).toBe('tracking');
  });

  it('동시 창 2 eligible 후보 → ambiguous', () => {
    const record = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [
        { trainCode: 'A', departureEpochMs: 300_000 },
        { trainCode: 'B', departureEpochMs: 320_000 },
      ],
      T0,
    );
    expect(record.status).toBe('ambiguous');
  });
});

/** acceptance ①: 2 waypoint 정합 내 단일 confirm. */
describe('acceptance ① — 단일 후보 2 waypoint 정합 → confirm', () => {
  it('연속 2 tick match(|Δ|≤90s) → confirmed', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: '장암행-1', departureEpochMs: 300_000 }],
      T0,
    );
    expect(record.status).toBe('tracking');

    let result = stepLegConsensus(record, {
      now: HOP_MS,
      observations: [{ trainCode: '장암행-1', deltaSec: 10 }],
    });
    record = result.record;
    expect(record.status).toBe('tracking');
    expect(result.events).toHaveLength(0);

    result = stepLegConsensus(record, {
      now: HOP_MS * 2,
      observations: [{ trainCode: '장암행-1', deltaSec: -5 }],
    });
    record = result.record;
    expect(record.status).toBe('confirmed');
    expect(record.confirmedTrainCode).toBe('장암행-1');
    expect(result.events).toEqual([{ kind: 'consensus-confirm', trainCode: '장암행-1' }]);
  });
});

/** acceptance ②: 반대방향/앞차(0.5W 이전 출발) → confirm 0 (hard reject, 후보 진입 자체 불가). */
describe('acceptance ② — 반대방향/앞차 hard reject → confirm 0', () => {
  it('window 밖 후보는 candidates에 진입하지 않아 아무리 tick을 진행해도 confirmed가 될 수 없다', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: '앞차', departureEpochMs: 100_000 }],
      T0,
    );
    expect(record.candidates).toHaveLength(0);

    for (let i = 1; i <= 4; i++) {
      const result = stepLegConsensus(record, {
        now: HOP_MS * i,
        observations: [{ trainCode: '앞차', deltaSec: 0 }],
      });
      record = result.record;
      expect(record.status).not.toBe('confirmed');
    }
  });
});

/** acceptance ③: 동시 창 2후보 → ambiguous 유지 → 종점 2hop 전 suppress. */
describe('acceptance ③ — 동시 창 2후보 ambiguous → 종점 임박 suppress', () => {
  it('두 후보 모두 match 유지 시 ambiguous 지속, hopsRemainingToTerminus<=2에서 suppress + floor 공급', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [
        { trainCode: 'A', departureEpochMs: 300_000 },
        { trainCode: 'B', departureEpochMs: 320_000 },
      ],
      T0,
    );
    expect(record.status).toBe('ambiguous');

    let result = stepLegConsensus(record, {
      now: HOP_MS,
      hopsRemainingToTerminus: 4,
      observations: [
        { trainCode: 'A', deltaSec: 0 },
        { trainCode: 'B', deltaSec: 5 },
      ],
    });
    record = result.record;
    expect(record.status).toBe('ambiguous');
    expect(result.events).toHaveLength(0);

    result = stepLegConsensus(record, {
      now: HOP_MS * 2,
      hopsRemainingToTerminus: SUPPRESS_HOPS_TO_TERMINUS,
      observations: [
        { trainCode: 'A', deltaSec: 0 },
        { trainCode: 'B', deltaSec: 5 },
      ],
    });
    record = result.record;
    expect(record.status).toBe('suppressed');
    expect(record.suppressFloorEpochMs).toBe(320_000); // 최후 생존 후보 중 최늦 T_dep
    expect(result.events).toEqual([
      { kind: 'consensus-suppress', meta: { reason: 'ambiguous-near-terminus' } },
    ]);
  });
});

/** acceptance ④: outage fixture — confidence hold(소멸 유예), mismatch 미집계. */
describe('acceptance ④ — outage tick → confidence hold, mismatch 미집계', () => {
  it('outage tick은 카운트를 전혀 변경하지 않고, 이후 정상 tick으로 confirm까지 정상 도달한다', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: '장암행-1', departureEpochMs: 300_000 }],
      T0,
    );

    let result = stepLegConsensus(record, {
      now: HOP_MS,
      observations: [{ trainCode: '장암행-1', deltaSec: 10 }],
    });
    record = result.record;
    expect(record.candidates[0].matchCount).toBe(1);

    // outage tick: mismatch 미집계 + missedTicks 증가 없음(hold)
    result = stepLegConsensus(record, { now: HOP_MS * 2, outage: true });
    record = result.record;
    expect(record.candidates[0].matchCount).toBe(1);
    expect(record.candidates[0].mismatchCount).toBe(0);
    expect(record.candidates[0].missedTicks).toBe(0);
    expect(record.status).toBe('tracking');
    expect(result.events).toHaveLength(0);

    // fetchedAt age>30s 도 동일하게 미집계
    result = stepLegConsensus(record, {
      now: HOP_MS * 3,
      observations: [{ trainCode: '장암행-1', deltaSec: 200, fetchedAtAgeSec: 45 }],
    });
    record = result.record;
    expect(record.candidates[0].mismatchCount).toBe(0);

    result = stepLegConsensus(record, {
      now: HOP_MS * 4,
      observations: [{ trainCode: '장암행-1', deltaSec: -5 }],
    });
    record = result.record;
    expect(record.status).toBe('confirmed');
  });
});

/** acceptance ⑤: confirmed 후 mismatch 2연속 → demote. */
describe('acceptance ⑤ — confirmed 후 mismatch 2연속 → demote', () => {
  it('confirmed 상태에서 연속 mismatch(|Δ|>180s) 2회 시 즉시 demoted', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: '장암행-1', departureEpochMs: 300_000 }],
      T0,
    );
    record = stepLegConsensus(record, {
      now: HOP_MS,
      observations: [{ trainCode: '장암행-1', deltaSec: 10 }],
    }).record;
    record = stepLegConsensus(record, {
      now: HOP_MS * 2,
      observations: [{ trainCode: '장암행-1', deltaSec: -5 }],
    }).record;
    expect(record.status).toBe('confirmed');

    record = stepLegConsensus(record, {
      now: HOP_MS * 3,
      observations: [{ trainCode: '장암행-1', deltaSec: 200 }],
    }).record;
    expect(record.status).toBe('confirmed');
    expect(record.confirmedMismatchStreak).toBe(1);

    const result = stepLegConsensus(record, {
      now: HOP_MS * 4,
      observations: [{ trainCode: '장암행-1', deltaSec: -220 }],
    });
    record = result.record;
    expect(record.status).toBe('demoted');
    expect(record.confirmedMismatchStreak).toBe(DEMOTE_MISMATCH_STREAK);
    expect(result.events).toEqual([{ kind: 'consensus-demote', trainCode: '장암행-1' }]);

    // demoted는 terminal — 이후 tick도 상태 불변
    const after = stepLegConsensus(record, {
      now: HOP_MS * 5,
      observations: [{ trainCode: '장암행-1', deltaSec: 0 }],
    });
    expect(after.record.status).toBe('demoted');
    expect(after.events).toHaveLength(0);
  });
});

describe('전 후보 mismatch → 자연 suppress (fail mode 6: route 오등록)', () => {
  it('단일 후보가 mismatch(>180s) 1회만 겪어도 생존자 0 → suppressed', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: 'X', departureEpochMs: 300_000 }],
      T0,
    );
    const result = stepLegConsensus(record, {
      now: HOP_MS,
      observations: [{ trainCode: 'X', deltaSec: 300 }],
    });
    record = result.record;
    expect(record.status).toBe('suppressed');
    expect(result.events).toEqual([
      { kind: 'consensus-suppress', meta: { reason: 'all-mismatch' } },
    ]);
    expect(record.suppressFloorEpochMs).toBe(300_000);
  });
});

describe('neutral zone (90s < |Δ| ≤ 180s) — match도 mismatch도 아님', () => {
  it('tracking/ambiguous 단계에서 neutral delta는 카운트를 변경하지 않는다', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: 'Z', departureEpochMs: 300_000 }],
      T0,
    );
    const result = stepLegConsensus(record, {
      now: HOP_MS,
      observations: [{ trainCode: 'Z', deltaSec: 120 }],
    });
    record = result.record;
    expect(record.candidates[0].matchCount).toBe(0);
    expect(record.candidates[0].mismatchCount).toBe(0);
    expect(record.status).toBe('tracking');
  });

  it('confirmed 단계에서 neutral delta는 mismatch streak을 변경하지 않는다', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: 'Z', departureEpochMs: 300_000 }],
      T0,
    );
    record = stepLegConsensus(record, {
      now: HOP_MS,
      observations: [{ trainCode: 'Z', deltaSec: 10 }],
    }).record;
    record = stepLegConsensus(record, {
      now: HOP_MS * 2,
      observations: [{ trainCode: 'Z', deltaSec: -5 }],
    }).record;
    expect(record.status).toBe('confirmed');

    const result = stepLegConsensus(record, {
      now: HOP_MS * 3,
      observations: [{ trainCode: 'Z', deltaSec: 120 }],
    });
    expect(result.record.status).toBe('confirmed');
    expect(result.record.confirmedMismatchStreak).toBe(0);
  });

  it('confirmed 단계에서 confirmedTrainCode 관측이 없으면(observations 빈 배열) streak을 유지한다', () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: 'Z', departureEpochMs: 300_000 }],
      T0,
    );
    record = stepLegConsensus(record, {
      now: HOP_MS,
      observations: [{ trainCode: 'Z', deltaSec: 10 }],
    }).record;
    record = stepLegConsensus(record, {
      now: HOP_MS * 2,
      observations: [{ trainCode: 'Z', deltaSec: -5 }],
    }).record;
    expect(record.status).toBe('confirmed');

    const result = stepLegConsensus(record, { now: HOP_MS * 3, observations: [] });
    expect(result.record.status).toBe('confirmed');
    expect(result.record.confirmedMismatchStreak).toBe(0);
  });
});

describe('3-tick 건너뜀 → mismatch 집계 (fail mode: API stale/무관측)', () => {
  it(`관측 없는 tick이 ${MISSED_TICK_MISMATCH_COUNT}회 연속되면 mismatch로 집계된다`, () => {
    let record: LegConsensusRecord = initLegConsensus(
      T0,
      TRANSFER_TIME_SEC,
      HEADWAY_SEC,
      [{ trainCode: 'Y', departureEpochMs: 300_000 }],
      T0,
    );
    for (let i = 1; i < MISSED_TICK_MISMATCH_COUNT; i++) {
      const result = stepLegConsensus(record, { now: HOP_MS * i, observations: [] });
      record = result.record;
      expect(record.status).not.toBe('suppressed');
    }
    const result = stepLegConsensus(record, {
      now: HOP_MS * MISSED_TICK_MISMATCH_COUNT,
      observations: [],
    });
    record = result.record;
    expect(record.candidates[0].mismatchCount).toBe(1);
    expect(record.status).toBe('suppressed');
  });
});
