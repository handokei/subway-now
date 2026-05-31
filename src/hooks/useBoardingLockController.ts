import { useCallback, useEffect, useMemo } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { resolveTripDirection } from '../utils/tripDirection';
import { findStationByNameAndLine } from '../utils/stationLookup';
import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';
import type { Route } from '../utils/stationRoute';
import type { Station } from '../types/station';
import type { BoardingLock } from '../types/boardingLock';
import { FALLBACK_BOARDING_DURATION_MINUTES } from '../constants/boardingLock';

export interface UseBoardingLockControllerInputs {
  destinationId: string | null;
  destinationName: string | null;
  route: Route;
  arrival: StationArrival | null;
  currentStation: Station | null;
  /**
   * 정적 ETA(분). createLock 시 expectedDurationMs 계산에 사용된다.
   * null이면 fallback 30분 — 잘못된 Lock이라도 자동 만료(× 1.5)가 작동한다.
   */
  expectedDurationMinutes: number | null;
}

export interface UseBoardingLockControllerResult {
  lock: BoardingLock | null;
  /** route 진행 방향으로 필터된 도착 list. 방향 미상이면 up+down 합집합. */
  directionalArrivals: ArrivalInfo[];
  /** 사용자가 도착 list에서 열차 탭 시 호출. lock 생성을 위한 컨텍스트가 부족하면 no-op. */
  createLockFromTrain: (train: ArrivalInfo) => void;
  /** 명시 하차. lock 없는 상태에서 호출돼도 안전. */
  releaseLock: () => void;
}

/**
 * BoardingLock 제어 hook (#584 PR B).
 *
 * 책임:
 *  - 마운트 시 storage에서 lock 복원
 *  - destination 변경 시 stale lock 자동 release (다른 trip의 lock이 남는 것 차단)
 *  - AppState 'active' 진입 시 만료 검사
 *  - route 진행 방향으로 도착 list 필터링 — UI에 전달
 *  - 열차 탭 → BoardingLock 생성 (current station + line + 정적 ETA × 60_000 ms)
 *
 * 이번 PR 범위: UI 진입점 wiring. Fusion/scheduler 통합은 PR C/D.
 */
export function useBoardingLockController({
  destinationId,
  destinationName,
  route,
  arrival,
  currentStation,
  expectedDurationMinutes,
}: UseBoardingLockControllerInputs): UseBoardingLockControllerResult {
  const lock = useBoardingLockStore((s) => s.lock);
  const loadLock = useBoardingLockStore((s) => s.loadLock);
  const createLock = useBoardingLockStore((s) => s.createLock);
  const releaseLock = useBoardingLockStore((s) => s.releaseLock);
  const checkExpiry = useBoardingLockStore((s) => s.checkExpiry);

  // 마운트 시 storage hydrate.
  useEffect(() => {
    void loadLock();
  }, [loadLock]);

  // destination 변경 → stale lock release. 같은 destination이면 그대로 유지(앱 재시작 등).
  useEffect(() => {
    if (lock && lock.destinationId !== destinationId) {
      void releaseLock();
    }
  }, [lock, destinationId, releaseLock]);

  // AppState active 진입 시 만료 검사 + 마운트 직후 1회.
  useEffect(() => {
    void checkExpiry();
    const handler = (state: AppStateStatus): void => {
      if (state === 'active') void checkExpiry();
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, [checkExpiry]);

  const direction = useMemo(() => {
    if (!route || !destinationName || !currentStation) return null;
    return resolveTripDirection(route, destinationName, currentStation.id);
  }, [route, destinationName, currentStation]);

  const directionalArrivals = useMemo<ArrivalInfo[]>(() => {
    if (!arrival) return [];
    // #666 이미 지나간 열차(arrivalSeconds <= 0) 제외 — 사용자가 탭하면 lock 오발화.
    const reachable = (t: ArrivalInfo): boolean => t.arrivalSeconds > 0;
    if (direction === 'up') return arrival.up.filter(reachable);
    if (direction === 'down') return arrival.down.filter(reachable);
    return [...arrival.up, ...arrival.down].filter(reachable);
  }, [arrival, direction]);

  const createLockFromTrain = useCallback(
    (train: ArrivalInfo) => {
      if (!destinationId || !currentStation) return;
      const durationMin = expectedDurationMinutes ?? FALLBACK_BOARDING_DURATION_MINUTES;
      // #663: boardingLine은 사용자가 실제로 탭한 train의 line을 사용. currentStation.line은 fusion
      // 추정이라 환승역에서 옆 노선으로 잘못 잠긴 상태일 수 있다 (#662). train.line은 어댑터가 subwayId로
      // 결정해 row마다 정확. fusion이 잘못돼 있어도 lock만은 정답을 유지 — backend sync(#622) 정확도 보장.
      // #707: boardingStationId도 같은 이유로 정정. 환승역에서 fusion이 옆 노선 stop id로 잠긴 상태면
      // backend가 그 id로 reschedule 계산해 잘못된 leg 알람을 보낼 수 있다. 같은 역명에서 train.line으로
      // 정확 매칭되는 stop id를 사용. 매칭 실패(데이터 누락 가상 케이스)는 currentStation.id로 안전 폴백.
      const correctedStation = findStationByNameAndLine(currentStation.name, train.line);
      const boardingStationId = correctedStation?.id ?? currentStation.id;
      void createLock({
        destinationId,
        trainCode: train.trainCode,
        boardingStationId,
        boardingLine: train.line,
        boardedAt: Date.now(),
        expectedDurationMs: durationMin * 60_000,
      });
    },
    [destinationId, currentStation, expectedDurationMinutes, createLock],
  );

  const release = useCallback(() => {
    void releaseLock();
  }, [releaseLock]);

  return {
    lock,
    directionalArrivals,
    createLockFromTrain,
    releaseLock: release,
  };
}
