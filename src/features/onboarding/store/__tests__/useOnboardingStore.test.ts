import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOnboardingStore, ONBOARDING_COMPLETED_KEY } from '../useOnboardingStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const mockGetItem = AsyncStorage.getItem as jest.Mock;
const mockSetItem = AsyncStorage.setItem as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useOnboardingStore.setState({ hasCompletedOnboarding: false });
});

describe('useOnboardingStore', () => {
  describe('loadOnboardingState', () => {
    it('sets hasCompletedOnboarding=true when storage has "true"', async () => {
      mockGetItem.mockResolvedValueOnce('true');
      await useOnboardingStore.getState().loadOnboardingState();
      expect(useOnboardingStore.getState().hasCompletedOnboarding).toBe(true);
    });

    it('keeps hasCompletedOnboarding=false when storage returns null', async () => {
      mockGetItem.mockResolvedValueOnce(null);
      await useOnboardingStore.getState().loadOnboardingState();
      expect(useOnboardingStore.getState().hasCompletedOnboarding).toBe(false);
    });

    it('keeps hasCompletedOnboarding=false when storage returns non-"true" value', async () => {
      mockGetItem.mockResolvedValueOnce('false');
      await useOnboardingStore.getState().loadOnboardingState();
      expect(useOnboardingStore.getState().hasCompletedOnboarding).toBe(false);
    });

    it('keeps hasCompletedOnboarding=false when AsyncStorage throws', async () => {
      mockGetItem.mockRejectedValueOnce(new Error('storage error'));
      await useOnboardingStore.getState().loadOnboardingState();
      expect(useOnboardingStore.getState().hasCompletedOnboarding).toBe(false);
    });
  });

  describe('completeOnboarding', () => {
    it('sets hasCompletedOnboarding=true in state', async () => {
      mockSetItem.mockResolvedValueOnce(undefined);
      await useOnboardingStore.getState().completeOnboarding();
      expect(useOnboardingStore.getState().hasCompletedOnboarding).toBe(true);
    });

    it('persists "true" to AsyncStorage under the correct key', async () => {
      mockSetItem.mockResolvedValueOnce(undefined);
      await useOnboardingStore.getState().completeOnboarding();
      expect(mockSetItem).toHaveBeenCalledWith(ONBOARDING_COMPLETED_KEY, 'true');
    });
  });
});
