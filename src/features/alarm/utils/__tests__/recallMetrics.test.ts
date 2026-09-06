import {
  computeTripRecall,
  isEmptyRecall,
  GATE_SUPPRESSION_REASONS,
} from '../recallMetrics';
import type { AlarmLogEntry } from '../alarmLog';

// 테스트 헬퍼 — partial을 받아 AlarmLogEntry로 좁힌다 (필수 필드 강제).
function entry(
  partial: Partial<AlarmLogEntry> & Pick<AlarmLogEntry, 'ts' | 'source' | 'outcome'>,
): AlarmLogEntry {
  return { ...partial };
}

// 자주 쓰는 fg-evaluated fired 보일러플레이트 — duplication 차단.
function firedAt(ts: number, stationName?: string): AlarmLogEntry {
  return entry({
    ts,
    source: 'fg-evaluated',
    outcome: 'fired',
    kind: 'station-passed',
    ...(stationName ? { stationName } : {}),
  });
}

describe('computeTripRecall', () => {
  // route 역 3개 중 2개가 trip 윈도우 내 fired → recall = 2/3.
  it('expected vs fired로 recall%를 계산한다', () => {
    const route = ['강남', '역삼', '선릉'];
    const entries: AlarmLogEntry[] = [
      firedAt(100, '강남'),
      entry({
        ts: 200,
        source: 'silent-push-fired',
        outcome: 'fired',
        kind: 'station-passed',
        stationName: '역삼',
      }),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.expectedStops).toBe(3);
    expect(result.firedStops).toBe(2);
    expect(result.recallPct).toBe(67);
  });

  it('expected가 0이면 recallPct는 100 (분모 보호)', () => {
    const result = computeTripRecall({
      routeStops: [],
      entries: [],
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.expectedStops).toBe(0);
    expect(result.firedStops).toBe(0);
    expect(result.recallPct).toBe(100);
  });

  it('100% recall — 모든 역 fired', () => {
    const route = ['A', 'B'];
    const entries: AlarmLogEntry[] = [
      firedAt(1, 'A'),
      firedAt(2, 'B'),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 10,
    });

    expect(result.recallPct).toBe(100);
    expect(result.firedStops).toBe(2);
  });

  it('윈도우 밖 fired 엔트리는 무시 (tripStart exclusive, tripEnd inclusive)', () => {
    const route = ['A', 'B', 'C'];
    const entries: AlarmLogEntry[] = [
      // 윈도우 밖 (ts <= tripStart): 무시
      firedAt(50, 'A'),
      // 윈도우 안: 카운트
      firedAt(150, 'B'),
      // 윈도우 밖 (ts > tripEnd): 무시
      firedAt(600, 'C'),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 100,
      tripEnd: 500,
    });

    expect(result.firedStops).toBe(1);
    expect(result.expectedStops).toBe(3);
  });

  it('같은 역이 여러 번 fired돼도 1번으로 카운트 (dedup by stationName)', () => {
    const route = ['A', 'B'];
    const entries: AlarmLogEntry[] = [
      firedAt(100, 'A'),
      entry({ ts: 200, source: 'silent-push-fired', outcome: 'fired', kind: 'station-passed', stationName: 'A' }),
      firedAt(300, 'B'),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.firedStops).toBe(2);
    expect(result.recallPct).toBe(100);
  });

  it('route에 없는 역의 fired는 무시 (recall 분자는 route ∩ fired)', () => {
    const route = ['A', 'B'];
    const entries: AlarmLogEntry[] = [
      firedAt(100, 'X'),
      firedAt(200, 'A'),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.firedStops).toBe(1);
  });

  it('suppressed outcome은 fired로 카운트하지 않는다', () => {
    const route = ['A', 'B'];
    const entries: AlarmLogEntry[] = [
      entry({
        ts: 100,
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'movement-static-speed',
        kind: 'station-passed',
        stationName: 'A',
      }),
      firedAt(200, 'B'),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.firedStops).toBe(1);
  });

  it('stationName 없는 fired 엔트리는 무시', () => {
    const route = ['A'];
    const entries: AlarmLogEntry[] = [
      firedAt(100),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.firedStops).toBe(0);
  });

  it('outcome=received 엔트리는 fired/suppressed 어디에도 카운트하지 않는다 (silent-push-received 등 측정 노이즈 차단)', () => {
    const route = ['A'];
    const entries: AlarmLogEntry[] = [
      entry({
        ts: 100,
        source: 'silent-push-received',
        outcome: 'received',
        stationName: 'A',
        kind: 'station-passed',
      }),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.firedStops).toBe(0);
    expect(Object.keys(result.gateSuppressionCounts)).toHaveLength(0);
  });

  it('kind=destination, kind=transfer fired도 recall에 카운트 (station-passed 외도 통과 신호)', () => {
    const route = ['목적지', '환승역'];
    const entries: AlarmLogEntry[] = [
      entry({ ts: 100, source: 'fg-evaluated', outcome: 'fired', kind: 'destination', stationName: '목적지' }),
      entry({ ts: 200, source: 'bg-scheduled', outcome: 'fired', kind: 'transfer', stationName: '환승역' }),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.firedStops).toBe(2);
  });
});

