/**
 * iOS UNNotificationCategory 등록 (#819 B 슬라이스, #1798 P2 카테고리 분리, #2282 DISEMBARK 분리).
 *
 * APNs alert payload의 `aps.category`가 식별자와 매칭되면 푸시 알림에 우리가 등록한
 * 액션 버튼이 노출된다. 사용자가 액션을 탭하면 `Notifications.addNotificationResponseReceivedListener`가
 * `actionIdentifier`를 받아 분기 처리.
 *
 * Android는 expo-notifications가 category를 무시 — graceful no-op.
 *
 * 카테고리 4종:
 *   - BOARDING_PROMPT   : "탑승했냐?" 푸시 (기존)
 *   - DISEMBARK_PROMPT  : "하차했냐?" (hop-end) 푸시 — BOARDING_PROMPT 재사용 시 iOS category-고정
 *     버튼 제약으로 질문-버튼 불일치가 발생해 분리 (#2282)
 *   - ALARM_CATEGORY    : transfer / destination 알람 — "확인" / "trip 종료" (#1798 P2)
 *   - TRIP_ENDED_CATEGORY: trip 종료 알림 — "다음 여정 시작" 딥링크 (#1798 P2)
 *
 * 버튼 라벨은 i18next.t()로 로컬라이즈한다(#2282) — 등록 시점(앱 부팅)의 현재 언어로 고정되며
 * 다른 파일의 `lastTrainAlarm.ts` 등과 동일 패턴(react-i18next 훅이 아닌 `i18next` default import).
 */

import * as Notifications from 'expo-notifications';
import i18next from 'i18next';

/** APNs payload `aps.category`와 1:1 매칭. backend `BOARDING_PROMPT_CATEGORY`와 동기. */
export const BOARDING_PROMPT_CATEGORY = 'BOARDING_PROMPT';

/** [탑승] 액션 식별자 — 응답 listener가 분기 키로 사용. */
export const BOARDING_PROMPT_ACTION_BOARDED = 'BOARDING_PROMPT_BOARDED';
/** [미탑승] 액션 식별자. */
export const BOARDING_PROMPT_ACTION_NOT_BOARDED = 'BOARDING_PROMPT_NOT_BOARDED';

/**
 * #2282 — hop-end(환승역 하차) 전용 카테고리. APNs payload `aps.category`와 1:1 매칭.
 * backend `DISEMBARK_PROMPT_CATEGORY`와 동기.
 */
export const DISEMBARK_PROMPT_CATEGORY = 'DISEMBARK_PROMPT';

/** [하차했어요] 액션 식별자. */
export const DISEMBARK_ACTION_DISEMBARKED = 'DISEMBARK_PROMPT_DISEMBARKED';
/** [아직이요] 액션 식별자. */
export const DISEMBARK_ACTION_NOT_YET = 'DISEMBARK_PROMPT_NOT_YET';

/** #1798 P2 — transfer / destination 알람 카테고리. backend `ALARM_CATEGORY`와 동기. */
export const ALARM_CATEGORY = 'ALARM_CATEGORY';
/** [확인] 액션 식별자 — 알람 인지. */
export const ALARM_ACTION_ACKNOWLEDGE = 'ALARM_ACTION_ACKNOWLEDGE';
/** [trip 종료] 액션 식별자 — 사용자가 알람을 받고 trip을 즉시 종료. */
export const ALARM_ACTION_END_TRIP = 'ALARM_ACTION_END_TRIP';

/** #1798 P2 — trip 종료 알림 카테고리. backend `TRIP_ENDED_CATEGORY`와 동기. */
export const TRIP_ENDED_CATEGORY = 'TRIP_ENDED_CATEGORY';
/** [다음 여정 시작] 액션 식별자 — 앱을 FG로 열어 새 경로 탐색을 시작. */
export const TRIP_ENDED_ACTION_NEXT_TRIP = 'TRIP_ENDED_ACTION_NEXT_TRIP';

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
        buttonTitle: i18next.t('notifications.actions.boardingConfirm'),
        options: {
          opensAppToForeground: true,
        },
      },
      {
        identifier: BOARDING_PROMPT_ACTION_NOT_BOARDED,
        buttonTitle: i18next.t('notifications.actions.notYet'),
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

/**
 * #2282 — DISEMBARK_PROMPT category 등록. 앱 부팅 시 1회 호출.
 * 실패는 graceful — category 미등록 시 알림이 평범한 alert로 표시되지만 사용자가 탭하면
 * 같은 listener가 default action으로 호출되니 `handleHopEndResponse`는 계속 동작.
 */
export async function setupDisembarkPromptCategory(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(DISEMBARK_PROMPT_CATEGORY, [
      {
        identifier: DISEMBARK_ACTION_DISEMBARKED,
        buttonTitle: i18next.t('notifications.actions.disembarkConfirm'),
        options: {
          opensAppToForeground: true,
        },
      },
      {
        identifier: DISEMBARK_ACTION_NOT_YET,
        buttonTitle: i18next.t('notifications.actions.notYet'),
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

/**
 * #1798 P2 — ALARM_CATEGORY 등록. transfer / destination 알람에 [확인] / [trip 종료] 버튼 노출.
 * 앱 부팅 시 1회 호출. 실패는 graceful — 미등록 시 액션 없는 alert로 폴백.
 */
export async function setupAlarmCategory(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(ALARM_CATEGORY, [
      {
        identifier: ALARM_ACTION_ACKNOWLEDGE,
        buttonTitle: '확인',
        options: {
          opensAppToForeground: false,
        },
      },
      {
        identifier: ALARM_ACTION_END_TRIP,
        buttonTitle: 'trip 종료',
        options: {
          opensAppToForeground: false,
          isDestructive: true,
        },
      },
    ]);
  } catch {
    // graceful — Android/예외 시 기본 동작으로 폴백.
  }
}

/**
 * #1798 P2 — TRIP_ENDED_CATEGORY 등록. trip 종료 알림에 [다음 여정 시작] 딥링크 버튼 노출.
 * 앱 부팅 시 1회 호출. 실패는 graceful — 미등록 시 액션 없는 alert로 폴백.
 */
export async function setupTripEndedCategory(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(TRIP_ENDED_CATEGORY, [
      {
        identifier: TRIP_ENDED_ACTION_NEXT_TRIP,
        buttonTitle: '다음 여정 시작',
        options: {
          opensAppToForeground: true,
        },
      },
    ]);
  } catch {
    // graceful — Android/예외 시 기본 동작으로 폴백.
  }
}
