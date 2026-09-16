/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 본 hook은 alarm 슬라이스의 detect 알고리즘에 arrival/nearest-station
 * 슬라이스의 실시간 입력(arvlCd, userLocation, motionStationary)을 결합해 destination 자동 해제
 * 액션(useDestinationStore)을 호출한다. orchestration이 본질이라 file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #925 C2 — destination 자동 하차 wire-up.
 *
 * PR #939에서 추가된 pure 알고리즘 `detectDestinationArrival`에 production 입력 신호를 묶어
 * destination 자동 해제(`setDestination(null)`)를 호출하는 hook.
 *
 * 입력 (HomeScreen에서 그대로 전달):
 *   - `destination`: useDestinationStore.destination
 *   - `userLocation`: useFusedNearestStation.userLocation
 *   - `motionStationary`: useMotionActivity() — CMMotionActivity stationary 신호
 *   - `onAutoClear`: setDestination(null) wrapper (HomeScreen이 메모이즈)
 *
 * 내부:
 *   - `useArrivalInfo(destination.name, destination.line)`로 destination 역 폴링 (useStationAlarm과
 *     동일 호출 — 모듈 스코프 TtlCache가 dedup하므로 추가 비용 없음).
 *   - up/down rows 중 가장 강한 arvlCd("ARRIVED" > "ENTERING")를 선택해 detect 입력으로 전달.
 *   - motionStationary 전환 시점을 ref로 기록 → `stationaryDurationMs = now - stationaryStartedAt`.
 *     motionStationary=false면 ref 리셋(다음 stationary 진입에서 새로 카운트).
 *
 * 트리거 idempotency:
 *   - destinationId별 firedRef로 trip 1회 자동 해제 보장. destinationId 변경 시 ref 리셋 →
 *     사용자가 다시 동일 destination을 설정하면 새 trip으로 간주.
 *   - onAutoClear는 fire-and-forget — setDestination(null)이 storage cleanup까지 처리한다.
 *
 * useBoardingLockAutoRelease와의 책임 분리:
 *   - useBoardingLockAutoRelease — lock 라이프사이클 정리(300m/45s, fusion distance 기반).
 *   - 본 hook — destination 자체를 해제하는 UX 레벨 액션(50m/60s, GPS+motion 기반).
 *   - 두 hook은 독립 (서로의 ref/storage 공유 없음). 자동 release가 lock만 풀고 destination이
 *     남는 케이스(사용자가 명시 "하차" 안 누름 → lock release는 됐어도 LA가 destination에 묶여 있음)를
 *     이 hook이 cover.
 */
import { useEffect, useRef } from 'react';
import { useArrivalInfo } from '../../arrival/hooks/useArrivalInfo';
import type { Station } from '../../../shared/types/station';
import {
  detectDestinationArrival,
  detectStationaryTripEnd,
  type DestinationArrivalDetectInput,
  type StationaryTripEndDetectInput,
} from '../utils/destinationArrivalDetect';
import { getArrivalPriority } from '../../../shared/constants/arrivalCodes';
import { createLogger } from '../../../shared/utils/logger';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';

const logger = createLogger('useDestinationAutoClear');

export interface UseDestinationAutoClearInputs {
  /** 현재 trip의 destination. null이면 hook은 no-op. */
  destination: Station | null;
  /** Fusion에서 결정된 사용자 좌표. null이면 거리 게이트 통과 불가 → detect=false. */
  userLocation: { lat: number; lng: number } | null;
  /** CMMotionActivity stationary 신호. 미지원/거절 케이스는 false, warmup은 undefined로 전달. */
  motionStationary: boolean | undefined;
  /**
   * #1647 — boardingLock 활성 여부. API-independent 5min stationary 게이트가 lockless trip을
   * 자동 종료하지 않도록 차단한다 (사용자 명시 의향 trip만 동급 보호 — ADR-014).
   * 기존 arvlCd 게이트는 lock 비활성에서도 동작 — 후방 호환 보장.
   */
  lockActive: boolean;
  /**
   * 자동 해제 시 호출. `setDestination(null)` 등 cleanup은 caller 책임이다.
   * #1058: cleared station을 인자로 받아 caller가 undo toast에 노출하거나 복원할 수 있다.
   * HomeScreen이 useCallback으로 메모이즈해 전달.
   */
  onAutoClear: (cleared: Station) => void;
}

