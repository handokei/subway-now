/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 hook은 destination/route(route feature) + boardingLock/
 * stationPrescheduler(alarm feature) + settings(sleepMode)를 묶는 단일 owner orchestrator다.
 * useSafetyNetScheduler와 동일한 옵트인 패턴(file-level disable).
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Station } from '../../../shared/types/station';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import {
  cancelAllPrescheduledAlarms,
  registerPrescheduledStationAlarms,
} from '../utils/stationPrescheduler';
import { deviceLocalTripId } from '../utils/safetyNetScheduler';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { useSettingsStore } from '../../settings/store/useSettingsStore';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useStationPrescheduler');

export interface UseStationPrescheduerInputs {
  /** boarding → destination 순서의 ordered station 시퀀스. */
  arcStations: readonly Station[];
  /** arcStations 내 현재 위치 인덱스 — 실시간 lock trainCode 판정 결과(#918 evolve 2항). */
  currentHopIndex: number | null;
  /** 활성 BoardingLock. null(lockless)이면 사전예약 자체를 등록하지 않는다(#918 evolve 1항). */
  lock: BoardingLock | null;
}

/**
 * #918 — "OS-level 사전 예약 매역 일반화" 단일 owner. `stationPrescheduler`를 호출해
 * boardingLock 활성 + sleepMode OFF인 trip에 한해 경로 위 모든 역에 앞 12역 rolling window로
 * 예약/재충전한다.
 *
 * 정책 (`useSafetyNetScheduler`와 대칭 — 두 채널은 sleepMode로 상호 배타):
 * - sleepMode ON이면 항상 cancel-only(등록 없음) — 취침모드는 safetyNetScheduler 전담(#918
 *   evolve 7항). sleepMode 토글 즉시 반영되도록 effect dependency에 포함한다.
 * - lock이 null(lockless trip)이면 cancel-only — 명시 의향 없는 trip은 발사 채널 침묵
 *   paradigm 유지(#918 evolve 1항, 자동 lock 의존 삭제).
 * - `currentHopIndex`가 바뀔 때마다(=열차가 다음 역으로 진행할 때마다) 이전 예약을 전량
 *   cancel한 뒤 그 시점의 실시간 위치를 새 앵커로 앞 12역을 다시 예약한다 — 이것이 "rolling
 *   window 재충전"이다(#918 evolve 6항). silent push 수신으로 currentHopIndex가 갱신되는
 *   모든 경로(BG wake 후 FG 복귀, arrival API 재조회 등)가 자동으로 재충전을 트리거한다.
 * - 언마운트 시에는 cancel하지 않는다 — trip 종료는 `tripBoundCleanups`(cancelTripBoundOsQueue)가
 *   전담한다(safetyNetScheduler와 동일 소유 경계).
 */
export function useStationPrescheduler({
  arcStations,
  currentHopIndex,
  lock,
}: UseStationPrescheduerInputs): void {
  const sleepMode = useSettingsStore((s) => s.sleepMode);
  const registeredIdentityRef = useRef<string | null>(null);
  const registeredTripTokenRef = useRef<string | null>(null);
  const inFlightTokenRef = useRef(0);

  useEffect(() => {
    const myToken = ++inFlightTokenRef.current;

    const run = async (): Promise<void> => {
      const gatedOff =
        sleepMode ||
        lock === null ||
        currentHopIndex === null ||
        arcStations.length < 2 ||
        currentHopIndex >= arcStations.length - 1;

      if (gatedOff) {
        if (registeredIdentityRef.current !== null && registeredTripTokenRef.current) {
          await cancelAllPrescheduledAlarms(registeredTripTokenRef.current);
        }
        if (myToken !== inFlightTokenRef.current) return;
        registeredIdentityRef.current = null;
        registeredTripTokenRef.current = null;
        return;
      }

      const [backendTripToken, tripStart] = await Promise.all([
        AsyncStorage.getItem(ACTIVE_TRIP_KEY),
        getTripStartedAt(),
      ]);
      if (myToken !== inFlightTokenRef.current) return;

      if (tripStart === null) {
        // trip 시작 시각 자체가 없음 — 이번 cycle skip. 직전 등록은 그대로 유지.
        return;
      }
      const tripToken = backendTripToken ?? deviceLocalTripId(tripStart);

      const nextIdentity = `${tripToken}|idx:${currentHopIndex}|arcLen:${arcStations.length}`;
      if (registeredIdentityRef.current === nextIdentity) return;

      if (registeredIdentityRef.current !== null && registeredTripTokenRef.current) {
        await cancelAllPrescheduledAlarms(registeredTripTokenRef.current);
      }
      if (myToken !== inFlightTokenRef.current) return;

      const result = await registerPrescheduledStationAlarms({
        tripToken,
        arcStations,
        currentIdx: currentHopIndex,
      });
      if (myToken !== inFlightTokenRef.current) return;
      registeredIdentityRef.current = nextIdentity;
      registeredTripTokenRef.current = tripToken;
      logger.info(
        `registered ${result.scheduled} prescheduled station alarms tripToken=${tripToken.slice(0, 8)}`,
      );
    };

    run().catch((e: unknown) => {
      logger.error('stationPrescheduler 전환 실패:', e);
    });
    // arcStations는 useFusedNearestStation의 useMemo 산출물 — 내용이 같으면 참조도 안정적으로
    // 유지된다(safetyNetScheduler의 route 객체와 동일 신뢰 전제).
  }, [arcStations, currentHopIndex, lock, sleepMode]);
}
