/* eslint-disable import/no-restricted-paths --
 * B1 (Epic #1008, ADR-013) — settings store가 alarm feature의 BoardingLockStore를
 * 호출하는 orchestration 동작을 검증하기 위해 mock import가 필요하다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSettingsStore } from '../useSettingsStore';
import {
  getSentryOptIn,
  setSentryOptIn,
} from '../../../../shared/infra/monitoring/sentryInit';
import { useBoardingLockStore } from '../../../alarm/store/useBoardingLockStore';
import { emitLocklessToggleTransition } from '../../utils/locklessFunnel';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('../../../../shared/infra/monitoring/sentryInit', () => ({
  getSentryOptIn: jest.fn().mockResolvedValue(false),
  setSentryOptIn: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/locklessFunnel', () => ({
  emitLocklessToggleTransition: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../alarm/store/useBoardingLockStore', () => ({
  useBoardingLockStore: {
    getState: jest.fn(() => ({
      releaseLock: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

const getSentryOptInMock = getSentryOptIn as jest.Mock;
const setSentryOptInMock = setSentryOptIn as jest.Mock;
const useBoardingLockStoreMock = useBoardingLockStore as unknown as {
  getState: jest.Mock;
};

describe('useSettingsStore', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      sleepMode: false,
      allowSpeaker: true,
      accessibilityMode: false,
      // #915 — default ON. 각 테스트가 명시적으로 false로 덮어쓸 수 있다.
      locklessStationPassed: true,
      sentryOptIn: false,
    });
    jest.clearAllMocks();
    getSentryOptInMock.mockResolvedValue(false);
    setSentryOptInMock.mockResolvedValue(undefined);
    useBoardingLockStoreMock.getState.mockReturnValue({
      releaseLock: jest.fn().mockResolvedValue(undefined),
    });
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

  // ── #816 C / #915 — locklessStationPassed (기본 ON, destination-only baseline) ──

  it('초기 locklessStationPassed는 true이다 (#915 default ON)', () => {
    expect(useSettingsStore.getState().locklessStationPassed).toBe(true);
  });

  it('setLocklessStationPassed: false를 설정하면 상태와 AsyncStorage가 갱신된다', async () => {
    await useSettingsStore.getState().setLocklessStationPassed(false);
    expect(useSettingsStore.getState().locklessStationPassed).toBe(false);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:lockless-station-passed',
      JSON.stringify(false),
    );
  });

  it('setLocklessStationPassed: true를 설정하면 상태와 AsyncStorage가 갱신된다', async () => {
    useSettingsStore.setState({ locklessStationPassed: false });
    await useSettingsStore.getState().setLocklessStationPassed(true);
    expect(useSettingsStore.getState().locklessStationPassed).toBe(true);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'subway-now:lockless-station-passed',
      JSON.stringify(true),
    );
  });

  // B1 (Epic #1008, ADR-013) — 토글 OFF 시 활성 BoardingLock cleanup
  it('setLocklessStationPassed(false): useBoardingLockStore.releaseLock을 호출한다', async () => {
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    useBoardingLockStoreMock.getState.mockReturnValue({ releaseLock });
    await useSettingsStore.getState().setLocklessStationPassed(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('setLocklessStationPassed(true): releaseLock을 호출하지 않는다', async () => {
    const releaseLock = jest.fn().mockResolvedValue(undefined);
    useBoardingLockStoreMock.getState.mockReturnValue({ releaseLock });
    await useSettingsStore.getState().setLocklessStationPassed(true);
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('loadLocklessStationPassed: 저장된 false를 복원한다 (기존 사용자 명시 OFF 보존)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(false));
    await useSettingsStore.getState().loadLocklessStationPassed();
    expect(useSettingsStore.getState().locklessStationPassed).toBe(false);
  });

  it('loadLocklessStationPassed: 저장된 값이 없으면 기본 true 유지 (#915)', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    await useSettingsStore.getState().loadLocklessStationPassed();
    expect(useSettingsStore.getState().locklessStationPassed).toBe(true);
  });

  it('loadLocklessStationPassed: AsyncStorage 오류 시 true 유지', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage error'));
    await useSettingsStore.getState().loadLocklessStationPassed();
    expect(useSettingsStore.getState().locklessStationPassed).toBe(true);
  });

  // #1175 — lockless funnel transition emit
  it('setLocklessStationPassed: prev=true → next=false 시 emit(true, false) 호출', async () => {
    useSettingsStore.setState({ locklessStationPassed: true });
    await useSettingsStore.getState().setLocklessStationPassed(false);
    expect(emitLocklessToggleTransition).toHaveBeenCalledWith(true, false);
  });

  it('setLocklessStationPassed: prev=false → next=true 시 emit(false, true) 호출', async () => {
    useSettingsStore.setState({ locklessStationPassed: false });
    await useSettingsStore.getState().setLocklessStationPassed(true);
    expect(emitLocklessToggleTransition).toHaveBeenCalledWith(false, true);
  });

  // ── #1038 — sentryOptIn (default OFF, opt-in only) ──

  it('초기 sentryOptIn은 false다 (#1038 default OFF)', () => {
    expect(useSettingsStore.getState().sentryOptIn).toBe(false);
  });

  it('setSentryOptIn: true → 상태 갱신 + sentryInit.setSentryOptIn(true) 호출', async () => {
    await useSettingsStore.getState().setSentryOptIn(true);
    expect(useSettingsStore.getState().sentryOptIn).toBe(true);
    expect(setSentryOptInMock).toHaveBeenCalledWith(true);
  });

  it('setSentryOptIn: false → 상태 갱신 + sentryInit.setSentryOptIn(false) 호출', async () => {
    useSettingsStore.setState({ sentryOptIn: true });
    await useSettingsStore.getState().setSentryOptIn(false);
    expect(useSettingsStore.getState().sentryOptIn).toBe(false);
    expect(setSentryOptInMock).toHaveBeenCalledWith(false);
  });

  it('loadSentryOptIn: 저장된 true를 복원한다', async () => {
    getSentryOptInMock.mockResolvedValueOnce(true);
    await useSettingsStore.getState().loadSentryOptIn();
    expect(useSettingsStore.getState().sentryOptIn).toBe(true);
  });

  it('loadSentryOptIn: 저장값 없으면 false 유지', async () => {
    getSentryOptInMock.mockResolvedValueOnce(false);
    await useSettingsStore.getState().loadSentryOptIn();
    expect(useSettingsStore.getState().sentryOptIn).toBe(false);
  });
});
