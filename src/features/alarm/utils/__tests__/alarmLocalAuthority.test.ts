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

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
  dismissNotificationAsync: jest.fn(),
  AndroidNotificationPriority: { MAX: 'max' },
}));

jest.mock('../stationNotification', () => ({
  ALARM_NOTIFICATION_ID: 'station-alarm',
  ALARM_CHANNEL_ID: 'station-alarm',
  iosTimeSensitiveOption: () => ({ interruptionLevel: 'timeSensitive' }),
}));

jest.mock('../alarmSound', () => ({
  vibrateAlarm: jest.fn(),
}));

jest.mock('../tts', () => ({
  speakAlarm: jest.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
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
const mockedSchedule = Notifications.scheduleNotificationAsync as jest.Mock;
const mockedPresented = Notifications.getPresentedNotificationsAsync as jest.Mock;
const mockedDismiss = Notifications.dismissNotificationAsync as jest.Mock;

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
    mockedSchedule.mockResolvedValue('id');
    mockedPresented.mockResolvedValue([]);
    mockedDismiss.mockResolvedValue(undefined);
  });

  it('sleepMode off면 skip (not-sleep-mode)', async () => {
    mockStorage({ [SLEEP_MODE_KEY]: JSON.stringify(false) });
    const result = await fireCompanionAlarm({
      tripToken: 'trip-1',
      station: '강남',
      kind: 'transfer',
      title: '알림',
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
      title: '알림',
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
      title: '알림',
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
      title: '알림',
      body: '곧 강남입니다',
    });
    expect(result).toEqual({ fired: true, bannerPosted: true });
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
      title: '알림',
      body: '곧 역삼입니다',
    });
    expect(result).toEqual({ fired: true, bannerPosted: true });
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
      title: '알림',
      body: '곧 선릉입니다',
    });
    expect(result).toEqual({ fired: true, bannerPosted: true });
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
      title: '알림',
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
      title: '알림',
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
      title: '알림',
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
        title: '알림',
        body: '도착했습니다',
      }),
    ).resolves.toEqual({ fired: true, bannerPosted: true });
  });
});

describe('__resetAlarmLocalLedgerForTest', () => {
  it('ledger key를 제거한다', async () => {
    mockedRemoveItem.mockResolvedValue(undefined);
    await __resetAlarmLocalLedgerForTest();
    expect(mockedRemoveItem).toHaveBeenCalledWith(ALARM_LOCAL_LEDGER_KEY);
  });
});

// #3373 — 취침 알람은 기기가 직접 울린다(배너+소리). 서버 alert가 BG에서 표시 안 된 11/24 실사례 → companion 수신 = 로컬 게시.
describe('fireCompanionAlarm — 로컬 배너 게시 (#3373)', () => {
  const params = {
    tripToken: 'trip-1',
    station: '건대입구',
    kind: 'transfer' as const,
    title: '환승 알림',
    body: '다음 역 건대입구에서 환승하세요!',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSetItem.mockResolvedValue(undefined);
    mockedSchedule.mockResolvedValue('id');
    mockedPresented.mockResolvedValue([]);
    mockedDismiss.mockResolvedValue(undefined);
    mockStorage({ [SLEEP_MODE_KEY]: JSON.stringify(true) });
  });

  it('발사 시 로컬 알림 1건 게시: identifier=station-alarm(FG 소리 판정), sound=alarm.wav, time-sensitive, 즉시(trigger null)', async () => {
    const result = await fireCompanionAlarm(params);
    expect(result).toEqual({ fired: true, bannerPosted: true });
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
    expect(mockedSchedule).toHaveBeenCalledWith({
      identifier: 'station-alarm',
      content: {
        title: '환승 알림',
        body: '다음 역 건대입구에서 환승하세요!',
        sound: 'alarm.wav',
        interruptionLevel: 'timeSensitive',
      },
      trigger: null,
    });
  });

  it('Android: 취침 알람 채널(MAX) 사용', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await fireCompanionAlarm(params);
    const [[arg]] = mockedSchedule.mock.calls;
    expect(arg.content).toMatchObject({ channelId: 'station-alarm', priority: 'max' });
    jest.restoreAllMocks();
  });

  it('같은 칸 companion 2회 → 로컬 알림 1건 (ledger dedup)', async () => {
    // 첫 호출이 쓴 ledger를 다음 호출이 읽도록 setItem 값을 getItem에 반영.
    let ledger: string | null = null;
    mockedSetItem.mockImplementation(async (_k: string, v: string) => {
      ledger = v;
    });
    mockedGetItem.mockImplementation(async (key: string) => {
      if (key === SLEEP_MODE_KEY) return JSON.stringify(true);
      if (key === ALARM_LOCAL_LEDGER_KEY) return ledger;
      return null;
    });
    await fireCompanionAlarm(params);
    const second = await fireCompanionAlarm(params);
    expect(second).toEqual({ fired: false, reason: 'dedup' });
    expect(mockedSchedule).toHaveBeenCalledTimes(1);
  });

  it('일반 모드(sleepMode off): 로컬 알림 0건', async () => {
    mockStorage({ [SLEEP_MODE_KEY]: JSON.stringify(false) });
    await fireCompanionAlarm(params);
    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedPresented).not.toHaveBeenCalled();
  });

  it('게시 직후 title·body가 동일한 원격 알림만 dismiss (다른 문구·로컬 자신은 유지)', async () => {
    const remote = (identifier: string, title: string, body: string) => ({ request: { identifier, content: { title, body } } });
    mockedPresented.mockResolvedValue([
      remote('remote-1', '환승 알림', '다음 역 건대입구에서 환승하세요!'),
      remote('remote-other', '환승 알림', '다음 역 어린이대공원에서 환승하세요!'),
      remote('station-alarm', '환승 알림', '다음 역 건대입구에서 환승하세요!'),
    ]);
    await fireCompanionAlarm(params);
    expect(mockedDismiss).toHaveBeenCalledTimes(1);
    expect(mockedDismiss).toHaveBeenCalledWith('remote-1');
    // 로컬 게시가 dismiss보다 먼저(순서) — 둘 다 보이는 공백보다 중복이 낫다(ADR-010).
    expect(mockedSchedule.mock.invocationCallOrder[0]).toBeLessThan(mockedDismiss.mock.invocationCallOrder[0]);
  });

  it('presented 조회 실패해도 발사는 성공 (dismiss 생략)', async () => {
    mockedPresented.mockRejectedValue(new Error('boom'));
    const result = await fireCompanionAlarm(params);
    expect(result).toEqual({ fired: true, bannerPosted: true });
    expect(mockedDismiss).not.toHaveBeenCalled();
  });

  it('게시 실패: 진동/TTS는 유지하고 bannerPosted=false (원격 alert가 남아 있으니 dismiss 시도 안 함)', async () => {
    mockedSchedule.mockRejectedValue(new Error('denied'));
    const result = await fireCompanionAlarm(params);
    expect(result).toEqual({ fired: true, bannerPosted: false });
    expect(mockedVibrate).toHaveBeenCalledWith(true);
    expect(mockedPresented).not.toHaveBeenCalled();
    expect(mockedDismiss).not.toHaveBeenCalled();
  });
});
