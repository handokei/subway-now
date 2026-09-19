/**
 * A3 사전 예약 효과 측정 ledger + compute 테스트 (#918, #2089 리뷰 P2-1로 alarm- prefix 갱신).
 *
 * - ledger record/clear/read 동작 검증 (AsyncStorage RMW)
 * - computePrescheduledMetrics: 윈도우 필터, miss/accuracy/delta 산출
 * - graceful skip: malformed JSON, non-safety-net identifier, NaN scheduledFireMs, 빈 stationName
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  LEDGER_MAX_ENTRIES,
  clearPrescheduledLedger,
  computePrescheduledMetrics,
  isEmptyPrescheduledMetrics,
  readPrescheduledLedger,
  recordFiredAlarm,
  recordScheduledAlarm,
} from '../prescheduledMetrics';
import { PRESCHEDULED_LEDGER_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn((k: string) => Promise.resolve(mem.has(k) ? (mem.get(k) ?? null) : null)),
      setItem: jest.fn((k: string, v: string) => {
        mem.set(k, v);
        return Promise.resolve();
      }),
      removeItem: jest.fn((k: string) => {
        mem.delete(k);
        return Promise.resolve();
      }),
      __mem: mem,
    },
  };
});

const mem: Map<string, string> = (AsyncStorage as unknown as { __mem: Map<string, string> }).__mem;

beforeEach(() => {
  mem.clear();
  jest.clearAllMocks();
});

describe('recordScheduledAlarm', () => {
  it('non-safety-net prefix는 ledger에 적재하지 않는다', async () => {
    await recordScheduledAlarm({
      identifier: 'tba:early:강남',
      scheduledFireMs: 100,
      stationName: '강남',
    });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('NaN/Infinity scheduledFireMs는 skip', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-강남-transfer',
      scheduledFireMs: Number.NaN,
      stationName: '강남',
    });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-강남-transfer',
      scheduledFireMs: Number.POSITIVE_INFINITY,
      stationName: '강남',
    });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('빈 stationName은 skip', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-강남-transfer',
      scheduledFireMs: 100,
      stationName: '',
    });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('새 identifier는 append', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-destination',
      scheduledFireMs: 200,
      stationName: 'A',
    });
    const ledger = await readPrescheduledLedger();
    expect(ledger).toEqual([
      { identifier: 'alarm-T1-A-transfer', scheduledFireMs: 100, stationName: 'A' },
      { identifier: 'alarm-T1-A-destination', scheduledFireMs: 200, stationName: 'A' },
    ]);
  });

  it('같은 identifier 재호출은 entry 갱신 + actualFireMs reset (새 trip/reschedule 재예약)', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    await recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: 150 });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 500,
      stationName: 'A',
    });
    const ledger = await readPrescheduledLedger();
    expect(ledger).toEqual([
      { identifier: 'alarm-T1-A-transfer', scheduledFireMs: 500, stationName: 'A' },
    ]);
  });

  it('ledger 상한 초과 시 oldest 절단', async () => {
    for (let i = 0; i < LEDGER_MAX_ENTRIES + 3; i++) {
      await recordScheduledAlarm({
        identifier: `alarm-T1-S${i}-transfer`,
        scheduledFireMs: i,
        stationName: `S${i}`,
      });
    }
    const ledger = await readPrescheduledLedger();
    expect(ledger.length).toBe(LEDGER_MAX_ENTRIES);
    // oldest 3건이 잘려나가야 함
    expect(ledger[0].identifier).toBe('alarm-T1-S3-transfer');
    expect(ledger.at(-1)?.identifier).toBe(`alarm-T1-S${LEDGER_MAX_ENTRIES + 2}-transfer`);
  });

  it('AsyncStorage setItem 실패 시 graceful (throw 안 함)', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await expect(
      recordScheduledAlarm({
        identifier: 'alarm-T1-A-transfer',
        scheduledFireMs: 100,
        stationName: 'A',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('recordFiredAlarm', () => {
  it('ledger에 없는 identifier는 no-op', async () => {
    await recordFiredAlarm({ identifier: 'alarm-T1-Unknown-transfer', actualFireMs: 500 });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('non-safety-net prefix는 무시', async () => {
    await recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 500 });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('NaN actualFireMs는 skip', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    await recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: Number.NaN });
    const ledger = await readPrescheduledLedger();
    expect(ledger[0].actualFireMs).toBeUndefined();
  });

  it('정상 케이스 — actualFireMs 기록', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    await recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: 150 });
    const ledger = await readPrescheduledLedger();
    expect(ledger[0].actualFireMs).toBe(150);
  });

  it('AsyncStorage read 실패는 graceful', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await expect(
      recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: 100 }),
    ).resolves.toBeUndefined();
  });

  it('AsyncStorage write 실패도 graceful (recordFiredAlarm catch)', async () => {
    // ledger entry는 있어서 writeLedger까지 도달해야 함
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('write fail'));
    await expect(
      recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: 150 }),
    ).resolves.toBeUndefined();
  });
});

describe('readPrescheduledLedger', () => {
  it('JSON 깨졌으면 빈 배열 반환 (graceful)', async () => {
    mem.set(PRESCHEDULED_LEDGER_KEY, 'not-json');
    expect(await readPrescheduledLedger()).toEqual([]);
  });

  it('JSON이 배열 아니면 빈 배열 반환', async () => {
    mem.set(PRESCHEDULED_LEDGER_KEY, '{"foo": "bar"}');
    expect(await readPrescheduledLedger()).toEqual([]);
  });

  it('entry 일부가 shape 위반이면 정상 entry만 보존', async () => {
    mem.set(
      PRESCHEDULED_LEDGER_KEY,
      JSON.stringify([
        { identifier: 'alarm-T1-A-transfer', scheduledFireMs: 100, stationName: 'A' },
        null, // null entry
        'string-entry', // primitive
        { identifier: 'tba:early:B', scheduledFireMs: 200, stationName: 'B' }, // wrong prefix
        { identifier: 'alarm-T1-C-transfer', scheduledFireMs: 'x', stationName: 'C' }, // wrong type
        { identifier: 'alarm-T1-D-transfer', scheduledFireMs: 400, stationName: '' }, // 빈 stationName
        {
          identifier: 'alarm-T1-E-transfer',
          scheduledFireMs: 500,
          stationName: 'E',
          actualFireMs: 'x',
        }, // bad actual
      ]),
    );
    const ledger = await readPrescheduledLedger();
    expect(ledger).toEqual([
      { identifier: 'alarm-T1-A-transfer', scheduledFireMs: 100, stationName: 'A' },
    ]);
  });

  it('AsyncStorage getItem 실패 시 빈 배열', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    expect(await readPrescheduledLedger()).toEqual([]);
  });

  it('빈 키는 빈 배열', async () => {
    expect(await readPrescheduledLedger()).toEqual([]);
  });
});

describe('clearPrescheduledLedger', () => {
  it('키 제거 — 다음 read는 빈 배열', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    await clearPrescheduledLedger();
    expect(await readPrescheduledLedger()).toEqual([]);
  });

  it('removeItem 실패는 graceful', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await expect(clearPrescheduledLedger()).resolves.toBeUndefined();
  });
});

describe('computePrescheduledMetrics', () => {
  it('ledger 비어있으면 모든 카운트 0', async () => {
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(0);
    expect(result.firedCount).toBe(0);
    expect(result.stationAccurateCount).toBe(0);
    expect(result.fireDeltaSamplesMs).toEqual([]);
    expect(isEmptyPrescheduledMetrics(result)).toBe(true);
  });

  it('윈도우 밖 entry는 제외 (scheduledFireMs < tripStart)', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-Out-transfer',
      scheduledFireMs: -100,
      stationName: 'Out',
    });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-In-transfer',
      scheduledFireMs: 500,
      stationName: 'In',
    });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(1);
  });

  it('윈도우 밖 entry는 제외 (scheduledFireMs > tripEnd)', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-Out-transfer',
      scheduledFireMs: 2000,
      stationName: 'Out',
    });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-In-transfer',
      scheduledFireMs: 500,
      stationName: 'In',
    });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(1);
  });

  it('윈도우 경계 (=)는 포함', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-Start-transfer',
      scheduledFireMs: 0,
      stationName: 'Start',
    });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-End-transfer',
      scheduledFireMs: 1000,
      stationName: 'End',
    });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(2);
  });

  it('actualFireMs 있는 entry만 firedCount + delta 카운트', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-B-transfer',
      scheduledFireMs: 200,
      stationName: 'B',
    });
    await recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: 110 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(2);
    expect(result.firedCount).toBe(1);
    expect(result.fireDeltaSamplesMs).toEqual([10]);
  });

  it('fired entry의 station이 firedStationNames에 있으면 정확도 카운트', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    await recordScheduledAlarm({
      identifier: 'alarm-T1-B-destination',
      scheduledFireMs: 200,
      stationName: 'B',
    });
    await recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: 110 });
    await recordFiredAlarm({ identifier: 'alarm-T1-B-destination', actualFireMs: 210 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(['A']),
    });
    expect(result.firedCount).toBe(2);
    expect(result.stationAccurateCount).toBe(1);
  });

  it('음수 delta (시계 보정으로 더 일찍 발사) 그대로 보존', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 200,
      stationName: 'A',
    });
    await recordFiredAlarm({ identifier: 'alarm-T1-A-transfer', actualFireMs: 150 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.fireDeltaSamplesMs).toEqual([-50]);
  });

  it('scheduled=1만 있고 fire 없으면 isEmpty=false (miss 신호 의미 있음)', async () => {
    await recordScheduledAlarm({
      identifier: 'alarm-T1-A-transfer',
      scheduledFireMs: 100,
      stationName: 'A',
    });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(isEmptyPrescheduledMetrics(result)).toBe(false);
  });
});
