/**
 * #3100 — companion 원장(ledger)을 칸별로 분리한다. 키 = (trip, 역, 종류, 남은 수).
 * 같은 역의 3역 전 → 2역 전 → 1역 전이 모두 울려야 하고, 같은 칸 재수신만 dedup이다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildAlarmLocalId, fireCompanionAlarm, __resetAlarmLocalLedgerForTest } from '../alarmLocalAuthority';
import { vibrateAlarm } from '../alarmSound';
import { speakAlarm } from '../tts';
import { ALARM_LOCAL_LEDGER_KEY, SLEEP_MODE_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('../alarmSound', () => ({ vibrateAlarm: jest.fn() }));
jest.mock('../tts', () => ({ speakAlarm: jest.fn() }));

const base = { tripToken: 'trip-1', station: '강남', kind: 'transfer' as const, body: 'b' };

async function ledgerIds(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(ALARM_LOCAL_LEDGER_KEY);
  return (JSON.parse(raw ?? '[]') as { id: string }[]).map((e) => e.id);
}

describe('buildAlarmLocalId — 남은 수 칸', () => {
  it('기본 칸(남은 수 미지정/1)은 기존 id 그대로', () => {
    expect(buildAlarmLocalId('t', '강남', 'transfer')).toBe('alarm-t-강남-transfer');
    expect(buildAlarmLocalId('t', '강남', 'transfer', 1)).toBe('alarm-t-강남-transfer');
  });

  it('N역 전 칸은 -s{N} 접미', () => {
    expect(buildAlarmLocalId('t', '강남', 'transfer', 3)).toBe('alarm-t-강남-transfer-s3');
    expect(buildAlarmLocalId('t', '강남', 'destination', 2)).toBe('alarm-t-강남-destination-s2');
  });
});

describe('fireCompanionAlarm — 칸별 원장', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await __resetAlarmLocalLedgerForTest();
    await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(true));
  });

  it('3역 전 → 2역 전 → 1역 전 순서로 수신하면 셋 다 발사된다 (둘째·셋째가 dedup되면 안 된다)', async () => {
    const first = await fireCompanionAlarm({ ...base, remaining: 3 });
    const second = await fireCompanionAlarm({ ...base, remaining: 2 });
    const third = await fireCompanionAlarm({ ...base });
    expect([first.fired, second.fired, third.fired]).toEqual([true, true, true]);
    expect(vibrateAlarm).toHaveBeenCalledTimes(3);
    expect(speakAlarm).toHaveBeenCalledTimes(3);
    expect(await ledgerIds()).toEqual([
      'alarm-trip-1-강남-transfer-s3',
      'alarm-trip-1-강남-transfer-s2',
      'alarm-trip-1-강남-transfer',
    ]);
  });

  it('같은 칸 재수신은 dedup (백엔드 rollback 재발사)', async () => {
    await fireCompanionAlarm({ ...base, remaining: 2 });
    const again = await fireCompanionAlarm({ ...base, remaining: 2 });
    expect(again).toEqual({ fired: false, reason: 'dedup' });
    expect(vibrateAlarm).toHaveBeenCalledTimes(1);
  });

  it('기본 칸 재수신은 remaining 미지정/1 어느 쪽이든 같은 id → dedup', async () => {
    await fireCompanionAlarm({ ...base });
    const again = await fireCompanionAlarm({ ...base, remaining: 1 });
    expect(again).toEqual({ fired: false, reason: 'dedup' });
  });

  it('종류가 다르면 같은 칸이어도 별개 (환승 3역 전 vs 도착 3역 전)', async () => {
    await fireCompanionAlarm({ ...base, remaining: 3 });
    const other = await fireCompanionAlarm({ ...base, kind: 'destination', remaining: 3 });
    expect(other.fired).toBe(true);
  });
});
