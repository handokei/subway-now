import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import type { BoardingLock } from '../features/alarm/types/boardingLock';
import type { LinePositions } from '../api/positionApi';
import { detectMisBoarding } from '../utils/detectMisBoarding';

/**
 * ref + state 이중관리의 동기 helper. 모듈 스코프에 두어 effect 클로저에서 stale 참조가
 * 생기지 않게 한다. ref는 effect 내 분기에, state는 외부 노출에 쓰인다.
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

/** lock 생성 직후 캐시 지연으로 발생하는 false-positive를 막는 그레이스 기간(ms). */
export const MIS_BOARDING_GRACE_MS = 60_000;
/** absent 관측이 N회 연속이면 잘못 탑승으로 확정. positionApi 폴링 30s × 3 = 90s. */
export const MIS_BOARDING_MISS_THRESHOLD = 3;

export interface UseMisBoardingDetectorInputs {
  lock: BoardingLock | null;
  /** lock.boardingLine의 위치 데이터. lock이 없거나 호출자가 polling 안 하면 null. */
  positions: LinePositions | null;
  /** 테스트용 주입. 미전달 시 Date.now(). */
  now?: () => number;
}

export interface UseMisBoardingDetectorResult {
  /** absent threshold 도달 시 true. lock 해제/교체 시 false로 reset. */
  detected: boolean;
}

/**
 * BoardingLock에 명시된 trainCode가 실시간 위치 API에서 사라졌는지 감지 (#584 PR D3).
 *
 * - lock 생성 직후 grace 동안은 absent여도 무시 (positionApi 캐시/주기와 정합).
 * - absent 관측이 threshold 회 연속이면 detected=true 한 번 발생.
 * - present가 한 번이라도 들어오면 카운터 reset, detected=false.
 * - lock의 trainCode 또는 boardedAt이 바뀌면 (=새 lock) 카운터+detected reset.
 *
 * detected 상태는 ref + state 이중관리 — ref는 effect 내 분기에 쓰고, state는 외부 노출용.
 * detected를 effect deps에 두면 setDetected 호출 시 stale closure 경유로 카운터가 의도와 다르게
 * 흐를 수 있어 ref로 분리한다.
 */
export function useMisBoardingDetector({
  lock,
  positions,
  now = Date.now,
}: UseMisBoardingDetectorInputs): UseMisBoardingDetectorResult {
  const [detected, setDetectedState] = useState(false);
  const detectedRef = useRef(false);
  const consecutiveAbsentRef = useRef(0);
  const trackedLockKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const updateDetected = (next: boolean): void =>
      setDetectedSynced(detectedRef, setDetectedState, next);
    // 새 lock(=trainCode + boardedAt 조합 변화) → 카운터/감지 reset.
    // 같은 trainCode 재선택 시에도 boardedAt이 갱신되어 grace가 다시 적용된다.
    const lockKey = lock ? `${lock.trainCode}:${lock.boardedAt}` : null;
    if (trackedLockKeyRef.current !== lockKey) {
      trackedLockKeyRef.current = lockKey;
      consecutiveAbsentRef.current = 0;
      updateDetected(false);
    }

    if (!lock || !positions) return;

    const observation = detectMisBoarding(lock, positions);
    if (observation === 'no-signal') return;

    if (observation === 'present') {
      consecutiveAbsentRef.current = 0;
      updateDetected(false);
      return;
    }

    // absent. grace 통과 후에만 카운터 증가.
    if (now() - lock.boardedAt < MIS_BOARDING_GRACE_MS) return;

    consecutiveAbsentRef.current += 1;
    if (consecutiveAbsentRef.current >= MIS_BOARDING_MISS_THRESHOLD) {
      updateDetected(true);
    }
  }, [lock, positions, now]);

  return { detected };
}