/**
 * up/down rows를 합쳐 destination 역에서의 가장 강한 arvlCd를 반환.
 * ARRIVED(1) > ENTERING(0) > 그 외(우선순위 0) — 우선순위가 0이면 null 반환 (detect가 "이 역 신호 아님"으로 분류).
 *
 * 알고리즘이 ENTERING(0)을 통과시키지만 row가 없거나 모든 row가 DEPARTED/PREV_*면 null이 되어
 * detect가 자동으로 'low' confidence 반환. 호출자는 단순히 함수 결과만 전달하면 됨.
 */
export function pickDestinationArvlCd(arrival: StationArrival | null): number | null {
  if (!arrival) return null;
  const trains: ArrivalInfo[] = [...arrival.up, ...arrival.down];
  let bestCode: number | null = null;
  let bestPriority = 0;
  for (const t of trains) {
    const p = getArrivalPriority(t.arrivalCode);
    if (p > bestPriority) {
      bestPriority = p;
      bestCode = t.arrivalCode;
    }
  }
  return bestCode;
}

export function useDestinationAutoClear({
  destination,
  userLocation,
  motionStationary,
  lockActive,
  onAutoClear,
}: UseDestinationAutoClearInputs): void {
  // destination 폴링 — useStationAlarm의 동일 호출과 TtlCache dedup.
  const { arrival: destinationArrival } = useArrivalInfo(
    destination?.name ?? null,
    destination?.line ?? null,
  );

  // motionStationary 진입 시점 — false면 null. detect 입력 stationaryDurationMs 계산용.
  const stationaryStartedAtRef = useRef<number | null>(null);
  // destinationId별 1회 발사 — 같은 trip에서 중복 호출 차단.
  // destination 변경 시 리셋되어 사용자가 새 trip 시작 시 다시 동작 가능.
  const firedForDestIdRef = useRef<string | null>(null);

  useEffect(() => {
    // destination 변경 시 fired ref 리셋. 동일 destination 재설정 trip은 새 1회.
    const destId = destination?.id ?? null;
    if (firedForDestIdRef.current !== null && firedForDestIdRef.current !== destId) {
      firedForDestIdRef.current = null;
    }

    if (!destination) {
      // destination 없으면 stationary ref도 의미 없음 — clean up.
      stationaryStartedAtRef.current = null;
      return;
    }

    const now = Date.now();
    if (motionStationary) {
      if (stationaryStartedAtRef.current === null) {
        stationaryStartedAtRef.current = now;
      }
    } else {
      stationaryStartedAtRef.current = null;
    }

    // 이미 발사한 trip이면 추가 평가 불필요 — onAutoClear 후속 setDestination(null)가
    // 다음 cycle에서 deps를 클리어하지만, 같은 cycle 내 race 가드.
    if (firedForDestIdRef.current === destId) return;

    const stationaryDurationMs =
      stationaryStartedAtRef.current === null ? null : now - stationaryStartedAtRef.current;

    const input: DestinationArrivalDetectInput = {
      destinationStation: destination,
      arvlCdAtDestination: pickDestinationArvlCd(destinationArrival),
      userLocation,
      stationaryDurationMs,
    };
    const result = detectDestinationArrival(input);
    if (result.shouldAutoClear) {
      firedForDestIdRef.current = destId;
      logger.info(
        `destination=${destination.name} 자동 해제 (confidence=${result.confidence}, gate=arrival)`,
      );
      onAutoClear(destination);
      return;
    }
    // #1647 — Seoul API-independent fallback gate. arvlCd 게이트가 outage/dead zone로 fire 0건일 때
    // 100m + 5min stationary + lock 활성 3-of-3로 자동 종료. lockless trip은 차단(정보용 trip 보호).
    const stationaryInput: StationaryTripEndDetectInput = {
      destinationStation: destination,
      userLocation,
      stationaryDurationMs,
      lockActive,
    };
    const stationaryResult = detectStationaryTripEnd(stationaryInput);
    if (stationaryResult.shouldAutoClear) {
      firedForDestIdRef.current = destId;
      logger.info(
        `destination=${destination.name} 자동 해제 (confidence=${stationaryResult.confidence}, gate=stationary)`,
      );
      onAutoClear(destination);
    }
  }, [
    destination,
    destinationArrival,
    userLocation,
    motionStationary,
    lockActive,
    onAutoClear,
  ]);
}
