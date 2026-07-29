jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../alarmSound', () => ({
  vibrateAlarm: jest.fn(),
}));

jest.mock('../tts', () => ({
  speakAlarm: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildAlarmLocalId,
  hasFiredLocally,
  fireCompanionAlarm,
  __resetAlarmLocalLedgerForTest,
  ALARM_LOCAL_LEDGER_TTL_MS,
} from '../alarmLocalAuthority';
import { vibrateAlarm } from '../alarmSound';
import { speakAlarm } from '../tts';
import {
  ALARM_LOCAL_LEDGER_KEY,
  SLEEP_MODE_KEY,
  ALLOW_SPEAKER_KEY,
} from '../../../../shared/constants/storageKeys';

const mockedGetItem = AsyncStorage.getItem as jest.Mock;
const mockedSetItem = AsyncStorage.setItem as jest.Mock;
const mockedRemoveItem = AsyncStorage.removeItem as jest.Mock;
const mockedVibrate = vibrateAlarm as jest.Mock;
const mockedSpeak = speakAlarm as jest.Mock;

const NOW = 1_700_000_000_000;

function mockStorage(values: Record<string, string | null>): void {
  mockedGetItem.mockImplementation(async (key: string) => values[key] ?? null);
}

describe('buildAlarmLocalId', () => {
  it('결정적 identifier를 조립한다', () => {
    expect(buildAlarmLocalId('trip-1', '강남', 'transfer')).toBe('alarm-trip-1-강남-transfer');
    expect(buildAlarmLocalId('trip-1', '성수', 'destination')).toBe('alarm-trip-1-성수-destination');
  });
});

describe('hasFiredLocally', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSetItem.mockResolvedValue(undefined);
  });

  it('ledger가 비어있으면 false', async () => {
    mockStorage({});
    expect(await hasFiredLocally('id-1', NOW)).toBe(false);
  });

  it('storage read 실패 시 false (graceful)', async () => {
    mockedGetItem.mockRejectedValue(new Error('boom'));
    expect(await hasFiredLocally('id-1', NOW)).toBe(false);
  });

  it('malformed JSON이면 false', async () => {
    mockStorage({ [ALARM_LOCAL_LEDGER_KEY]: 'not-json' });
    expect(await hasFiredLocally('id-1', NOW)).toBe(false);
  });

  it('배열이 아닌 값이면 false', async () => {
    mockStorage({ [ALARM_LOCAL_LEDGER_KEY]: JSON.stringify({ foo: 'bar' }) });
    expect(await hasFiredLocally('id-1', NOW)).toBe(false);
  });

  it('형식이 잘못된 entry는 필터링된다', async () => {
    mockStorage({
      [ALARM_LOCAL_LEDGER_KEY]: JSON.stringify([
        { id: 'id-1' }, // firedAt 누락
        null,
        'string-entry',
        { id: 'id-2', firedAt: NOW },
      ]),
    });
    expect(await hasFiredLocally('id-1', NOW)).toBe(false);
    expect(await hasFiredLocally('id-2', NOW)).toBe(true);
  });

  it('TTL 이내 entry는 true', async () => {
    mockStorage({
      [ALARM_LOCAL_LEDGER_KEY]: JSON.stringify([{ id: 'id-1', firedAt: NOW - 1000 }]),
    });
    expect(await hasFiredLocally('id-1', NOW)).toBe(true);
  });

  it('TTL 만료 entry는 false', async () => {
    mockStorage({
      [ALARM_LOCAL_LEDGER_KEY]: JSON.stringify([
        { id: 'id-1', firedAt: NOW - ALARM_LOCAL_LEDGER_TTL_MS - 1 },
      ]),
    });
    expect(await hasFiredLocally('id-1', NOW)).toBe(false);
  });
});

