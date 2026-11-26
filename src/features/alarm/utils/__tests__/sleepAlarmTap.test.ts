/* eslint-disable import/no-restricted-paths --
 * #3377 — useAlarmEventStore/useSettingsStore cross-feature orchestration(스토어 본체와 동일 사유).
 */
/**
 * #3377 — 취침 알람 알림 탭 → 오버레이 재생(30분 창) + 홈 이동.
 * 판정: 로컬 `ALARM_NOTIFICATION_ID` 또는 원격 `aps.sound === alarm.wav`(#3374).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { handleSleepAlarmTap, isSleepAlarmNotification } from '../sleepAlarmTap';
import { ALARM_NOTIFICATION_ID } from '../stationNotification';
import { useAlarmEventStore } from '../../store/useAlarmEventStore';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { ALARM_SOUND_FILE } from '../../../../shared/constants/alarmSoundFile';
import { PENDING_SLEEP_ALARM_OVERLAY_KEY, SLEEP_MODE_KEY } from '../../../../shared/constants/storageKeys';
import { ALARM_OVERLAY_TAP_WINDOW_MS } from '../../../../shared/constants/alarmOverlayReplay';
import type { AlarmEvent } from '../../../../shared/types/alarm';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidNotificationPriority: { MAX: 'max' },
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  dismissNotificationAsync: jest.fn(),
}));
jest.mock('live-activity', () => ({}), { virtual: true });

const EVENT: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '용마산', stationId: '7-015' };
const DEFAULT_ACTION = Notifications.DEFAULT_ACTION_IDENTIFIER;
const DATA = { nextStation: '용마산', nextLine: '7', targetKind: 'destination', originStation: '중곡' };

function notification(opts: { identifier?: string; data?: unknown; apsSound?: string; date?: number } = {}) {
  const { identifier = ALARM_NOTIFICATION_ID, data, apsSound, date = Date.now() } = opts;
  return {
    date,
    request: {
      identifier,
      content: { data },
      trigger: apsSound === undefined ? null : { type: 'push', payload: { aps: { sound: apsSound } } },
    },
  } as unknown as Notifications.Notification;
}
const response = (n: Notifications.Notification, actionIdentifier = DEFAULT_ACTION) =>
  ({ actionIdentifier, notification: n }) as unknown as Notifications.NotificationResponse;

async function seedPending(ageMs: number) {
  await AsyncStorage.setItem(PENDING_SLEEP_ALARM_OVERLAY_KEY, JSON.stringify({ event: EVENT, firedAt: Date.now() - ageMs }));
}
const shown = () => useAlarmEventStore.getState().alarmEvent;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  useAlarmEventStore.setState({ alarmEvent: null });
  useSettingsStore.setState({ sleepMode: false });
  await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(true));
});

describe('isSleepAlarmNotification', () => {
  it('로컬 알람(identifier=ALARM_NOTIFICATION_ID)', () => {
    expect(isSleepAlarmNotification(notification())).toBe(true);
  });
  it('원격 취침 알람(aps.sound=alarm.wav, auto-gen identifier)', () => {
    expect(isSleepAlarmNotification(notification({ identifier: 'uuid-1', apsSound: ALARM_SOUND_FILE }))).toBe(true);
  });
  it('다른 알림(프롬프트·매역 등)은 false', () => {
    expect(isSleepAlarmNotification(notification({ identifier: 'uuid-2' }))).toBe(false);
    expect(isSleepAlarmNotification(notification({ identifier: 'uuid-3', apsSound: 'default' }))).toBe(false);
  });
});

describe('handleSleepAlarmTap', () => {
  it('로컬 알람 탭(5분 뒤) → 저장 이벤트 표시 + 홈 이동', async () => {
    await seedPending(5 * 60_000);
    const navigate = jest.fn();
    await handleSleepAlarmTap(response(notification()), navigate);
    expect(shown()).toEqual(EVENT);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('원격 알람 탭 → 같은 재생 + 홈 이동', async () => {
    await seedPending(60_000);
    const navigate = jest.fn();
    await handleSleepAlarmTap(response(notification({ identifier: 'uuid-1', apsSound: ALARM_SOUND_FILE })), navigate);
    expect(shown()).toEqual(EVENT);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('알람이 아닌 알림 탭은 건드리지 않는다 (저장 키 보존, 이동 없음)', async () => {
    await seedPending(60_000);
    const navigate = jest.fn();
    await handleSleepAlarmTap(response(notification({ identifier: 'uuid-9' })), navigate);
    expect(shown()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)).not.toBeNull();
  });

  it('기본 탭이 아닌 액션(dismiss 등)은 무시', async () => {
    await seedPending(60_000);
    const navigate = jest.fn();
    await handleSleepAlarmTap(response(notification(), 'DISMISS_ACTION'), navigate);
    expect(shown()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('저장 이벤트가 31분 지난 경우 + data 없음 → 표시·이동 없음', async () => {
    await seedPending(ALARM_OVERLAY_TAP_WINDOW_MS + 60_000);
    const navigate = jest.fn();
    await handleSleepAlarmTap(response(notification()), navigate);
    expect(shown()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('저장 이벤트 없음 + 로컬 알림 data → 이벤트를 재구성해 표시', async () => {
    const navigate = jest.fn();
    await handleSleepAlarmTap(response(notification({ data: DATA })), navigate);
    expect(shown()).toMatchObject({ phaseId: 'early', type: 'destination', stationName: '용마산' });
    expect(shown()?.stationId).toMatch(/^7-/);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('data 재구성은 band도 보존', async () => {
    await handleSleepAlarmTap(response(notification({ data: { ...DATA, band: 3 } })), jest.fn());
    expect(shown()).toMatchObject({ band: 3 });
  });

  it('알림이 30분보다 오래된 경우 data 재구성도 하지 않는다', async () => {
    const navigate = jest.fn();
    const old = notification({ data: DATA, date: Date.now() - ALARM_OVERLAY_TAP_WINDOW_MS - 1000 });
    await handleSleepAlarmTap(response(old), navigate);
    expect(shown()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('data가 불완전하면 재구성 불가 → 표시 없음', async () => {
    await handleSleepAlarmTap(response(notification({ data: { nextStation: '용마산' } })), jest.fn());
    expect(shown()).toBeNull();
  });

  it('재구성 대상 역이 stations.json에 없으면 표시 없음', async () => {
    await handleSleepAlarmTap(response(notification({ data: { ...DATA, nextStation: '없는역' } })), jest.fn());
    expect(shown()).toBeNull();
  });

  it('일반 모드(storage sleepMode=false)에서는 표시·이동 모두 없음', async () => {
    await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(false));
    await seedPending(60_000);
    const navigate = jest.fn();
    await handleSleepAlarmTap(response(notification()), navigate);
    expect(shown()).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigate 미전달이어도 재생은 동작', async () => {
    await seedPending(60_000);
    await handleSleepAlarmTap(response(notification()));
    expect(shown()).toEqual(EVENT);
  });
});
