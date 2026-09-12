/**
 * #1923 — useUserIntentStore 테스트.
 *
 * memory + AsyncStorage 동시 mutation + cold-start hydrate + reset helper 모두 cover.
 * coverage 100% — set true/false, load valid/invalid, persist 실패 graceful, resetUserIntentInfoMode wrapper.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useUserIntentStore,
  resetUserIntentInfoMode,
  resetBoardingCommitted,
} from '../useUserIntentStore';
import {
  USER_INTENT_INFO_MODE_KEY,
  USER_INTENT_BOARDING_COMMITTED_KEY,
} from '../../../../shared/constants/storageKeys';

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

describe('useUserIntentStore (#1923)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 매 테스트마다 store memory state reset (zustand는 모듈 싱글톤이라 leak 차단).
    useUserIntentStore.setState({ infoModeEnabled: false, boardingCommitted: false });
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  });

  describe('setInfoModeEnabled', () => {
    it('true → memory state + AsyncStorage 동기화 ("true" 영속화)', async () => {
      await useUserIntentStore.getState().setInfoModeEnabled(true);
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(true);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(USER_INTENT_INFO_MODE_KEY, 'true');
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    });

    it('false → memory state + AsyncStorage removeItem (키 삭제)', async () => {
      // 먼저 true로 set (선행 조건)
      await useUserIntentStore.getState().setInfoModeEnabled(true);
      (AsyncStorage.setItem as jest.Mock).mockClear();
      (AsyncStorage.removeItem as jest.Mock).mockClear();

      await useUserIntentStore.getState().setInfoModeEnabled(false);
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(USER_INTENT_INFO_MODE_KEY);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('setItem 실패해도 throw 없이 graceful (memory는 반영 유지)', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      await expect(
        useUserIntentStore.getState().setInfoModeEnabled(true),
      ).resolves.toBeUndefined();
      // memory는 이미 true로 반영됨
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(true);
    });

    it('removeItem 실패해도 throw 없이 graceful (memory는 false 유지)', async () => {
      // 사전 조건: true 상태
      useUserIntentStore.setState({ infoModeEnabled: true });
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('disk error'));
      await expect(
        useUserIntentStore.getState().setInfoModeEnabled(false),
      ).resolves.toBeUndefined();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
    });
  });

  describe('loadInfoModeEnabled', () => {
    it('storage에 "true" 있으면 memory state true로 hydrate', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');
      await useUserIntentStore.getState().loadInfoModeEnabled();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(true);
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(USER_INTENT_INFO_MODE_KEY);
    });

    it('storage가 키 부재(null)면 memory state false 유지', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await useUserIntentStore.getState().loadInfoModeEnabled();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
    });

    it('storage value가 "true"가 아니면 false로 hydrate (strict guard)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('false');
      await useUserIntentStore.getState().loadInfoModeEnabled();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
    });

    it('storage value가 임의 string이면 false로 hydrate', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('garbage-value');
      await useUserIntentStore.getState().loadInfoModeEnabled();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
    });

    it('getItem 실패해도 throw 없이 graceful (false 유지)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('disk error'));
      await expect(
        useUserIntentStore.getState().loadInfoModeEnabled(),
      ).resolves.toBeUndefined();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
    });
  });

  describe('resetUserIntentInfoMode (trip-bound cleanup helper)', () => {
    it('현재 true 상태에서 호출 시 false로 reset + AsyncStorage removeItem', async () => {
      useUserIntentStore.setState({ infoModeEnabled: true });
      await resetUserIntentInfoMode();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(USER_INTENT_INFO_MODE_KEY);
    });

    it('이미 false 상태에서 호출해도 idempotent (memory 그대로 false)', async () => {
      await resetUserIntentInfoMode();
      expect(useUserIntentStore.getState().infoModeEnabled).toBe(false);
      // removeItem은 false set 시에도 호출됨 (멱등 — 키 부재 시 graceful no-op).
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(USER_INTENT_INFO_MODE_KEY);
    });

    it('Promise를 반환해 TRIP_BOUND_CLEANUPS 배열 shape에 맞음', () => {
      const result = resetUserIntentInfoMode();
      expect(result).toBeInstanceOf(Promise);
    });
  });

  // #2524 — 탑승 커밋 시그널. infoModeEnabled와 동일 wiring pattern이지만 별도 키/필드로
  // 독립 lifecycle을 갖는다(안내 시작에서는 세팅되지 않음 — HomeScreen/useBoardingPromptResponder
  // 쪽 wiring 테스트가 이 구분을 커버).
  describe('setBoardingCommitted', () => {
    it('true → memory state + AsyncStorage 동기화 ("true" 영속화)', async () => {
      await useUserIntentStore.getState().setBoardingCommitted(true);
      expect(useUserIntentStore.getState().boardingCommitted).toBe(true);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        USER_INTENT_BOARDING_COMMITTED_KEY,
        'true',
      );
      expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
    });

    it('false → memory state + AsyncStorage removeItem (키 삭제)', async () => {
      await useUserIntentStore.getState().setBoardingCommitted(true);
      (AsyncStorage.setItem as jest.Mock).mockClear();
      (AsyncStorage.removeItem as jest.Mock).mockClear();

      await useUserIntentStore.getState().setBoardingCommitted(false);
      expect(useUserIntentStore.getState().boardingCommitted).toBe(false);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(USER_INTENT_BOARDING_COMMITTED_KEY);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('setItem 실패해도 throw 없이 graceful (memory는 반영 유지)', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
      await expect(
        useUserIntentStore.getState().setBoardingCommitted(true),
      ).resolves.toBeUndefined();
      expect(useUserIntentStore.getState().boardingCommitted).toBe(true);
    });

    it('removeItem 실패해도 throw 없이 graceful (memory는 false 유지)', async () => {
      useUserIntentStore.setState({ boardingCommitted: true });
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('disk error'));
      await expect(
        useUserIntentStore.getState().setBoardingCommitted(false),
      ).resolves.toBeUndefined();
      expect(useUserIntentStore.getState().boardingCommitted).toBe(false);
    });
  });

  describe('loadBoardingCommitted', () => {
    it('storage에 "true" 있으면 memory state true로 hydrate', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('true');
      await useUserIntentStore.getState().loadBoardingCommitted();
      expect(useUserIntentStore.getState().boardingCommitted).toBe(true);
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(USER_INTENT_BOARDING_COMMITTED_KEY);
    });

    it('storage가 키 부재(null)면 memory state false 유지', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await useUserIntentStore.getState().loadBoardingCommitted();
      expect(useUserIntentStore.getState().boardingCommitted).toBe(false);
    });

    it('storage value가 임의 string이면 false로 hydrate', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('garbage-value');
      await useUserIntentStore.getState().loadBoardingCommitted();
      expect(useUserIntentStore.getState().boardingCommitted).toBe(false);
    });

    it('getItem 실패해도 throw 없이 graceful (false 유지)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('disk error'));
      await expect(
        useUserIntentStore.getState().loadBoardingCommitted(),
      ).resolves.toBeUndefined();
      expect(useUserIntentStore.getState().boardingCommitted).toBe(false);
    });
  });

  describe('resetBoardingCommitted (trip-bound cleanup helper)', () => {
    it('현재 true 상태에서 호출 시 false로 reset + AsyncStorage removeItem', async () => {
      useUserIntentStore.setState({ boardingCommitted: true });
      await resetBoardingCommitted();
      expect(useUserIntentStore.getState().boardingCommitted).toBe(false);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(USER_INTENT_BOARDING_COMMITTED_KEY);
    });

    it('Promise를 반환해 TRIP_BOUND_CLEANUPS 배열 shape에 맞음', () => {
      const result = resetBoardingCommitted();
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
