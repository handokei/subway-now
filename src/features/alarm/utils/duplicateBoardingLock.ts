import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { isBoardingLockExpired } from '../../../shared/types/boardingLock';
import { isValidLineNumber } from '../../../shared/constants/lineApiNames';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';

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
 * #2786 (9/21 PM 실측, 뚝섬) — 위 "재-tap할 실사용 경로 자체가 없다"는 전제는 반박됐다. LA/알림
 * 응답이 먼저 만드는 lock이 항상 실 trainCode를 갖는 건 아니다 — `createPendingFallbackLock`이
 * trainCode를 `PENDING_TRAIN_CODE` sentinel로 채워 미확정 lock을 만드는 경우, 그 lock은
 * `HomeScreen`의 `!boardingLock` 가드로 화면에서 사라지지 않는다(`isRealBoardingLock`이 false를
 * 반환하는 동안 BoardingTrainList가 계속 노출됨, #2407 Gap B) — 사용자가 그 화면에서 실제 열차를
 * 탭하는 경로가 실사용에서 관측됐다(19:04 PENDING 생성 직후 19:04 탭). 이 탭을 station+line만
 * 보고 예전처럼 dedup(무시)하면 사용자가 명시적으로 고른 실 trainCode가 미확정 sentinel에 영영
 * 덮인 채로 남는다.
 *
 * 따라서 trainCode 인자(옵션)를 받아: 기존 lock이 PENDING sentinel이고 전달된 trainCode가 실
 * trainCode(non-sentinel)이면 dedup이 아니라 교체(승격) 대상으로 판정해 false를 반환한다 — 호출자
 * (`createLockFromTrain`/`createTransferLock`)가 이 탭으로 `createLock`을 그대로 진행해 pending
 * lock을 실 trainCode로 교체한다. trainCode를 모르는 채널(LA 버튼 — `originStation`/`line`만 갖고
 * 특정 열차를 지목하지 않음)은 인자를 생략해 기존 station+line dedup을 그대로 유지한다. 동일 실
 * trainCode 재탭, 또는 실 lock에 다른 실 trainCode를 탭하는 케이스는 이 변경과 무관하게 기존
 * station+line dedup을 그대로 유지한다 — trainCode 비교는 "PENDING → 실 승격" 판정 전용이다.
 */
export function isDuplicateBoardingLock(
  boardingLine: string,
  originStationName: string,
  trainCode?: string,
): boolean {
  const lock = useBoardingLockStore.getState().lock;
  if (!lock) return false;
  if (isBoardingLockExpired(lock, Date.now())) return false;
  if (!isValidLineNumber(boardingLine) || lock.boardingLine !== boardingLine) return false;
  const station = findStationByNameAndLine(originStationName, boardingLine);
  if (station === null || station.id !== lock.boardingStationId) return false;
  if (trainCode !== undefined && isPendingTrainCode(lock.trainCode) && !isPendingTrainCode(trainCode)) {
    return false;
  }
  return true;
}
