import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ONBOARDING_COMPLETED_KEY = 'subway-now:onboarding-completed';

export interface OnboardingState {
  hasCompletedOnboarding: boolean;
  loadOnboardingState: () => Promise<void>;
  completeOnboarding: () => Promise<void>;
}

export const useOnboardingStore = create<OnboardingState>((set) => ({
  hasCompletedOnboarding: false,

  loadOnboardingState: async () => {
    try {
      const raw = await AsyncStorage.getItem(ONBOARDING_COMPLETED_KEY);
      set({ hasCompletedOnboarding: raw === 'true' });
    } catch {
      // 저장된 데이터 없음 — false 유지
    }
  },

  completeOnboarding: async () => {
    set({ hasCompletedOnboarding: true });
    await AsyncStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
  },
}));
