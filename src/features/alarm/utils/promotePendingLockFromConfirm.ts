import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';
import type { BoardingResolveTier } from '../../../shared/types/boardingLock';

type BoardingLockState = ReturnType<typeof useBoardingLockStore.getState>;

/** boarding-confirm('boarded') 응답에서 꺼낸 backend 해소 결과 (`PositionUploadResult`의 부분집합). */
export interface BoardingConfirmResolution {
  resolvedTrainCode?: string;
  resolveTier?: BoardingResolveTier;
}

/**
 * #3055 C — boarding-confirm 응답의 해소 열차로 **PENDING lock을 실 열차로 교체**한다.
 *
 * 배경: backend는 #3059로 탭 시 열차를 해소해 lock을 만들지만, device PENDING lock
 * (`createPendingFallbackLock`)은 응답을 못 받아 `useStationAlarm` 로컬 억제가 지속됐다.
 * 이 응답은 device 자신의 탑승 표명에 대한 **권위적 회신**(표명 유래)이라 관찰 유래 polling
 * 채널(`lockSuggestion`)과 구분되는 제2 승격 채널이다(invariants 경계 기록).
 *
 * 교체 조건 — **현재 store lock이 PENDING일 때만**:
 *  - 실 lock이 이미 있으면(reconfirmed 경로) 건드리지 않는다.
 *  - lock이 없으면(skip·dismiss 경로) 신규 생성하지 않는다 — 로컬 skip 사유(position 모순 등)를
 *    응답으로 뒤집지 않는다.
 *  - 응답에 trainCode가 없거나(lock 미성립) 비실체(빈 문자열/sentinel)면 PENDING 유지.
 *
 * 보존: `boardedAt`(원 표명 시각)·`boardingEvidence`·역/노선/목적지는 PENDING 생성분 그대로,
 * `trainCode`(+`resolveTier`)만 교체한다. immutability 가드는 `prev.trainCode !== lock.trainCode`라
 * 통과하고, `createLock`의 `recordPendingLockPromotion`이 이 승격을 기존 telemetry로 잡는다.
 *
 * `createLock`은 caller(responder)의 deps를 그대로 받는다 — 테스트/주입 경로 일관성.
 *
 * @returns 교체했으면 true.
 */
export async function promotePendingLockFromConfirm(
  resolution: BoardingConfirmResolution | undefined,
  createLock: BoardingLockState['createLock'],
): Promise<boolean> {
  const { resolvedTrainCode, resolveTier } = resolution ?? {};
  if (resolvedTrainCode === undefined || resolvedTrainCode.length === 0) return false;
  if (isPendingTrainCode(resolvedTrainCode)) return false;

  const { lock } = useBoardingLockStore.getState();
  if (lock === null || !isPendingTrainCode(lock.trainCode)) return false;

  const { boardingEvidence, ...lockInput } = lock;
  await createLock(
    { ...lockInput, trainCode: resolvedTrainCode, ...(resolveTier !== undefined ? { resolveTier } : {}) },
    boardingEvidence ?? false,
    'boarding-prompt-response',
  );
  return true;
}