describe('fireCompanionAlarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedSetItem.mockResolvedValue(undefined);
  });

  it('sleepMode off면 skip (not-sleep-mode)', async () => {
    mockStorage({ [SLEEP_MODE_KEY]: JSON.stringify(false) });
    const result = await fireCompanionAlarm({
      tripToken: 'trip-1',
      station: '강남',
      kind: 'transfer',
      body: '곧 강남입니다',
    });
    expect(result).toEqual({ fired: false, reason: 'not-sleep-mode' });
    expect(mockedVibrate).not.toHaveBeenCalled();
    expect(mockedSpeak).not.toHaveBeenCalled();
  });

  it('sleepMode 키 부재면 not-sleep-mode로 skip', async () => {
    mockStorage({});
    const result = await fireCompanionAlarm({
      tripToken: 'trip-1',
      station: '강남',
      kind: 'transfer',
      body: '곧 강남입니다',
    });
    expect(result.reason).toBe('not-sleep-mode');
  });

  it('sleepMode 읽기 실패 시 not-sleep-mode로 보수적 skip', async () => {
    mockedGetItem.mockRejectedValue(new Error('boom'));
    const result = await fireCompanionAlarm({
      tripToken: 'trip-1',
      station: '강남',
      kind: 'transfer',
      body: '곧 강남입니다',
    });
    expect(result.reason).toBe('not-sleep-mode');
  });

  it('sleepMode on + 최초 수신 → TTS + 진동 발사', async () => {
    mockStorage({ [SLEEP_MODE_KEY]: JSON.stringify(true) });
    const result = await fireCompanionAlarm({
      tripToken: 'trip-1',
      station: '강남',
      kind: 'transfer',
      body: '곧 강남입니다',
    });
    expect(result).toEqual({ fired: true });
    expect(mockedVibrate).toHaveBeenCalledWith(true);
    expect(mockedSpeak).toHaveBeenCalledWith('곧 강남입니다', {
      sleepMode: false,
      allowSpeaker: true,
    });
    expect(mockedSetItem).toHaveBeenCalledWith(
      ALARM_LOCAL_LEDGER_KEY,
      expect.stringContaining('alarm-trip-1-강남-transfer'),
    );
  });

  // speakAlarm 자체(mock)는 게이트 로직이 없다 — 실제 skip 동작은 tts.test.ts가 검증.
  // 본 테스트는 fireCompanionAlarm이 저장된 사용자 설정을 speakAlarm에 정확히 전달하는지만 확인.
  it('#2067 리뷰 P1: allowSpeaker=false → speakAlarm에 allowSpeaker:false 전달 + 진동은 그대로 발생', async () => {
    mockStorage({
      [SLEEP_MODE_KEY]: JSON.stringify(true),
      [ALLOW_SPEAKER_KEY]: JSON.stringify(false),
    });
    const result = await fireCompanionAlarm({
      tripToken: 'trip-2',
      station: '역삼',
      kind: 'transfer',
      body: '곧 역삼입니다',
    });
    expect(result).toEqual({ fired: true });
    expect(mockedVibrate).toHaveBeenCalledWith(true);
    expect(mockedSpeak).toHaveBeenCalledWith('곧 역삼입니다', {
      sleepMode: false,
      allowSpeaker: false,
    });
  });

  it('#2067 리뷰 P1: allowSpeaker=true → TTS 1회 발화 (사용자 설정 반영)', async () => {
    mockStorage({
      [SLEEP_MODE_KEY]: JSON.stringify(true),
      [ALLOW_SPEAKER_KEY]: JSON.stringify(true),
    });
    const result = await fireCompanionAlarm({
      tripToken: 'trip-3',
      station: '선릉',
      kind: 'destination',
      body: '곧 선릉입니다',
    });
    expect(result).toEqual({ fired: true });
    expect(mockedSpeak).toHaveBeenCalledWith('곧 선릉입니다', {
      sleepMode: false,
      allowSpeaker: true,
    });
  });

  it('#2067 리뷰 P1: ALLOW_SPEAKER_KEY 저장값 없음 → true(허용)로 보수적 fallback', async () => {
    mockStorage({ [SLEEP_MODE_KEY]: JSON.stringify(true) });
    await fireCompanionAlarm({
      tripToken: 'trip-4',
      station: '삼성',
      kind: 'transfer',
      body: '곧 삼성입니다',
    });
    expect(mockedSpeak).toHaveBeenCalledWith('곧 삼성입니다', {
      sleepMode: false,
      allowSpeaker: true,
    });
  });

  it('#2067 리뷰 P1: ALLOW_SPEAKER_KEY 읽기 실패 → true(허용)로 보수적 fallback', async () => {
    mockedGetItem.mockImplementation(async (key: string) => {
      if (key === SLEEP_MODE_KEY) return JSON.stringify(true);
      if (key === ALLOW_SPEAKER_KEY) throw new Error('boom');
      return null;
    });
    await fireCompanionAlarm({
      tripToken: 'trip-5',
      station: '종합운동장',
      kind: 'destination',
      body: '곧 종합운동장입니다',
    });
    expect(mockedSpeak).toHaveBeenCalledWith('곧 종합운동장입니다', {
      sleepMode: false,
      allowSpeaker: true,
    });
  });

  it('같은 id 재수신 → dedup으로 skip', async () => {
    const values: Record<string, string | null> = {
      [SLEEP_MODE_KEY]: JSON.stringify(true),
      [ALARM_LOCAL_LEDGER_KEY]: JSON.stringify([
        { id: 'alarm-trip-1-강남-transfer', firedAt: Date.now() },
      ]),
    };
    mockStorage(values);
    const result = await fireCompanionAlarm({
      tripToken: 'trip-1',
      station: '강남',
      kind: 'transfer',
      body: '곧 강남입니다',
    });
    expect(result).toEqual({ fired: false, reason: 'dedup' });
    expect(mockedVibrate).not.toHaveBeenCalled();
    expect(mockedSpeak).not.toHaveBeenCalled();
  });

  it('ledger write 실패해도 예외를 던지지 않는다 (graceful)', async () => {
    mockStorage({ [SLEEP_MODE_KEY]: JSON.stringify(true) });
    mockedSetItem.mockRejectedValue(new Error('write failed'));
    await expect(
      fireCompanionAlarm({
        tripToken: 'trip-1',
        station: '강남',
        kind: 'destination',
        body: '도착했습니다',
      }),
    ).resolves.toEqual({ fired: true });
  });
});

describe('__resetAlarmLocalLedgerForTest', () => {
  it('ledger key를 제거한다', async () => {
    mockedRemoveItem.mockResolvedValue(undefined);
    await __resetAlarmLocalLedgerForTest();
    expect(mockedRemoveItem).toHaveBeenCalledWith(ALARM_LOCAL_LEDGER_KEY);
  });
});
