/**
 * #2428 — `ALARM_CATEGORY` 알림의 [trip 종료] 액션(`ALARM_ACTION_END_TRIP`) 응답 handler.
 *
 * 버그: `notificationCategory.ts`가 `ALARM_CATEGORY`에 [확인]/[trip 종료] 버튼을 등록했지만
 * (`ALARM_ACTION_END_TRIP`), 이 액션 식별자를 소비하는 response listener가 어디에도 없었다 —
 * 탭해도 알림만 닫히고 trip이 그대로 유지되는 dead wire.
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
 *
 * #2722 — 이 파일은 더 이상 자체 `addNotificationResponseReceivedListener`를 등록하지 않는다.
 * 예전엔 `useBoardingPromptResponder`의 listener가 boarding-prompt payload만 통과시킨다는
 * 이유로 이 액션 전용 listener를 별도로 뒀지만, 실제로는 앱 전체에 response listener가 2개
 * 등록되는 상태였다(그 파일 헤더 주석이 "단일 listener"라 적었던 것과 불일치). 이제
 * `useBoardingPromptResponder`의 단일 dispatcher가 payload 없는 응답을 이 파일의
 * `handleAlarmEndTripResponse`(pure 함수, 로직 변경 없음)로 위임한다 — listener 등록은
 * 앱 전체에 1곳만 남는다.
 */
import { ALARM_ACTION_END_TRIP } from '../utils/notificationCategory';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { cleanupUserInitiatedEndedTrip } from '../utils/tripEndedCleanupSequence';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('alarmEndTripResponder');

/**
 * actionIdentifier 분기 — pure 함수. `useBoardingPromptResponder`의 단일 listener dispatcher가
 * boarding-prompt가 아닌 응답을 이 함수로 위임한다(`useBoardingPromptResponder.handleResponse`와
 * 동일한 "listener 밖 pure 함수" 패턴 — 테스트에서 직접 호출 가능).
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