describe('computeTripRecall — gateSuppressionCounts', () => {
  // recall < 100% 시 어떤 게이트가 차단했는지 분포 측정.
  it('suppressed 엔트리의 reason별 카운트를 집계한다', () => {
    const route = ['A', 'B', 'C'];
    const entries: AlarmLogEntry[] = [
      entry({
        ts: 100,
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'movement-static-speed',
        stationName: 'A',
      }),
      entry({
        ts: 110,
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'movement-static-speed',
        stationName: 'B',
      }),
      entry({
        ts: 120,
        source: 'silent-push-skipped',
        outcome: 'suppressed',
        reason: 'gate-out-of-range',
        stationName: 'C',
      }),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(result.gateSuppressionCounts['movement-static-speed']).toBe(2);
    expect(result.gateSuppressionCounts['gate-out-of-range']).toBe(1);
  });

  it('GATE_SUPPRESSION_REASONS에 없는 reason은 카운트 제외 (분포 깨끗하게)', () => {
    // dedup-station / dedup-alarm은 게이트 차단이 아니라 정상 동작 (이미 발화됨) → 제외.
    const route = ['A'];
    const entries: AlarmLogEntry[] = [
      entry({
        ts: 100,
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'dedup-station',
        stationName: 'A',
      }),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(Object.keys(result.gateSuppressionCounts)).toHaveLength(0);
  });

  it('reason 없는 suppressed 엔트리는 무시', () => {
    const route = ['A'];
    const entries: AlarmLogEntry[] = [
      entry({ ts: 100, source: 'bg', outcome: 'suppressed', stationName: 'A' }),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 0,
      tripEnd: 1000,
    });

    expect(Object.keys(result.gateSuppressionCounts)).toHaveLength(0);
  });

  it('윈도우 밖 suppressed 엔트리는 카운트 제외', () => {
    const route = ['A'];
    const entries: AlarmLogEntry[] = [
      entry({
        ts: 50,
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'movement-static-speed',
        stationName: 'A',
      }),
      entry({
        ts: 600,
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'movement-static-speed',
        stationName: 'A',
      }),
    ];

    const result = computeTripRecall({
      routeStops: route,
      entries,
      tripStart: 100,
      tripEnd: 500,
    });

    expect(result.gateSuppressionCounts['movement-static-speed']).toBeUndefined();
  });

  it('모든 게이트 reason은 GATE_SUPPRESSION_REASONS에 포함 (데이터 주도)', () => {
    // sanity: 새 게이트 reason이 alarmLog.ts에 추가되면 이 상수도 같이 업데이트 강제.
    expect(GATE_SUPPRESSION_REASONS).toContain('movement-static-speed');
    expect(GATE_SUPPRESSION_REASONS).toContain('gate-out-of-range');
    expect(GATE_SUPPRESSION_REASONS).toContain('sleep-first-transfer');
    expect(GATE_SUPPRESSION_REASONS).toContain('dismiss-silence');
    expect(GATE_SUPPRESSION_REASONS).not.toContain('dedup-station');
  });
});

describe('isEmptyRecall', () => {
  it('expected=0, fired=0, gate 분포 비어있으면 true', () => {
    expect(
      isEmptyRecall({
        tripStart: 0,
        tripEnd: 1,
        expectedStops: 0,
        firedStops: 0,
        recallPct: 100,
        gateSuppressionCounts: {},
      }),
    ).toBe(true);
  });

  it('expected>0 이면 false (recall 신호 있음)', () => {
    expect(
      isEmptyRecall({
        tripStart: 0,
        tripEnd: 1,
        expectedStops: 3,
        firedStops: 0,
        recallPct: 0,
        gateSuppressionCounts: {},
      }),
    ).toBe(false);
  });

  it('gate suppression 있으면 false (분포 신호 있음)', () => {
    expect(
      isEmptyRecall({
        tripStart: 0,
        tripEnd: 1,
        expectedStops: 0,
        firedStops: 0,
        recallPct: 100,
        gateSuppressionCounts: { 'movement-static-speed': 1 },
      }),
    ).toBe(false);
  });
});
