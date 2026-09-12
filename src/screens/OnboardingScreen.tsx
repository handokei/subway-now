import { useState } from 'react';
import { useRouter } from 'expo-router';
import { ScreenContainer } from '../shared/ui/ScreenContainer';
import { OnboardingSplash1 } from '../features/onboarding/components/OnboardingSplash1';
import { OnboardingSplash2 } from '../features/onboarding/components/OnboardingSplash2';
import { useOnboardingPermissions } from '../features/onboarding/hooks/useOnboardingPermissions';
import { useOnboardingStore } from '../features/onboarding/store/useOnboardingStore';

type SplashPage = 1 | 2;

/**
 * 첫 실행 온보딩 화면.
 * Splash 1: 앱 가치 안내 → Splash 2: 권한 사전 맥락 + 직렬 요청.
 * 완료 또는 건너뛰기 시 AsyncStorage에 영속화 후 홈으로 이동.
 */
export default function OnboardingScreen() {
  const [page, setPage] = useState<SplashPage>(1);
  const { step, requestPermissionsSequentially } = useOnboardingPermissions();
  const completeOnboarding = useOnboardingStore((s) => s.completeOnboarding);
  const router = useRouter();

  const finish = async () => {
    await completeOnboarding();
    router.replace('/');
  };

  const handleGrantPermissions = async () => {
    await requestPermissionsSequentially();
    await finish();
  };

  if (page === 1) {
    return (
      <ScreenContainer>
        <OnboardingSplash1 onNext={() => setPage(2)} onSkip={finish} />
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer>
      <OnboardingSplash2
        step={step}
        onGrantPermissions={handleGrantPermissions}
        onSkip={finish}
      />
    </ScreenContainer>
  );
}
