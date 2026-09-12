import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LinePositions } from '../../../shared/types/position';
import type { Route } from '../../../shared/utils/stationRoute';
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
  /** lock.boardingLine의 위치 데이터. lock이 없거나 호출자가 폴링 안 하면 null. */
  positions: LinePositions | null;
  /**
   * 현재 leg의 route. 반대 방향 탑승 감지(#2455, Phase B)용 — 미전달 시 detectMisBoarding이
   * 방향 검사를 skip해 wrongDirectionDetected는 항상 false로 남는다(기존 absent 감지만 동작).
   */
  route?: Route;
  /** trip(또는 현재 leg) 목적지명. route와 함께 있어야 방향 검사가 활성화된다. */
  destinationName?: string | null;
  /** 테스트용 주입. 미전달 시 Date.now(). */
  now?: () => number;
}

export interface UseMisBoardingDetectorResult {
  /** absent threshold 도달 시 true. lock 해제/교체 시 false로 reset. */
  detected: boolean;
  /**
   * wrong-direction observation이 threshold 도달 시 true (#2455, Phase B). detected와 서로
   * 배타적 — 같은 lockKey에서 absent와 wrong-direction 카운터는 독립적으로 관리되고, 다른
   * observation이 들어오면(present 또는 서로 다른 observation) 각자의 카운터만 reset된다.
   */
  wrongDirectionDetected: boolean;
}

/**
 * BoardingLock에 명시된 trainCode가 실시간 위치 API에서 사라졌는지 감지 (#584 PR D3).
 *
 * - lock 생성 직후 grace 동안은 absent/wrong-direction이어도 무시 (positionApi 캐시/주기와 정합).
 * - absent 관측이 threshold 회 연속이면 detected=true 한 번 발생.
 * - wrong-direction 관측이 threshold 회 연속이면 wrongDirectionDetected=true 한 번 발생
 *   (#2455, Phase B — route/destinationName 미전달이면 detectMisBoarding이 항상 'present'/'absent'
 *   만 내므로 이 카운터는 계속 0에 머문다. 기존 absent 경로에 영향 없음).
 * - present가 한 번이라도 들어오면 두 카운터 모두 reset, 두 detected 모두 false.
 * - absent와 wrong-direction은 서로 다른 observation이므로 한쪽이 관측되면 다른 쪽 카운터도
 *   reset된다 — 두 상태가 동시에 true가 될 수 없다.
 * - lock의 trainCode 또는 boardedAt이 바뀌면 (=새 lock) 카운터+detected 전부 reset.
 *
 * detected 상태들은 ref + state 이중관리 — ref는 effect 내 분기에 쓰고, state는 외부 노출용.
 * detected를 effect deps에 두면 setDetected 호출 시 stale closure 경유로 카운터가 의도와 다르게
 * 흐를 수 있어 ref로 분리한다.
 */
export function useMisBoardingDetector({
  lock,
  positions,
  route = null,
  destinationName = null,
  now = Date.now,
}: UseMisBoardingDetectorInputs): UseMisBoardingDetectorResult {
  const [detected, setDetectedState] = useState(false);
  const detectedRef = useRef(false);
  const consecutiveAbsentRef = useRef(0);
  const [wrongDirectionDetected, setWrongDirectionDetectedState] = useState(false);
  const wrongDirectionDetectedRef = useRef(false);
  const consecutiveWrongDirectionRef = useRef(0);
  const trackedLockKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const updateDetected = (next: boolean): void =>
      setDetectedSynced(detectedRef, setDetectedState, next);
    const updateWrongDirectionDetected = (next: boolean): void =>
      setDetectedSynced(wrongDirectionDetectedRef, setWrongDirectionDetectedState, next);
    // 새 lock(=trainCode + boardedAt 조합 변화) → 카운터/감지 reset.
    // 같은 trainCode 재선택 시에도 boardedAt이 갱신되어 grace가 다시 적용된다.
    const lockKey = lock ? `${lock.trainCode}:${lock.boardedAt}` : null;
    if (trackedLockKeyRef.current !== lockKey) {
      trackedLockKeyRef.current = lockKey;
      consecutiveAbsentRef.current = 0;
      consecutiveWrongDirectionRef.current = 0;
      updateDetected(false);
      updateWrongDirectionDetected(false);
    }

    if (!lock || !positions) return;

    const observation = detectMisBoarding(lock, positions, route, destinationName);
    if (observation === 'no-signal') return;

    if (observation === 'present') {
      consecutiveAbsentRef.current = 0;
      consecutiveWrongDirectionRef.current = 0;
      updateDetected(false);
      updateWrongDirectionDetected(false);
      return;
    }

    // absent/wrong-direction 둘 다 grace 통과 후에만 카운터 증가.
    if (now() - lock.boardedAt < MIS_BOARDING_GRACE_MS) return;

    if (observation === 'wrong-direction') {
      consecutiveAbsentRef.current = 0;
      updateDetected(false);
      consecutiveWrongDirectionRef.current += 1;
      if (consecutiveWrongDirectionRef.current >= MIS_BOARDING_MISS_THRESHOLD) {
        updateWrongDirectionDetected(true);
      }
      return;
    }

    // absent.
    consecutiveWrongDirectionRef.current = 0;
    updateWrongDirectionDetected(false);
    consecutiveAbsentRef.current += 1;
    if (consecutiveAbsentRef.current >= MIS_BOARDING_MISS_THRESHOLD) {
      updateDetected(true);
    }
  }, [lock, positions, route, destinationName, now]);

  return { detected, wrongDirectionDetected };
}
