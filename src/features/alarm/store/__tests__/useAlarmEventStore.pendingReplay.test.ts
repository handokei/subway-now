/* eslint-disable import/no-restricted-paths --
 * #3377 — useAlarmEventStore.ts와 동일한 orchestration 사유(sleepMode 게이트 sibling store 세팅).
 */
/**
 * #3377 — FG 진입(loadAlarmEvent) 2분 창 재생 + 탭 재생(replayPendingAlarmOverlay).
 * 저장 키는 PENDING_SLEEP_ALARM_OVERLAY_KEY. ALARM_EVENT_KEY 경로는 drain-only 그대로.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAlarmEventStore } from '../useAlarmEventStore';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import {
  ALARM_EVENT_KEY,
  PENDING_SLEEP_ALARM_OVERLAY_KEY,
  SLEEP_MODE_KEY,
} from '../../../../shared/constants/storageKeys';
import {
  ALARM_OVERLAY_REPLAY_WINDOW_MS,
  ALARM_OVERLAY_TAP_WINDOW_MS,
} from '../../../../shared/constants/alarmOverlayReplay';
import type { AlarmEvent } from '../../../../shared/types/alarm';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const EVENT: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '용마산', stationId: '7-015' };
const FALLBACK: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '건대입구', stationId: '2-012' };

async function seedPending(ageMs: number, event: AlarmEvent = EVENT) {
  await AsyncStorage.setItem(PENDING_SLEEP_ALARM_OVERLAY_KEY, JSON.stringify({ event, firedAt: Date.now() - ageMs }));
}
const shown = () => useAlarmEventStore.getState().alarmEvent;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  useAlarmEventStore.setState({ alarmEvent: null });
  // 콜드 스타트 직후: 메모리 sleepMode 기본 false (storage hydrate 전).
  useSettingsStore.setState({ sleepMode: false });
  await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(true));
});

describe('loadAlarmEvent — FG 진입 재생 (2분 창)', () => {
  it('BG에서 1분 전 저장된 알람 → 오버레이 표시 + 키 삭제', async () => {
    await seedPending(60_000);
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toEqual(EVENT);
    expect(await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)).toBeNull();
  });

  it('3분 전 저장 → 표시 안 함 + 키 삭제 (#2210 stale 억제)', async () => {
    await seedPending(3 * 60_000);
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toBeNull();
    expect(await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)).toBeNull();
  });

  it('storage sleepMode=false면 표시 안 함 (메모리가 true여도 storage가 권위)', async () => {
    await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(false));
    useSettingsStore.setState({ sleepMode: true });
    await seedPending(1_000);
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toBeNull();
    expect(await AsyncStorage.getItem(PENDING_SLEEP_ALARM_OVERLAY_KEY)).toBeNull();
  });

  it('storage sleepMode 키가 없으면 표시 안 함', async () => {
    await AsyncStorage.removeItem(SLEEP_MODE_KEY);
    await seedPending(1_000);
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toBeNull();
  });

  it('메모리 sleepMode가 아직 false(hydrate race)여도 storage가 true면 표시한다', async () => {
    expect(useSettingsStore.getState().sleepMode).toBe(false);
    await seedPending(1_000);
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toEqual(EVENT);
  });

  it('저장값이 없으면 아무것도 하지 않는다', async () => {
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toBeNull();
  });

  it('ALARM_EVENT_KEY(무-firedAt, backgroundLocationTask)는 재생하지 않고 drain만 — 키 분리', async () => {
    await AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(FALLBACK));
    await seedPending(1_000);
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toEqual(EVENT);
    expect(await AsyncStorage.getItem(ALARM_EVENT_KEY)).toBeNull();
  });

  it('ALARM_EVENT_KEY만 있고 새 키가 없으면 표시 안 함 (drain-only 유지)', async () => {
    await AsyncStorage.setItem(ALARM_EVENT_KEY, JSON.stringify(FALLBACK));
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toBeNull();
  });

  it('재생 도중 storage 오류는 삼킨다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('io'));
    await expect(useAlarmEventStore.getState().loadAlarmEvent()).resolves.toBeUndefined();
  });

  it('두 번 연속 진입해도 한 번만 재생 (재생 후 키 삭제 → 이중 표시 없음)', async () => {
    await seedPending(1_000);
    await useAlarmEventStore.getState().loadAlarmEvent();
    useAlarmEventStore.setState({ alarmEvent: null });
    await useAlarmEventStore.getState().loadAlarmEvent();
    expect(shown()).toBeNull();
  });
});

describe('replayPendingAlarmOverlay — 탭 재생', () => {
  const replay = (opts: { windowMs?: number; fallback?: () => Promise<AlarmEvent | null> } = {}) =>
    useAlarmEventStore.getState().replayPendingAlarmOverlay({ windowMs: ALARM_OVERLAY_TAP_WINDOW_MS, ...opts });

  it('5분 전 저장도 탭 창(30분) 안이라 표시하고 true', async () => {
    await seedPending(5 * 60_000);
    expect(await replay()).toBe(true);
    expect(shown()).toEqual(EVENT);
  });

  it('같은 5분 전 저장은 FG 진입 창(2분)으로는 표시 안 함', async () => {
    await seedPending(5 * 60_000);
    expect(await replay({ windowMs: ALARM_OVERLAY_REPLAY_WINDOW_MS })).toBe(false);
    expect(shown()).toBeNull();
  });

  it('31분 전 저장은 탭이어도 표시 안 함 (지난 트립 오표시 방지)', async () => {
    await seedPending(31 * 60_000);
    expect(await replay()).toBe(false);
    expect(shown()).toBeNull();
  });

  it('저장 이벤트가 없으면 fallback(알림 data 재구성)을 표시', async () => {
    const fallback = jest.fn().mockResolvedValue(FALLBACK);
    expect(await replay({ fallback })).toBe(true);
    expect(shown()).toEqual(FALLBACK);
  });

  it('저장 이벤트가 있으면 fallback은 호출하지 않는다', async () => {
    await seedPending(1_000);
    const fallback = jest.fn().mockResolvedValue(FALLBACK);
    await replay({ fallback });
    expect(fallback).not.toHaveBeenCalled();
    expect(shown()).toEqual(EVENT);
  });

  it('fallback이 null이면 false', async () => {
    expect(await replay({ fallback: async () => null })).toBe(false);
    expect(shown()).toBeNull();
  });

  it('fallback 없고 저장도 없으면 false', async () => {
    expect(await replay()).toBe(false);
  });

  it('일반 모드(storage sleepMode=false)면 fallback도 표시 안 함', async () => {
    await AsyncStorage.setItem(SLEEP_MODE_KEY, JSON.stringify(false));
    expect(await replay({ fallback: async () => FALLBACK })).toBe(false);
    expect(shown()).toBeNull();
  });

  it('now 지정 시 그 시각 기준으로 창을 판정', async () => {
    await AsyncStorage.setItem(PENDING_SLEEP_ALARM_OVERLAY_KEY, JSON.stringify({ event: EVENT, firedAt: 1_000 }));
    expect(await replay({ windowMs: 60_000 })).toBe(false);
    await AsyncStorage.setItem(PENDING_SLEEP_ALARM_OVERLAY_KEY, JSON.stringify({ event: EVENT, firedAt: 1_000 }));
    expect(await useAlarmEventStore.getState().replayPendingAlarmOverlay({ windowMs: 60_000, now: 30_000 })).toBe(true);
  });
});
