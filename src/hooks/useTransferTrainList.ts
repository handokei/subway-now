import { useCallback, useMemo } from 'react';
import { useArrivalInfo } from './useArrivalInfo';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { findActiveTransferContext } from '../utils/findActiveTransferContext';
import { FALLBACK_BOARDING_DURATION_MINUTES } from '../constants/boardingLock';
import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';
import type { BoardingLock } from '../types/boardingLock';
import type { Station } from '../types/station';
import type { Route } from '../utils/stationRoute';
import type { ArrivalProvider } from '../providers/types';
import type { ActiveTransferContext } from '../utils/findActiveTransferContext';

export interface UseTransferTrainListInputs {
  lock: BoardingLock | null;
  route: Route;
  destinationName: string | null;
  currentStation: Station | null;
  /** 환승 후 새 lock의 expectedDurationMs 산출용. null이면 fallback 30분. */
  expectedDurationMinutes: number | null;
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
  expectedDurationMinutes,
  arrivalProvider,
}: UseTransferTrainListInputs): UseTransferTrainListResult {
  const context = useMemo(
    () => findActiveTransferContext(lock, route, destinationName, currentStation),
    [lock, route, destinationName, currentStation],
  );

  const transferStationName = context?.transferStationInToLine.name ?? null;
  const transferLine = context?.nextLine ?? null;
  const { arrival } = useArrivalInfo(transferStationName, transferLine, arrivalProvider);

  const arrivals = useMemo<ArrivalInfo[]>(
    () => filterByDirection(arrival, context?.direction ?? null),
    [arrival, context],
  );

  const createLock = useBoardingLockStore((s) => s.createLock);
  const createTransferLock = useCallback(
    (train: ArrivalInfo) => {
      if (!context || !lock) return;
      // TODO(#584-followup): expectedDurationMinutes는 출발역 기준 전체 trip 시간이라 환승 후 lock
      // 만료 타이머가 과대 추정됨. 잔여 leg(stopsFromTransfer 등) 기준 calculateTransferLegETA 도입 필요.
      // 현재는 보수적(=과만료) 측으로 안전 — BOARDING_LOCK_EXPIRY_FACTOR(=1.5)로도 충분히 길어 알람은
      // 정상 발사된 후 만료된다. 정밀화는 후속 PR.
      const durationMin = expectedDurationMinutes ?? FALLBACK_BOARDING_DURATION_MINUTES;
      void createLock({
        destinationId: lock.destinationId,
        trainCode: train.trainCode,
        boardingStationId: context.transferStationInToLine.id,
        boardingLine: context.nextLine,
        boardedAt: Date.now(),
        expectedDurationMs: durationMin * 60_000,
      });
    },
    [context, lock, expectedDurationMinutes, createLock],
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
  if (direction === 'up') return arrival.up;
  if (direction === 'down') return arrival.down;
  return [...arrival.up, ...arrival.down];
}
