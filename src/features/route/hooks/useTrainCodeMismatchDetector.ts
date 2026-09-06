import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LinePositions } from '../../../shared/types/position';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';

/**
 * ref + state 이중관리 helper — stale closure 없이 ref는 effect 분기에, state는 외부 노출에 쓴다.
 */
function setDetectedSynced(
  detectedRef: MutableRefObject<boolean>,
  setDetectedState: (v: boolean) => void,
  next: boolean,
): void {
  if (detectedRef.current === next) return;
  detectedRef.current = next;
  setDetectedState(next);
}

/**
 * lock 생성 직후 race를 막는 그레이스 기간(ms).
 * useMisBoardingDetector.MIS_BOARDING_GRACE_MS와 동일 값으로 통일.
 */
export const TRAIN_CODE_MISMATCH_GRACE_MS = 60_000;

/**
 * mismatch 관측이 N회 연속이면 trainCode 오선택으로 확정.
 * positionApi 폴링 30s × 3 = 90s — useMisBoardingDetector threshold와 동일.
 */
export const TRAIN_CODE_MISMATCH_THRESHOLD = 3;

export interface UseTrainCodeMismatchDetectorInputs {
  lock: BoardingLock | null;
  /**
   * lock.boardingLine의 위치 데이터.
   * lock이 없거나 호출자가 polling 안 하면 null.
   */
  positions: LinePositions | null;
  /** 테스트용 시각 주입. 미전달 시 Date.now(). */
  now?: () => number;
}

export interface UseTrainCodeMismatchDetectorResult {
  /**
   * mismatch threshold 도달 시 true.
   * lock 해제/교체 시 false로 reset.
   */
  detected: boolean;
}

/**
 * lock.trainCode와 **다른** trainCode가 같은 노선에서 90s 지속 관찰되면 감지 (#1659).
 *
 * Fail 1 (trainCode 오선택) + Fail 3 (하차 후 lock 잔존) 대응:
 *   - 사용자가 BoardingTrainList에서 잘못된 열차를 탭한 경우
 *   - 환승역에서 내렸으나 lock.trainCode가 계속 살아 있는 경우
 *
 * useMisBoardingDetector(absent 감지)와의 차이:
 *   - absent: lock.trainCode가 positions에서 아예 사라진 경우 (Seoul API stale, 지하 dead zone 포함)
 *   - mismatch: lock.trainCode는 없고 **다른 trainCode가 존재** → 사용자가 실제로 다른 열차에 있음
 *
 * 동작:
 *   - lock 없음 / positions 없음 / isMock / 다른 노선 → 'no-signal', 카운터 미증가.
 *   - lock.trainCode 존재 → 'present', 카운터 reset + detected=false.
 *   - lock.trainCode 없고 다른 train 존재 → 'mismatch', grace 후 카운터 증가.
 *   - lock.trainCode 없고 positions.trains 빈 배열 → 'no-signal' (API 응답 없음, stale로 간주).
 *   - lock.trainCode 또는 boardedAt 변화(새 lock) → 카운터 + detected reset.
 *
 * detected 상태는 ref + state 이중관리 — stale closure를 피하면서 외부에 state를 노출한다.
 */
export function useTrainCodeMismatchDetector({
  lock,
  positions,
  now = Date.now,
}: UseTrainCodeMismatchDetectorInputs): UseTrainCodeMismatchDetectorResult {
  const [detected, setDetectedState] = useState(false);
  const detectedRef = useRef(false);
  const consecutiveMismatchRef = useRef(0);
  const trackedLockKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const updateDetected = (next: boolean): void =>
      setDetectedSynced(detectedRef, setDetectedState, next);

    // 새 lock(= trainCode + boardedAt 조합 변화) → 카운터/감지 reset.
    const lockKey = lock ? `${lock.trainCode}:${lock.boardedAt}` : null;
    if (trackedLockKeyRef.current !== lockKey) {
      trackedLockKeyRef.current = lockKey;
      consecutiveMismatchRef.current = 0;
      updateDetected(false);
    }

    if (!lock || !positions) return;
    if (positions.isMock) return;
    if (positions.line !== lock.boardingLine) return;
    // #2407 — lock.trainCode가 pending sentinel(train 미확정)이면 mismatch 판정을 보류한다.
    // pending은 실 trainCode가 아니므로 어떤 열차와도 매칭되지 않아 항상 'mismatch 후보'로
    // 잘못 카운트되고, 90s 후 정당한 pending lock을 오탐 release할 위험이 있다(오탐 금지 원칙).
    if (isPendingTrainCode(lock.trainCode)) return;

    // lock.trainCode가 현재 positions에 present → 정상 탑승, 카운터 reset.
    const isPresent = positions.trains.some((t) => t.trainNo === lock.trainCode);
    if (isPresent) {
      consecutiveMismatchRef.current = 0;
      updateDetected(false);
      return;
    }

    // trains 배열이 비어 있으면 API 응답 자체가 없거나 stale — Seoul API dead zone 오진 방지.
    // no-signal로 처리해 카운터 미증가.
    if (positions.trains.length === 0) return;

    // lock.trainCode는 없고, 다른 trainCode가 존재 → mismatch 후보.
    // grace 기간 내에는 cache 지연 false-positive 방지를 위해 카운터 미증가.
    if (now() - lock.boardedAt < TRAIN_CODE_MISMATCH_GRACE_MS) return;

    consecutiveMismatchRef.current += 1;
    if (consecutiveMismatchRef.current >= TRAIN_CODE_MISMATCH_THRESHOLD) {
      updateDetected(true);
    }
  }, [lock, positions, now]);

  return { detected };
}
