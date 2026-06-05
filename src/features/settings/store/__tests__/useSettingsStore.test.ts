import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '../useSettingsStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      sleepMode: false,
      allowSpeaker: true,
      accessibilityMode: false,
      locklessStationPassed: false,
    });
    jest.clearAllMocks();
  });

  // ── sleepMode ──

  it('초기 sleepMode는 false이다', () => {
    expect(useSettingsStore.getState().sleepMode).toBe(false);
  });

  it('setSleepMode: true를 설정하면 상태가 업데이트된다', async () => {
    await useSettingsStore.getState().setSleepMode(true);
    expect(useSettingsStore.getState().sleepMode).toBe(true);
  });

  it('setSleepMode: AsyncStorage에 저장한다', async () => {
    await useSettingsStore.getState().setSleepMode(true);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:sleep-mode',
      JSON.stringify(true),
    );
  });

  it('loadSleepMode: AsyncStorage에서 데이터를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(true));
    await useSettingsStore.getState().loadSleepMode();
    expect(useSettingsStore.getState().sleepMode).toBe(true);
  });

  it('loadSleepMode: AsyncStorage가 비어있으면 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useSettingsStore.getState().loadSleepMode();
    expect(useSettingsStore.getState().sleepMode).toBe(false);
  });

  it('loadSleepMode: AsyncStorage 오류 시 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useSettingsStore.getState().loadSleepMode();
    expect(useSettingsStore.getState().sleepMode).toBe(false);
  });

  // ── allowSpeaker ──

  it('초기 allowSpeaker는 true이다', () => {
    expect(useSettingsStore.getState().allowSpeaker).toBe(true);
  });

  it('setAllowSpeaker: false를 설정하면 상태가 업데이트된다', async () => {
    await useSettingsStore.getState().setAllowSpeaker(false);
    expect(useSettingsStore.getState().allowSpeaker).toBe(false);
  });

  it('setAllowSpeaker: AsyncStorage에 저장한다', async () => {
    await useSettingsStore.getState().setAllowSpeaker(false);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:allow-speaker',
      JSON.stringify(false),
    );
  });

  it('loadAllowSpeaker: AsyncStorage에서 false를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(false));
    await useSettingsStore.getState().loadAllowSpeaker();
    expect(useSettingsStore.getState().allowSpeaker).toBe(false);
  });

  it('loadAllowSpeaker: AsyncStorage에서 true를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(true));
    await useSettingsStore.getState().loadAllowSpeaker();
    expect(useSettingsStore.getState().allowSpeaker).toBe(true);
  });

  it('loadAllowSpeaker: AsyncStorage가 비어있으면 true를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useSettingsStore.getState().loadAllowSpeaker();
    expect(useSettingsStore.getState().allowSpeaker).toBe(true);
  });

  it('loadAllowSpeaker: AsyncStorage 오류 시 true를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useSettingsStore.getState().loadAllowSpeaker();
    expect(useSettingsStore.getState().allowSpeaker).toBe(true);
  });

  // ── accessibilityMode ──

  it('초기 accessibilityMode는 false다', () => {
    expect(useSettingsStore.getState().accessibilityMode).toBe(false);
  });

  it('setAccessibilityMode: 상태를 업데이트하고 AsyncStorage에 저장한다', async () => {
    await useSettingsStore.getState().setAccessibilityMode(true);
    expect(useSettingsStore.getState().accessibilityMode).toBe(true);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:accessibility-mode',
      JSON.stringify(true),
    );
  });

  it('loadAccessibilityMode: AsyncStorage에서 true를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(true));
    await useSettingsStore.getState().loadAccessibilityMode();
    expect(useSettingsStore.getState().accessibilityMode).toBe(true);
  });

  it('loadAccessibilityMode: AsyncStorage가 비어있으면 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useSettingsStore.getState().loadAccessibilityMode();
    expect(useSettingsStore.getState().accessibilityMode).toBe(false);
  });

  it('loadAccessibilityMode: AsyncStorage 오류 시 false를 유지한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useSettingsStore.getState().loadAccessibilityMode();
    expect(useSettingsStore.getState().accessibilityMode).toBe(false);
  });

  // ── #816 C — locklessStationPassed opt-in 토글 (기본 OFF) ──

  it('초기 locklessStationPassed는 false이다', () => {
    expect(useSettingsStore.getState().locklessStationPassed).toBe(false);
  });

  it('setLocklessStationPassed: true를 설정하면 상태와 AsyncStorage가 갱신된다', async () => {
    await useSettingsStore.getState().setLocklessStationPassed(true);
    expect(useSettingsStore.getState().locklessStationPassed).toBe(true);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:lockless-station-passed',
      JSON.stringify(true),
    );
  });

  it('loadLocklessStationPassed: 저장된 true를 복원한다', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(true));
    await useSettingsStore.getState().loadLocklessStationPassed();
    expect(useSettingsStore.getState().locklessStationPassed).toBe(true);
  });

  it('loadLocklessStationPassed: 저장된 값이 없으면 기본 false 유지', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useSettingsStore.getState().loadLocklessStationPassed();
    expect(useSettingsStore.getState().locklessStationPassed).toBe(false);
  });

  it('loadLocklessStationPassed: AsyncStorage 오류 시 false 유지', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useSettingsStore.getState().loadLocklessStationPassed();
    expect(useSettingsStore.getState().locklessStationPassed).toBe(false);
  });
});
