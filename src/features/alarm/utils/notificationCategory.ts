/**
 * iOS UNNotificationCategory 등록 (#819 B 슬라이스).
 *
 * APNs alert payload의 `aps.category`가 식별자와 매칭되면 푸시 알림에 우리가 등록한
 * 액션 버튼이 노출된다. 사용자가 액션을 탭하면 `Notifications.addNotificationResponseReceivedListener`가
 * `actionIdentifier`를 받아 분기 처리.
 *
 * Android는 expo-notifications가 category를 무시 — graceful no-op.
 */

import * as Notifications from 'expo-notifications';

/** APNs payload `aps.category`와 1:1 매칭. backend `BOARDING_PROMPT_CATEGORY`와 동기. */
export const BOARDING_PROMPT_CATEGORY = 'BOARDING_PROMPT';

/** [탑승] 액션 식별자 — 응답 listener가 분기 키로 사용. */
export const BOARDING_PROMPT_ACTION_BOARDED = 'BOARDING_PROMPT_BOARDED';
/** [미탑승] 액션 식별자. */
export const BOARDING_PROMPT_ACTION_NOT_BOARDED = 'BOARDING_PROMPT_NOT_BOARDED';

/**
 * BOARDING_PROMPT category 등록. 앱 부팅 시 1회 호출.
 * 실패는 graceful — category 미등록 시 알림이 평범한 alert로 표시되지만 사용자가 탭하면
 * 같은 listener가 default action으로 호출되니 trainCode 자동 lock은 계속 동작.
 */
export async function setupBoardingPromptCategory(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(BOARDING_PROMPT_CATEGORY, [
      {
        identifier: BOARDING_PROMPT_ACTION_BOARDED,
        buttonTitle: 'Boarded',
        options: {
          opensAppToForeground: true,
        },
      },
      {
        identifier: BOARDING_PROMPT_ACTION_NOT_BOARDED,
        buttonTitle: 'Not boarded',
        options: {
          // FG로 열지 않음 — 사용자가 푸시만 닫고 silent dismiss POST가 backend로 가게 한다.
          opensAppToForeground: false,
          isDestructive: true,
        },
      },
    ]);
  } catch {
    // graceful — Android/예외 시 기본 동작으로 폴백.
  }
}
