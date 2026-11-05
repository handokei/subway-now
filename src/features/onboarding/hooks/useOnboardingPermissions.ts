import { useState } from 'react';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

export type PermissionStep = 'idle' | 'requesting-location' | 'requesting-notification' | 'done';

export interface OnboardingPermissionsResult {
  step: PermissionStep;
  requestPermissionsSequentially: () => Promise<void>;
}

/**
 * 온보딩용 권한 직렬 요청 훅.
 * foreground location → notification 순서로 요청한다.
 * 사용자가 거부해도 오류 없이 다음 단계로 진행 (graceful).
 */
export function useOnboardingPermissions(): OnboardingPermissionsResult {
  const [step, setStep] = useState<PermissionStep>('idle');

  const requestPermissionsSequentially = async (): Promise<void> => {
    setStep('requesting-location');
    try {
      await Location.requestForegroundPermissionsAsync();
    } catch {
      // 거부 또는 에러 — graceful 진행
    }

    setStep('requesting-notification');
    try {
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true },
      });
    } catch {
      // 거부 또는 에러 — graceful 진행
    }

    setStep('done');
  };

  return { step, requestPermissionsSequentially };
}
