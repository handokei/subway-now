/**
 * #3100 — 취침 알람 "N역 전" 설정 저장(store + AsyncStorage). 미설정 = undefined = 기본값.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '../useSettingsStore';
import { SLEEP_ALARM_CONFIG_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('../../../../shared/infra/monitoring/sentryInit', () => ({
  getSentryOptIn: jest.fn().mockResolvedValue(false),
  setSentryOptIn: jest.fn().mockResolvedValue(undefined),
}));

describe('useSettingsStore sleepAlarm (#3100)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ sleepAlarm: undefined });
    jest.clearAllMocks();
  });

  it('초기값은 undefined (= 기본 1역 전)', () => {
    expect(useSettingsStore.getState().sleepAlarm).toBeUndefined();
  });

  it('setSleepAlarm: 정리(normalize)된 설정을 상태와 AsyncStorage에 저장한다', async () => {
    await useSettingsStore.getState().setSleepAlarm({ mode: 'selected', stops: [1, 3, 3] });
    expect(useSettingsStore.getState().sleepAlarm).toEqual({ mode: 'selected', stops: [3, 1] });
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      SLEEP_ALARM_CONFIG_KEY,
      JSON.stringify({ mode: 'selected', stops: [3, 1] }),
    );
  });

  it('setSleepAlarm: 기본값과 같은 설정은 undefined로 정규화되어 키를 지운다', async () => {
    await useSettingsStore.getState().setSleepAlarm({ mode: 'selected', stops: [3] });
    await useSettingsStore.getState().setSleepAlarm({ mode: 'every', stops: [1] });
    expect(useSettingsStore.getState().sleepAlarm).toBeUndefined();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(SLEEP_ALARM_CONFIG_KEY);
  });

  it('setSleepAlarm(undefined): 설정을 지운다', async () => {
    await useSettingsStore.getState().setSleepAlarm({ mode: 'every', stops: [3] });
    await useSettingsStore.getState().setSleepAlarm(undefined);
    expect(useSettingsStore.getState().sleepAlarm).toBeUndefined();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(SLEEP_ALARM_CONFIG_KEY);
  });

  it('loadSleepAlarm: 저장된 설정을 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ mode: 'every', stops: [3] }));
    await useSettingsStore.getState().loadSleepAlarm();
    expect(useSettingsStore.getState().sleepAlarm).toEqual({ mode: 'every', stops: [3] });
  });

  it.each([
    ['저장값 없음', null],
    ['손상 JSON', '{not-json'],
    ['범위 밖 값', JSON.stringify({ mode: 'every', stops: [99] })],
    ['기본값과 같은 설정', JSON.stringify({ mode: 'selected', stops: [1] })],
  ])('loadSleepAlarm: %s → undefined 유지', async (_label, raw) => {
    useSettingsStore.setState({ sleepAlarm: { mode: 'every', stops: [3] } });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(raw);
    await useSettingsStore.getState().loadSleepAlarm();
    expect(useSettingsStore.getState().sleepAlarm).toBeUndefined();
  });

  it('loadSleepAlarm: storage 읽기 실패도 undefined', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    await useSettingsStore.getState().loadSleepAlarm();
    expect(useSettingsStore.getState().sleepAlarm).toBeUndefined();
  });
});
