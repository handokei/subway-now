/**
 * #2428 — `ALARM_CATEGORY` 알림의 [trip 종료] 액션(`ALARM_ACTION_END_TRIP`) 응답 handler.
 *
 * 버그: `notificationCategory.ts`가 `ALARM_CATEGORY`에 [확인]/[trip 종료] 버튼을 등록했지만
 * (`ALARM_ACTION_END_TRIP`), 이 액션 식별자를 소비하는 response listener가 어디에도 없었다 —
 * 탭해도 알림만 닫히고 trip이 그대로 유지되는 dead wire.
 *
 * `useBoardingPromptResponder`의 단일 listener는 `extractBoardingPromptPayload`가
 * `kind: 'boarding-prompt'` payload만 통과시켜, ALARM_CATEGORY 알림(다른 payload shape)은
 * 조기 return으로 걸러진다. expo-notifications는 multi-listener를 허용하므로
 * (`useBoardingPromptResponder.ts` 헤더 주석과 동일 전제) 이 액션 전용 listener를 별도로 둔다.
 *
 * cleanup은 `tripEndedCleanupSequence.ts`의 `cleanupUserInitiatedEndedTrip`을 그대로 재사용 —
 * `cleanupBackendConfirmedEndedTrip`과 동일한 5단 시퀀스(corrId snapshot → runTripBoundCleanups
 * → triggerTripGroundTruthPrompt → destination store reset → sentinel)를 공유해 drift를
 * 방지한다.
 *
 * 명시적 사용자 탭에만 발화 — `actionIdentifier === ALARM_ACTION_END_TRIP`만 매칭하므로
 * 다른 액션/기본 탭/dismiss는 이 handler를 절대 타지 않는다(오발화 위험 없음). trip이 이미
 * 없을 때(=`getTripStartedAt()` null) 탭되면 cleanup을 호출하지 않고 no-op — 이미 없는 trip을
 * 대상으로 storage/breadcrumb/sentinel을 재발생시키지 않는다.
 */
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { ALARM_ACTION_END_TRIP } from '../utils/notificationCategory';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { cleanupUserInitiatedEndedTrip } from '../utils/tripEndedCleanupSequence';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('alarmEndTripResponder');

/**
 * `ALARM_ACTION_END_TRIP` 응답 listener를 등록한다. app root(`app/_layout.tsx`)에서 1회 마운트.
 */
export function useAlarmEndTripResponder(): void {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      void handleAlarmEndTripResponse(response.actionIdentifier);
    });
    return () => sub.remove();
  }, []);
}

/**
 * actionIdentifier 분기 — pure 함수로 export해 테스트에서 직접 호출 가능
 * (`useBoardingPromptResponder.handleResponse`와 동일 패턴).
 */
export async function handleAlarmEndTripResponse(actionIdentifier: string): Promise<void> {
  if (actionIdentifier !== ALARM_ACTION_END_TRIP) return;

  const tripStartedAt = await getTripStartedAt();
  if (tripStartedAt === null) {
    // trip이 이미 종료된 뒤 늦게 탭된 케이스 — cleanup 재실행 없이 graceful no-op.
    log.info('ALARM_ACTION_END_TRIP tapped with no active trip — no-op');
    return;
  }

  await cleanupUserInitiatedEndedTrip(Date.now());
}
