import { useCallback, useEffect, useMemo, useRef } from 'react';
import { prefetchArrival, useArrivalInfo } from '../../arrival/hooks/useArrivalInfo';
import { useBoardingLockStore } from '../../alarm/store/useBoardingLockStore';
import {
  findActiveTransferContext,
  findUpcomingTransferPrefetch,
} from '../utils/findActiveTransferContext';
import { FALLBACK_BOARDING_DURATION_MINUTES } from '../../../shared/constants/boardingLock';
import { calculateRemainingLegETA } from '../utils/stationRoute';
import type { ArrivalInfo, StationArrival } from '../../arrival/api/arrivalApi';
import type { BoardingLock } from '../../alarm/types/boardingLock';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../utils/stationRoute';
import type { ArrivalProvider } from '../../arrival/providers/types';
import type { ActiveTransferContext } from '../utils/findActiveTransferContext';

export interface UseTransferTrainListInputs {
  lock: BoardingLock | null;
  route: Route;
  destinationName: string | null;
  currentStation: Station | null;
  arrivalProvider?: ArrivalProvider;
}

export interface UseTransferTrainListResult {
  /** 환승 컨텍스트(=새 노선 list를 노출해야 하는 상태). 없으면 list 미노출. */
  context: ActiveTransferContext | null;
  /** 다음 노선 + 환승역 기준 도착 list, direction으로 필터된 결과. */
  arrivals: ArrivalInfo[];
  /** 사용자가 다음 열차 탭 시 호출 — 새 BoardingLock 생성 (기존 lock 자동 교체). */
  createTransferLock: (train: ArrivalInfo) => void;
}

/**
 * 환승 waypoint 도달 시 다음 노선의 도착 list + 새 lock 생성 진입점을 제공 (#584 PR E).
 *
 * - context는 findActiveTransferContext 결과 — 비활성 시 list 렌더 생략.
 * - useArrivalInfo는 Rules of Hooks 준수를 위해 context 유무와 무관하게 호출. 매개변수가 null이면
 *   useArrivalInfo 자체가 idle로 동작 — 추가 비용 없음.
 * - direction이 'up'/'down'이면 해당 방향만, null이면 양방향 합산.
 */
export function useTransferTrainList({
  lock,
  route,
  destinationName,
  currentStation,
  arrivalProvider,
}: UseTransferTrainListInputs): UseTransferTrainListResult {
  const context = useMemo(
    () => findActiveTransferContext(lock, route, destinationName, currentStation),
    [lock, route, destinationName, currentStation],
  );

  const transferStationName = context?.transferStationInToLine.name ?? null;
  const transferLine = context?.nextLine ?? null;
  const { arrival, refetch } = useArrivalInfo(transferStationName, transferLine, arrivalProvider);

  // #814 — 환승 알람 imminent 시점부터 다음 노선 arrival을 사전 폴링한다.
  // findUpcomingTransferPrefetch는 lock 활성 + transfer 라우트 + 다음 환승까지 잔여 stops ≤ 1
  // (또는 이미 환승역 위)일 때만 target을 반환한다. 비환승 trip(direct route)이면 항상 null —
  // prefetch가 자연스럽게 skip되어 불필요 폴링이 발생하지 않는다.
  // prefetchArrival 자체가 cache TTL(30s) 내 valid 엔트리가 있으면 no-op이라 같은 trigger가
  // 여러 번 호출돼도 중복 네트워크 호출이 없다.
  const upcomingTransfer = useMemo(
    () => findUpcomingTransferPrefetch(lock, route, destinationName, currentStation),
    [lock, route, destinationName, currentStation],
  );
  const upcomingStation = upcomingTransfer?.transferStationName ?? null;
  const upcomingLine = upcomingTransfer?.nextLine ?? null;
  useEffect(() => {
    if (!upcomingStation || !upcomingLine) return;
    void prefetchArrival(upcomingStation, upcomingLine);
  }, [upcomingStation, upcomingLine]);

  // #814 — context가 막 활성화된 순간(release: 사용자가 환승역에 도달해 다음 leg로 전환)
  // useArrivalInfo의 자연 polling 주기를 기다리지 않고 즉시 한 번 강제 fetch. cache가 비어
  // 있으면 첫 응답을 앞당기고, cache가 있어도 latest로 갱신해 stale 데이터 노출 시간을 줄인다.
  const prevContextActiveRef = useRef(false);
  useEffect(() => {
    const active = context !== null;
    if (active && !prevContextActiveRef.current) {
      refetch();
    }
    prevContextActiveRef.current = active;
  }, [context, refetch]);

  const arrivals = useMemo<ArrivalInfo[]>(
    () => filterByDirection(arrival, context?.direction ?? null),
    [arrival, context],
  );

  const createLock = useBoardingLockStore((s) => s.createLock);
  const createTransferLock = useCallback(
    (train: ArrivalInfo) => {
      if (!context || !lock) return;
      // #604: 잔여 leg 기준 ETA로 lock의 expectedDurationMs를 정밀화. 전체 trip 시간으로 잡으면
      // BOARDING_LOCK_EXPIRY_FACTOR(=1.5)와 곱해져 만료 타이머가 도착 후에도 한참 활성 상태로 남는다.
      // calculateRemainingLegETA가 null이면(=route가 직접/idx 불일치 등 예기치 못한 상태) fallback.
      const remainingMin = calculateRemainingLegETA(route, context.completedTransferIdx);
      /* istanbul ignore next -- context가 있으면 route는 transfer/multi-transfer이고
         completedTransferIdx는 resolveAllTargets로 산출된 유효 인덱스라 calculateRemainingLegETA는
         항상 숫자를 반환한다. FALLBACK은 정합성 깨진 상태에 대한 방어 코드. */
      const durationMin = remainingMin ?? FALLBACK_BOARDING_DURATION_MINUTES;
      void createLock({
        destinationId: lock.destinationId,
        trainCode: train.trainCode,
        boardingStationId: context.transferStationInToLine.id,
        boardingLine: context.nextLine,
        boardedAt: Date.now(),
        expectedDurationMs: durationMin * 60_000,
      });
    },
    [context, lock, route, createLock],
  );

  return { context, arrivals, createTransferLock };
}

/** 테스트 노출용. 외부 호출자는 useTransferTrainList의 result.arrivals를 사용. */
export function filterArrivalsByDirection(
  arrival: StationArrival | null,
  direction: 'up' | 'down' | null,
): ArrivalInfo[] {
  return filterByDirection(arrival, direction);
}

function filterByDirection(
  arrival: StationArrival | null,
  direction: 'up' | 'down' | null,
): ArrivalInfo[] {
  if (!arrival) return [];
  // #666 이미 지나간 열차(arrivalSeconds <= 0) 제외 — 환승 list에서도 동일 정책.
  const reachable = (t: ArrivalInfo): boolean => t.arrivalSeconds > 0;
  if (direction === 'up') return arrival.up.filter(reachable);
  if (direction === 'down') return arrival.down.filter(reachable);
  return [...arrival.up, ...arrival.down].filter(reachable);
}
