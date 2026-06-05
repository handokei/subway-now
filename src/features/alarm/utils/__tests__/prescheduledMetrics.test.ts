/**
 * A3 사전 예약 효과 측정 ledger + compute 테스트 (#918).
 *
 * - ledger record/clear/read 동작 검증 (AsyncStorage RMW)
 * - computePrescheduledMetrics: 윈도우 필터, miss/accuracy/delta 산출
 * - graceful skip: malformed JSON, non-tba identifier, NaN scheduledFireMs
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
  stationNameFromIdentifier,
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
  it('non-tba prefix는 ledger에 적재하지 않는다', async () => {
    await recordScheduledAlarm({ identifier: 'alarm:early:강남', scheduledFireMs: 100 });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('NaN/Infinity scheduledFireMs는 skip', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:강남', scheduledFireMs: Number.NaN });
    await recordScheduledAlarm({
      identifier: 'tba:early:강남',
      scheduledFireMs: Number.POSITIVE_INFINITY,
    });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('새 identifier는 append', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    await recordScheduledAlarm({ identifier: 'tba:imminent:A', scheduledFireMs: 200 });
    const ledger = await readPrescheduledLedger();
    expect(ledger).toEqual([
      { identifier: 'tba:early:A', scheduledFireMs: 100 },
      { identifier: 'tba:imminent:A', scheduledFireMs: 200 },
    ]);
  });

  it('같은 identifier 재호출은 entry 갱신 + actualFireMs reset (새 trip 재예약)', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    await recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 150 });
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 500 });
    const ledger = await readPrescheduledLedger();
    expect(ledger).toEqual([{ identifier: 'tba:early:A', scheduledFireMs: 500 }]);
  });

  it('ledger 상한 초과 시 oldest 절단', async () => {
    for (let i = 0; i < LEDGER_MAX_ENTRIES + 3; i++) {
      await recordScheduledAlarm({ identifier: `tba:early:S${i}`, scheduledFireMs: i });
    }
    const ledger = await readPrescheduledLedger();
    expect(ledger.length).toBe(LEDGER_MAX_ENTRIES);
    // oldest 3건이 잘려나가야 함
    expect(ledger[0].identifier).toBe('tba:early:S3');
    expect(ledger[ledger.length - 1].identifier).toBe(`tba:early:S${LEDGER_MAX_ENTRIES + 2}`);
  });

  it('AsyncStorage setItem 실패 시 graceful (throw 안 함)', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await expect(
      recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 }),
    ).resolves.toBeUndefined();
  });
});

describe('recordFiredAlarm', () => {
  it('ledger에 없는 identifier는 no-op', async () => {
    await recordFiredAlarm({ identifier: 'tba:early:Unknown', actualFireMs: 500 });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('non-tba prefix는 무시', async () => {
    await recordFiredAlarm({ identifier: 'alarm:early:A', actualFireMs: 500 });
    expect(mem.get(PRESCHEDULED_LEDGER_KEY)).toBeUndefined();
  });

  it('NaN actualFireMs는 skip', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    await recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: Number.NaN });
    const ledger = await readPrescheduledLedger();
    expect(ledger[0].actualFireMs).toBeUndefined();
  });

  it('정상 케이스 — actualFireMs 기록', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    await recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 150 });
    const ledger = await readPrescheduledLedger();
    expect(ledger[0].actualFireMs).toBe(150);
  });

  it('AsyncStorage read 실패는 graceful', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await expect(
      recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 100 }),
    ).resolves.toBeUndefined();
  });

  it('AsyncStorage write 실패도 graceful (recordFiredAlarm catch)', async () => {
    // ledger entry는 있어서 writeLedger까지 도달해야 함
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('write fail'));
    await expect(
      recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 150 }),
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
        { identifier: 'tba:early:A', scheduledFireMs: 100 },
        null, // null entry
        'string-entry', // primitive
        { identifier: 'alarm:early:B', scheduledFireMs: 200 }, // wrong prefix
        { identifier: 'tba:early:C', scheduledFireMs: 'x' }, // wrong type
        { identifier: 'tba:early:D', scheduledFireMs: 400, actualFireMs: 'x' }, // bad actual
      ]),
    );
    const ledger = await readPrescheduledLedger();
    expect(ledger).toEqual([{ identifier: 'tba:early:A', scheduledFireMs: 100 }]);
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
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    await clearPrescheduledLedger();
    expect(await readPrescheduledLedger()).toEqual([]);
  });

  it('removeItem 실패는 graceful', async () => {
    (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await expect(clearPrescheduledLedger()).resolves.toBeUndefined();
  });
});

describe('stationNameFromIdentifier', () => {
  it('정상 identifier에서 station name 추출', () => {
    expect(stationNameFromIdentifier('tba:early:강남')).toBe('강남');
    expect(stationNameFromIdentifier('tba:imminent:서울역')).toBe('서울역');
  });

  it('station이 콜론 포함하는 경우 첫 콜론 뒤 전체', () => {
    expect(stationNameFromIdentifier('tba:early:A:B')).toBe('A:B');
  });

  it('non-tba prefix는 null', () => {
    expect(stationNameFromIdentifier('alarm:early:A')).toBeNull();
    expect(stationNameFromIdentifier('A')).toBeNull();
  });

  it('phaseId만 있고 station 없으면 null', () => {
    expect(stationNameFromIdentifier('tba:early')).toBeNull();
    expect(stationNameFromIdentifier('tba:early:')).toBeNull();
  });

  it('phase 부분이 비어 있어도 station 추출은 시도 안 함 (콜론 시작 위반)', () => {
    // 'tba::A' → rest=':A', colon=0 (콜론이 0번째) → colon<=0 → null
    expect(stationNameFromIdentifier('tba::A')).toBeNull();
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
    await recordScheduledAlarm({ identifier: 'tba:early:Out', scheduledFireMs: -100 });
    await recordScheduledAlarm({ identifier: 'tba:early:In', scheduledFireMs: 500 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(1);
  });

  it('윈도우 밖 entry는 제외 (scheduledFireMs > tripEnd)', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:Out', scheduledFireMs: 2000 });
    await recordScheduledAlarm({ identifier: 'tba:early:In', scheduledFireMs: 500 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(1);
  });

  it('윈도우 경계 (=)는 포함', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:Start', scheduledFireMs: 0 });
    await recordScheduledAlarm({ identifier: 'tba:early:End', scheduledFireMs: 1000 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.scheduledCount).toBe(2);
  });

  it('actualFireMs 있는 entry만 firedCount + delta 카운트', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    await recordScheduledAlarm({ identifier: 'tba:early:B', scheduledFireMs: 200 });
    await recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 110 });
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
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    await recordScheduledAlarm({ identifier: 'tba:imminent:B', scheduledFireMs: 200 });
    await recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 110 });
    await recordFiredAlarm({ identifier: 'tba:imminent:B', actualFireMs: 210 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(['A']),
    });
    expect(result.firedCount).toBe(2);
    expect(result.stationAccurateCount).toBe(1);
  });

  it('음수 delta (시계 보정으로 더 일찍 발사) 그대로 보존', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 200 });
    await recordFiredAlarm({ identifier: 'tba:early:A', actualFireMs: 150 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(result.fireDeltaSamplesMs).toEqual([-50]);
  });

  it('scheduled=1만 있고 fire 없으면 isEmpty=false (miss 신호 의미 있음)', async () => {
    await recordScheduledAlarm({ identifier: 'tba:early:A', scheduledFireMs: 100 });
    const result = await computePrescheduledMetrics({
      tripStart: 0,
      tripEnd: 1000,
      firedStationNames: new Set(),
    });
    expect(isEmptyPrescheduledMetrics(result)).toBe(false);
  });
});
