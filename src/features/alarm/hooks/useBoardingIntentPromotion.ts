import { useEffect } from 'react';
import { isRealBoardingLock } from '../../../shared/constants/boardingLock';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { useUserIntentStore } from '../store/useUserIntentStore';

/**
 * #2792 — C 하이브리드: 탑승 확정(boardingLock) 후 promptOptIn을 매역 intent(infoModeEnabled)로
 * 승격한다.
 *
 * 배경(회귀): #2772에서 "안내 시작"이 `setInfoModeEnabled(true)` 자동 wire를 잃고 `promptOptIn`만
 * set하게 됐다. 매역 device FG 발사 게이트(`useStationAlarm.isLocklessNoUserIntent`)는
 * `infoModeEnabled`만 보고 `promptOptIn`을 보지 않아, 환승 후 leg-2에서 lock이 풀리고 프롬프트
 * 무응답이면 `infoModeEnabled=false`로 남아 매역 알림이 전멸했다.
 *
 * 갭은 auto-lock(device evidence) 경로뿐이다 — 프롬프트 응답(`useBoardingPromptResponder`)과
 * BoardingTrainList 직접 탭(`useBoardingLockController`)은 이미 lock 생성 시점에
 * `setInfoModeEnabled(true)`를 직접 stamp하므로 이 훅이 없어도 정상 동작한다.
 *
 * 승격 규칙: `boardingLock`이 실 lock(`isRealBoardingLock`)이고 `promptOptIn===true`이며
 * `infoModeEnabled===false`이면 `setInfoModeEnabled(true)`를 호출한다. PENDING sentinel
 * lock(`isRealBoardingLock`이 false로 판정 — 탑승했으나 열차 미확정)은 트리거하지 않는다 —
 * `isRealBoardingLock`의 계약(`shared/constants/boardingLock.ts`)이 "backend 관점에서 PENDING은
 * lockless와 동일"이라고 명시하므로, backend register가 실제로 인지 가능한 시점(실 trainCode
 * 확정)에만 승격한다. 승격 이후 `infoModeEnabled`는 trip-durable이라 환승/lock release 후
 * leg-2에서도 매역 발사 권위를 유지한다(lock 재생성이 아니라 계승).
 *
 * `promptOptIn===false`(안내 시작을 하지 않음)이거나 lock이 없는 상태(집에서 안내시작만 —
 * #2651 오발사 방지)에서는 승격하지 않는다. `infoModeEnabled===true`가 되면 조건식 자체가
 * 막아 재호출 없음(멱등) — trip 종료 `runTripBoundCleanups`가 기존대로 false로 reset한다.
 */
export function useBoardingIntentPromotion(): void {
  const lock = useBoardingLockStore((s) => s.lock);
  const promptOptIn = useUserIntentStore((s) => s.promptOptIn);
  const infoModeEnabled = useUserIntentStore((s) => s.infoModeEnabled);
  const setInfoModeEnabled = useUserIntentStore((s) => s.setInfoModeEnabled);

  useEffect(() => {
    if (isRealBoardingLock(lock) && promptOptIn && !infoModeEnabled) {
      setInfoModeEnabled(true);
    }
  }, [lock, promptOptIn, infoModeEnabled, setInfoModeEnabled]);
}
