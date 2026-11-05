/**
 * 사전 예약 miss trip 자동 진단 컨텍스트 (#986).
 *
 * collectMissContext의 derive 로직 검증:
 *   - BoardingLock → lockedTrainCode/lockedAt
 *   - alarmLog silent-push-received → 마지막 entry 채택
 *   - alarmLog bg-scheduled fired → 마지막 stamp entry 채택 (stamp 전부 비어있으면 skip)
 *   - ledger → actualFireMs 미기록 identifier 목록
 *   - 윈도우 범위 외 entry 제외
 *   - isEmptyMissContext 가드
 */

import type { AlarmLogEntry } from '../alarmLog';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { PrescheduledLedgerEntry } from '../prescheduledMetrics';
import { collectMissContext, isEmptyMissContext } from '../prescheduledMissContext';

function lock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'dest',
    trainCode: '5001',
    boardingStationId: 'A',
    boardingLine: '2',
    boardedAt: 1_000,
    expectedDurationMs: 600_000,
    ...overrides,
  };
}

function entry(overrides: Partial<AlarmLogEntry>): AlarmLogEntry {
  return {
    ts: 1_500,
    source: 'fg',
    outcome: 'fired',
    ...overrides,
  };
}

describe('collectMissContext', () => {
  it('BoardingLock 존재 시 lockedTrainCode/lockedAt 채움', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [],
      boardingLock: lock({ trainCode: '5050', boardedAt: 1_234 }),
      ledger: [],
    });
    expect(out.lockedTrainCode).toBe('5050');
    expect(out.lockedAt).toBe(1_234);
  });

  it('lock.trainCode 빈문자열이면 lockedTrainCode 미생성 (저장소 손상 가드)', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [],
      boardingLock: lock({ trainCode: '', boardedAt: 1_000 }),
      ledger: [],
    });
    expect(out.lockedTrainCode).toBeUndefined();
    expect(out.lockedAt).toBe(1_000);
  });

  it('lock.boardedAt 비유한이면 lockedAt 미생성', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [],
      boardingLock: lock({ trainCode: '5050', boardedAt: Number.NaN }),
      ledger: [],
    });
    expect(out.lockedTrainCode).toBe('5050');
    expect(out.lockedAt).toBeUndefined();
  });

  it('lock=null이면 train/lockedAt 미생성', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lockedTrainCode).toBeUndefined();
    expect(out.lockedAt).toBeUndefined();
  });

  it('윈도우 안 가장 최근 silent-push-received entry 채택', () => {
    const out = collectMissContext({
      tripStart: 1_000,
      tripEnd: 5_000,
      alarmLogEntries: [
        entry({
          ts: 2_000,
          source: 'silent-push-received',
          outcome: 'received',
          sentAt: 1_900,
          receivedAt: 2_000,
          stationName: '강남',
        }),
        entry({
          ts: 4_000,
          source: 'silent-push-received',
          outcome: 'received',
          sentAt: 3_900,
          receivedAt: 4_000,
          stationName: '역삼',
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastSilentPushReceived).toEqual({
      sentAt: 3_900,
      receivedAt: 4_000,
      stationName: '역삼',
    });
  });

  it('silent-push-received entry라도 receivedAt 없으면 skip', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({ ts: 2_000, source: 'silent-push-received', outcome: 'received' }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastSilentPushReceived).toBeUndefined();
  });

  it('silent push entry의 sentAt/stationName이 누락돼도 receivedAt만 있으면 적재', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 2_000,
          source: 'silent-push-received',
          outcome: 'received',
          receivedAt: 2_000,
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastSilentPushReceived).toEqual({ receivedAt: 2_000 });
  });

  it('silent-push-received entry 다수 중 ts가 더 작은 후속 entry는 last를 갱신하지 않음', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 5_000,
          source: 'silent-push-received',
          outcome: 'received',
          receivedAt: 5_000,
          stationName: 'newer',
        }),
        entry({
          ts: 1_000,
          source: 'silent-push-received',
          outcome: 'received',
          receivedAt: 1_000,
          stationName: 'older',
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastSilentPushReceived?.stationName).toBe('newer');
  });

  it('윈도우 밖 silent push entry는 무시', () => {
    const out = collectMissContext({
      tripStart: 1_000,
      tripEnd: 5_000,
      alarmLogEntries: [
        entry({
          ts: 500,
          source: 'silent-push-received',
          outcome: 'received',
          receivedAt: 500,
          stationName: 'before',
        }),
        entry({
          ts: 6_000,
          source: 'silent-push-received',
          outcome: 'received',
          receivedAt: 6_000,
          stationName: 'after',
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastSilentPushReceived).toBeUndefined();
  });

  it('윈도우 안 가장 최근 bg-scheduled fired stamp 채택', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 2_000,
          source: 'bg-scheduled',
          outcome: 'fired',
          selectedArrivalSeconds: 60,
          expectedStationAtFire: '강남',
          actualLastNotifiedStation: '역삼',
        }),
        entry({
          ts: 4_000,
          source: 'bg-scheduled',
          outcome: 'fired',
          selectedArrivalSeconds: 30,
          expectedStationAtFire: '교대',
          actualLastNotifiedStation: '강남',
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastScheduledStamp).toEqual({
      selectedArrivalSeconds: 30,
      expectedStationAtFire: '교대',
      actualLastNotifiedStation: '강남',
    });
  });

  it('stamp 모두 null/undefined인 bg-scheduled entry는 skip', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 2_000,
          source: 'bg-scheduled',
          outcome: 'fired',
          selectedArrivalSeconds: null,
          expectedStationAtFire: null,
          actualLastNotifiedStation: null,
        }),
        entry({
          ts: 1_000,
          source: 'bg-scheduled',
          outcome: 'fired',
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastScheduledStamp).toBeUndefined();
  });

  it('bg-scheduled 다수 중 ts가 더 작은 후속 entry는 last를 갱신하지 않음', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 5_000,
          source: 'bg-scheduled',
          outcome: 'fired',
          expectedStationAtFire: 'newer',
        }),
        entry({
          ts: 1_000,
          source: 'bg-scheduled',
          outcome: 'fired',
          expectedStationAtFire: 'older',
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastScheduledStamp?.expectedStationAtFire).toBe('newer');
  });

  it('bg-scheduled stamp: 다른 필드만 있는 last entry → selectedArrivalSeconds 누락', () => {
    // expectedStationAtFire만 있는 entry가 last가 되면, out.selectedArrivalSeconds는 채워지지 않는다.
    // 이로써 lastScheduledStamp 구성 시 selectedArrivalSeconds 조건 false 분기를 커버한다.
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 2_000,
          source: 'bg-scheduled',
          outcome: 'fired',
          expectedStationAtFire: '강남',
          // selectedArrivalSeconds 미설정 + actualLastNotifiedStation 미설정
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastScheduledStamp).toEqual({ expectedStationAtFire: '강남' });
  });

  it('bg-scheduled 중 부분 stamp만 있는 entry도 채택 (있는 필드만 포함)', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 2_000,
          source: 'bg-scheduled',
          outcome: 'fired',
          selectedArrivalSeconds: 45,
          expectedStationAtFire: null,
          actualLastNotifiedStation: undefined,
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastScheduledStamp).toEqual({ selectedArrivalSeconds: 45 });
  });

  it('outcome이 fired가 아닌 bg-scheduled entry는 무시', () => {
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 10_000,
      alarmLogEntries: [
        entry({
          ts: 2_000,
          source: 'bg-scheduled',
          outcome: 'suppressed',
          selectedArrivalSeconds: 30,
        }),
      ],
      boardingLock: null,
      ledger: [],
    });
    expect(out.lastScheduledStamp).toBeUndefined();
  });

  it('ledger에서 actualFireMs 미기록 identifier 수집 (윈도우 필터)', () => {
    const ledger: PrescheduledLedgerEntry[] = [
      { identifier: 'tba:early:A', scheduledFireMs: 1_000, stationName: 'A' }, // miss, in window
      { identifier: 'tba:early:B', scheduledFireMs: 2_000, actualFireMs: 2_010, stationName: 'B' }, // fired
      { identifier: 'tba:imminent:A', scheduledFireMs: 3_000, stationName: 'A' }, // miss, in window
      { identifier: 'tba:early:OUT', scheduledFireMs: 100, stationName: 'OUT' }, // out of window
      { identifier: 'tba:early:OUT2', scheduledFireMs: 9_999, stationName: 'OUT2' }, // out of window
    ];
    const out = collectMissContext({
      tripStart: 1_000,
      tripEnd: 5_000,
      alarmLogEntries: [],
      boardingLock: null,
      ledger,
    });
    expect(out.missedIdentifiers).toEqual(['tba:early:A', 'tba:imminent:A']);
  });

  it('missed 0건이면 missedIdentifiers 자체를 생성하지 않음', () => {
    const ledger: PrescheduledLedgerEntry[] = [
      { identifier: 'tba:early:A', scheduledFireMs: 1_000, actualFireMs: 1_010, stationName: 'A' },
    ];
    const out = collectMissContext({
      tripStart: 0,
      tripEnd: 5_000,
      alarmLogEntries: [],
      boardingLock: null,
      ledger,
    });
    expect(out.missedIdentifiers).toBeUndefined();
  });
});

describe('isEmptyMissContext', () => {
  it('모든 필드 부재 시 true', () => {
    expect(isEmptyMissContext({})).toBe(true);
  });

  it.each([
    ['lockedTrainCode', { lockedTrainCode: 'x' }],
    ['lockedAt', { lockedAt: 1 }],
    ['lastSilentPushReceived', { lastSilentPushReceived: { receivedAt: 1 } }],
    ['lastScheduledStamp', { lastScheduledStamp: { selectedArrivalSeconds: 1 } }],
    ['missedIdentifiers', { missedIdentifiers: ['tba:x:A'] }],
  ])('필드 %s 있으면 false', (_label, ctx) => {
    expect(isEmptyMissContext(ctx)).toBe(false);
  });
});
