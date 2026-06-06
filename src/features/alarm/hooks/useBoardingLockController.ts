/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useCallback, useEffect, useMemo } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { resolveTripDirection } from '../../route/utils/tripDirection';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { Route } from '../../../shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import {
  FALLBACK_BOARDING_DURATION_MINUTES,
  FREE_TRIP_DESTINATION_SENTINEL,
} from '../../../shared/constants/boardingLock';
import type { AutoLockCandidate } from '../../nearest-station/api/boardingLockSync';

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
  /**
   * #915/#916 — backend `/boarding-lock/sync` 응답의 autoLockCandidate로 lock을 hydrate.
   * destination-only baseline UX에서 사용자가 명시 탭하지 않아도 backend cron이 trainCode를
   * 결정하면 client store에 반영해 lock UX 활성화한다.
   *
   * idempotent: 이미 같은 trainCode + boardingLine으로 활성 lock이 있으면 no-op.
   * lock 생성을 위한 컨텍스트(destinationId / currentStation / line valid) 부족 시 no-op.
   */
  hydrateLockFromCandidate: (candidate: AutoLockCandidate) => void;
  /** 명시 하차. lock 없는 상태에서 호출돼도 안전. */
  releaseLock: () => void;
}

/**
 * #915 — backend candidate.line(string)이 LineNumber valid 값인지 narrow.
 * 미정합이면 hydrate skip — 호출자는 graceful로 lock 없는 상태 유지.
 */
const VALID_LINES: ReadonlyArray<LineNumber> = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', 'airport', 'gyeongui', 'bundang', 'sinbundang',
];
function asLineNumber(raw: string): LineNumber | null {
  return (VALID_LINES as ReadonlyArray<string>).includes(raw) ? (raw as LineNumber) : null;
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
  // #978: free-trip sentinel lock은 destinationId=null인 동안 그대로 유지하고, 사용자가 실제
  // destination을 설정하는 순간(sentinel !== realId) invalidate. destinationId=null + sentinel lock
  // 조합은 "여전히 free trip 진행 중"으로 본다.
  useEffect(() => {
    if (!lock) return;
    if (lock.destinationId === destinationId) return;
    if (destinationId === null && lock.destinationId === FREE_TRIP_DESTINATION_SENTINEL) return;
    void releaseLock();
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
    // #897 (Seam A): 임박(arrivalSeconds=0) 열차도 list에 유지 — useArrivalCountdown tick으로 0초가
    // 되어 행이 사라지면 사용자가 다음 차를 같은 차로 오인하는 회귀가 발생. 음수(이미 지나간)만 차단.
    // 음수 train은 createLockFromTrain에서도 의미가 없어 #666 가드를 갈음한다.
    const reachable = (t: ArrivalInfo): boolean => t.arrivalSeconds >= 0;
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
        // #897 Seam A: 탑승 시점 ETA 스냅샷. 동일 trainCode가 유지되는 동안 새 폴링의 arrivalSeconds가
        // 이 값보다 크게 늘면 그 차이가 지연(분). BoardingTrainList가 "+N분 지연" 칩으로 노출.
        initialEtaSeconds: train.arrivalSeconds,
      });
    },
    [destinationId, currentStation, expectedDurationMinutes, createLock],
  );

  const release = useCallback(() => {
    void releaseLock();
  }, [releaseLock]);

  // #915/#916 — backend autoLockCandidate를 받아 client BoardingLock store hydrate.
  // hydrate 정책: lock이 이미 존재하면 항상 no-op.
  //  - 사용자가 BoardingTrainList에서 명시 탭한 lock을 backend cron candidate(다른 trainCode 가능)가
  //    silently overwrite하지 않게 보호 (#915 self code-review).
  //  - destination 변경 시 controller의 stale-lock release effect가 lock=null로 만든 후에야 hydrate.
  //  - 자동 lock도 한 번 잡히면 변경 X (Seam F swap은 backend cron이 trip.boardingLock을 갱신하고
  //    silent push로 client store가 hydrate되는 별 경로).
  const hydrateLockFromCandidate = useCallback(
    (candidate: AutoLockCandidate) => {
      if (!currentStation) return;
      const boardingLine = asLineNumber(candidate.line);
      if (!boardingLine) return;
      if (lock) return;
      // #978 (PR #955 follow-up): destinationId 없으면 free-trip sentinel으로 hydrate.
      // 사용자가 나중에 실제 destination을 설정하면 위의 destination 변경 effect가
      // (sentinel !== realId) → 자동 release하므로 cross-talk 차단.
      const isSentinel = !destinationId;
      const effectiveDestinationId = destinationId ?? FREE_TRIP_DESTINATION_SENTINEL;
      const durationMin = expectedDurationMinutes ?? FALLBACK_BOARDING_DURATION_MINUTES;
      // boardingStationId는 createLockFromTrain과 동일하게 (역명, candidate.line) 매칭 정정.
      const correctedStation = findStationByNameAndLine(currentStation.name, boardingLine);
      const boardingStationId = correctedStation?.id ?? currentStation.id;
      const now = Date.now();
      createLock({
        destinationId: effectiveDestinationId,
        trainCode: candidate.trainCode,
        boardingStationId,
        boardingLine,
        boardedAt: now,
        expectedDurationMs: durationMin * 60_000,
        // initialEtaSeconds는 candidate에 없음 — Seam A 지연 칩은 cron이 채워둔 lock 메타로 노출되지 않으며,
        // 사용자가 명시 탭한 lock에서만 노출되는 게 의도(자동 lock은 정확도가 보장 안 됨).
        ...(isSentinel
          ? {
              hydratedFromSentinel: {
                destinationId: FREE_TRIP_DESTINATION_SENTINEL,
                sentinelAt: now,
              },
            }
          : {}),
      }).catch(() => {
        // store action rejection은 graceful — loadLock race / storage 일시 실패는 다음 sync에서 자연 재시도.
      });
    },
    [destinationId, currentStation, expectedDurationMinutes, lock, createLock],
  );

  return {
    lock,
    directionalArrivals,
    createLockFromTrain,
    hydrateLockFromCandidate,
    releaseLock: release,
  };
}
