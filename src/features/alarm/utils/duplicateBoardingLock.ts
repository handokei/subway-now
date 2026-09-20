import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { isBoardingLockExpired } from '../../../shared/types/boardingLock';
import { isValidLineNumber } from '../../../shared/constants/lineApiNames';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';

/**
 * #2722 — LA 버튼(`useLiveActivityIntentBridge`)이 이미 쓰던 "같은 탑승역·노선에 이미 active
 * lock이 있으면 방금 들어온 신호는 같은 탑승 사실을 다른 채널로 중복 통보한 것" 판정을 공용
 * predicate로 승격한다.
 *
 * 새 lock 생성 레이어가 아니다 — `useLiveActivityIntentBridge`의 `isDuplicateBoardingIntent`가
 * 쓰던 로직을 그대로 옮긴 것뿐이며, 그 파일은 이 함수를 얇게 감싸 위임한다(동작 100% 동일).
 * 이제 수동 탭 진입점(`useTransferTrainList.createTransferLock`,
 * `useBoardingLockController.createLockFromTrain`)도 이 predicate로 같은 dedup을 적용해,
 * LA·알림 응답이 먼저 lock을 만든 직후 사용자가 같은 역/노선을 탭해도 lock을 2번 만들지
 * 않는다(#2722 동시성 요구 — 두 진입점 동시 발동 → lock 1개).
 *
 * trainCode는 비교하지 않는다 — "같은 물리적 탑승 이벤트"를 station+line으로만 식별해도
 * 충분하고(LA/알림 채널은 애초에 정확한 trainCode를 못 구해 PENDING sentinel로 lock을 만드는
 * 경우가 있다, `createPendingFallbackLock`), 수동 탭 UI는 lock이 활성화되는 즉시 화면에서
 * 사라지므로(`HomeScreen`의 `!boardingLock` 가드) 사용자가 "다른 열차로 정정"하려고 같은
 * 역/노선에서 재-tap할 실사용 경로 자체가 없다 — dedup이 정당한 재선택을 막지 않는다.
 */
export function isDuplicateBoardingLock(boardingLine: string, originStationName: string): boolean {
  const lock = useBoardingLockStore.getState().lock;
  if (!lock) return false;
  if (isBoardingLockExpired(lock, Date.now())) return false;
  if (!isValidLineNumber(boardingLine) || lock.boardingLine !== boardingLine) return false;
  const station = findStationByNameAndLine(originStationName, boardingLine);
  return station !== null && station.id === lock.boardingStationId;
}
