/**
 * #3377 — BG에서 울린 취침 알람의 오버레이 이벤트 저장·회수 (PENDING_SLEEP_ALARM_OVERLAY_KEY).
 * 창 판정(2분/탭 30분)·형식 검증·키 분리를 검증한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ALARM_EVENT_KEY,
  DESTINATION_KEY,
  PENDING_SLEEP_ALARM_OVERLAY_KEY,
  ROUTE_KEY,
  SLEEP_MODE_KEY,
} from '../../../../shared/constants/storageKeys';
import {
  ALARM_OVERLAY_REPLAY_WINDOW_MS,
  ALARM_OVERLAY_TAP_WINDOW_MS,
} from '../../../../shared/constants/alarmOverlayReplay';
import {
  isSleepModeStored,
  parseCompanionOverlayFields,
  resolveCompanionOverlayEvent,
  savePendingSleepAlarmOverlay,
  takePendingSleepAlarmOverlay,
} from '../pendingSleepAlarmOverlay';
import type { AlarmEvent } from '../../../../shared/types/alarm';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const EVENT: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '용마산', stationId: '7-015' };
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('상수', () => {
  it('FG 진입 창 2분, 탭 창 30분', () => {
    expect(ALARM_OVERLAY_REPLAY_WINDOW_MS).toBe(2 * 60_000);
    expect(ALARM_OVERLAY_TAP_WINDOW_MS).toBe(30 * 60_000);
  });
  it('새 키는 ALARM_EVENT_KEY와 다르다 (backgroundLocationTask의 무-firedAt 쓰기와 분리)', () => {
    expect(PENDING_SLEEP_ALARM_OVERLAY_KEY).not.toBe(ALARM_EVENT_KEY);
  });
});

describe('savePendingSleepAlarmOverlay', () => {
  it('{event, firedAt}를 새 키에 저장한다', async () => {
    await savePendingSleepAlarmOverlay(EVENT, NOW);
    expect(JSON.parse((await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)) as string)).toEqual({ event: EVENT, firedAt: NOW });
  });

  it('최신 1건만 남긴다 (덮어쓰기)', async () => {
    await savePendingSleepAlarmOverlay({ ...EVENT, band: 3 }, NOW);
    await savePendingSleepAlarmOverlay(EVENT, NOW + 1000);
    expect(JSON.parse((await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)) as string)).toEqual({ event: EVENT, firedAt: NOW + 1000 });
  });

  it('ALARM_EVENT_KEY는 건드리지 않는다', async () => {
    await savePendingSleepAlarmOverlay(EVENT, NOW);
    expect(await AsyncStorage.getItem(ALARM_EVENT_KEY)).toBeNull();
  });

  it('저장 실패는 삼킨다 (알람 소리·ack를 막지 않는다)', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    await expect(savePendingSleepAlarmOverlay(EVENT, NOW)).resolves.toBeUndefined();
  });

  it('기본 firedAt = 현재 시각', async () => {
    const before = Date.now();
    await savePendingSleepAlarmOverlay(EVENT);
    const { firedAt } = JSON.parse((await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)) as string);
    expect(firedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('takePendingSleepAlarmOverlay', () => {
  const take = (windowMs: number, now = NOW) => takePendingSleepAlarmOverlay({ windowMs, now });

  it('창 안(1분)이면 이벤트를 돌려주고 키를 지운다', async () => {
    await savePendingSleepAlarmOverlay(EVENT, NOW - 60_000);
    expect(await take(ALARM_OVERLAY_REPLAY_WINDOW_MS)).toEqual(EVENT);
    expect(await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)).toBeNull();
  });

  it('경계: 정확히 창 길이면 통과, 1ms 초과면 버림', async () => {
    await savePendingSleepAlarmOverlay(EVENT, NOW - ALARM_OVERLAY_REPLAY_WINDOW_MS);
    expect(await take(ALARM_OVERLAY_REPLAY_WINDOW_MS)).toEqual(EVENT);
    await savePendingSleepAlarmOverlay(EVENT, NOW - ALARM_OVERLAY_REPLAY_WINDOW_MS - 1);
    expect(await take(ALARM_OVERLAY_REPLAY_WINDOW_MS)).toBeNull();
  });

  it('창 밖(3분)이면 null이고 키는 그래도 지운다', async () => {
    await savePendingSleepAlarmOverlay(EVENT, NOW - 3 * 60_000);
    expect(await take(ALARM_OVERLAY_REPLAY_WINDOW_MS)).toBeNull();
    expect(await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)).toBeNull();
  });

  it('탭 창(30분)은 5분 전 이벤트를 통과시키고 31분 전은 버린다', async () => {
    await savePendingSleepAlarmOverlay(EVENT, NOW - 5 * 60_000);
    expect(await take(ALARM_OVERLAY_TAP_WINDOW_MS)).toEqual(EVENT);
    await savePendingSleepAlarmOverlay(EVENT, NOW - 31 * 60_000);
    expect(await take(ALARM_OVERLAY_TAP_WINDOW_MS)).toBeNull();
  });

  it('키가 없으면 null (removeItem 호출 없음)', async () => {
    expect(await take(ALARM_OVERLAY_REPLAY_WINDOW_MS)).toBeNull();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it.each([
    ['구버전 형식(firedAt 없음)', JSON.stringify(EVENT)],
    ['event 없음', JSON.stringify({ firedAt: NOW })],
    ['stationId 없는 event', JSON.stringify({ event: { phaseId: 'early', type: 'destination', stationName: 'x' }, firedAt: NOW })],
    ['firedAt 비숫자', JSON.stringify({ event: EVENT, firedAt: 'now' })],
    ['JSON 아님', '{not json'],
    ['null 리터럴', 'null'],
  ])('형식 불일치(%s)는 버리고 키를 지운다', async (_label, raw) => {
    await AsyncStorage.setItem(PENDING_SLEEP_ALARM_OVERLAY_KEY, raw);
    expect(await take(ALARM_OVERLAY_TAP_WINDOW_MS)).toBeNull();
    expect(await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)).toBeNull();
  });

  it('storage 읽기 실패는 null', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('io'));
    expect(await take(ALARM_OVERLAY_REPLAY_WINDOW_MS)).toBeNull();
  });

  it('ALARM_EVENT_KEY(backgroundLocationTask가 firedAt 없이 씀)는 읽지 않는다 — 키 분리', async () => {
    await AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(EVENT));
    expect(await take(ALARM_OVERLAY_TAP_WINDOW_MS)).toBeNull();
    expect(await AsyncStorage.getItem(ALARM_EVENT_KEY)).not.toBeNull();
  });
});

describe('parseCompanionOverlayFields (로컬 알림 content.data)', () => {
  const valid = { nextStation: '용마산', nextLine: '7', targetKind: 'destination', originStation: '중곡' };

  it('필수 4필드가 있으면 그대로 돌려준다', () => {
    expect(parseCompanionOverlayFields(valid)).toEqual(valid);
  });
  it('band는 정수 ≥ 1일 때만 포함', () => {
    expect(parseCompanionOverlayFields({ ...valid, band: 3 })).toEqual({ ...valid, band: 3 });
    expect(parseCompanionOverlayFields({ ...valid, band: 0 })).toEqual(valid);
    expect(parseCompanionOverlayFields({ ...valid, band: '3' })).toEqual(valid);
  });
  it.each([
    ['null', null],
    ['문자열', 'x'],
    ['nextStation 누락', { ...valid, nextStation: undefined }],
    ['nextLine 누락', { ...valid, nextLine: 7 }],
    ['originStation 누락', { ...valid, originStation: undefined }],
    ['targetKind 범위 밖', { ...valid, targetKind: 'intermediate' }],
  ])('불완전(%s)하면 null', (_l, data) => {
    expect(parseCompanionOverlayFields(data)).toBeNull();
  });
});

describe('resolveCompanionOverlayEvent', () => {
  const fields = { nextStation: '용마산', nextLine: '7', targetKind: 'destination' as const, originStation: '중곡' };

  it('route 없이도 (역명, nextLine)으로 stationId를 찾는다', async () => {
    const event = await resolveCompanionOverlayEvent(fields);
    expect(event).toMatchObject({ phaseId: 'early', type: 'destination', stationName: '용마산' });
    expect(event?.stationId).toMatch(/^7-/);
  });

  it('band를 실어 보낸다', async () => {
    expect(await resolveCompanionOverlayEvent({ ...fields, band: 3 })).toMatchObject({ band: 3 });
  });

  it('storage 조회 실패에도 이벤트를 만든다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('io'));
    expect(await resolveCompanionOverlayEvent(fields)).not.toBeNull();
  });

  it('stations.json에 없는 역이면 null', async () => {
    expect(await resolveCompanionOverlayEvent({ ...fields, nextStation: '없는역' })).toBeNull();
  });

  it('저장된 route/destination을 읽는다 (조회 키 사용)', async () => {
    await resolveCompanionOverlayEvent(fields);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(ROUTE_KEY);
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(DESTINATION_KEY);
  });
});

describe('isSleepModeStored', () => {
  it.each([
    ['true', JSON.stringify(true), true],
    ['false', JSON.stringify(false), false],
    ['키 없음', null, false],
    ['깨진 값', '{x', false],
  ])('storage 값 %s -> %p', async (_l, raw, expected) => {
    if (raw !== null) await AsyncStorage.setItem(SLEEP_MODE_KEY, raw);
    expect(await isSleepModeStored()).toBe(expected);
  });

  it('읽기 실패는 false', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('io'));
    expect(await isSleepModeStored()).toBe(false);
  });
});
