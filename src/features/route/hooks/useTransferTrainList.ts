/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { prefetchArrival, useArrivalInfo } from '../../arrival/hooks/useArrivalInfo';
import { useBoardingLockStore } from '../../alarm/store/useBoardingLockStore';
import { useLegAdvanceStore } from '../../alarm/store/useLegAdvanceStore';
import { resolveBackendSsotMirrorStation } from '../../alarm/utils/backendSsotMirror';
import { useBackendSsotMirrorPoll } from '../../alarm/hooks/useBackendSsotMirrorPoll';
import {
  findActiveTransferContext,
  findLocklessTransferWaypoint,
  findUpcomingTransferPrefetch,
} from '../utils/findActiveTransferContext';
import { FALLBACK_BOARDING_DURATION_MINUTES } from '../../../shared/constants/boardingLock';
import { BACKEND_SSOT_MIRROR_MAX_AGE_MS } from '../../../shared/constants/realtime';
import { calculateRemainingLegETA } from '../../../shared/utils/stationRoute';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import type { ArrivalProvider } from '../../../shared/types/providers';
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
  /**
   * #2115 — (환승역, 다음 노선) 키의 첫 arrival fetch가 아직 완료되지 않았는지 여부.
   * true인 동안 호출자(BoardingTrainList)는 "도착 예정 열차 없음" 대신 loading skeleton을
   * 노출해야 한다. context 비활성(currentStation=null 등)이면 useArrivalInfo 자체가 idle이라 false.
   */
  loading: boolean;
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
  // #2590 — 환승 컨텍스트 판정용 currentStation에 backend SSoT mirror를 1순위로 주입.
  //
  // RCA(2026-09-13 데스크 trip, token b00dd879): HomeScreen이 넘기는 `currentStation`은
  // useFusedNearestStation의 최종 표시 station(GPS/fused)이다. backend가 이미 leg-2로
  // advance했어도, cascade picker 내부 ADR-038 line 정합 가드(GPS-derived positionTrainResult와
  // mirror line이 다르면 mirror를 거부)가 표시 station을 GPS 쪽에 묶어둘 수 있다 — 이 가드는
  // *표시* SSoT 안정성을 위한 것으로 의도적이며(fusion picker 자체는 수정 금지), 그 결과 이
  // 훅에서는 leg-2 환승역이 영원히 감지되지 않는다.
  //
  // 그래서 이 훅은 #2589(LA refresh)와 동일 패턴으로 backend SSoT mirror를 별도로 직접
  // polling(5s, cascade picker와 동일 주기)해, fresh(≤180s, BACKEND_SSOT_MIRROR_MAX_AGE_MS)하고
  // resolve 가능하면 그 station을 currentStation보다 우선한다. lock 활성 시 lock.boardingLine으로
  // 정확 매칭(둘 다 없으면 name-only fallback) — `resolveBackendSsotMirrorStation` 계약은
  // useFusedNearestStation과 동일.
  //
  // 오탑승 안전장치: 여기서는 GPS-line 교차검증을 반복하지 않는다. 대신 `findActiveTransferContext`
  // (`resolveTransferWaypoint`)가 route가 기대하는 환승역 이름과 정확히 일치할 때만 context를
  // 활성화하므로, mirror가 엉뚱한 역을 가리키면 이름이 매칭되지 않아 context는 자연히 비활성으로
  // 남는다(기존 "탑승역만" 안전장치와 동일 계약, 추가 게이트 불필요).
  //
  // #2590 (SonarCloud dup 해소) — 폴링 boilerplate는 useFusedNearestStation과 공유하는
  // useBackendSsotMirrorPoll로 추출(순수 추출, 동작/타이밍 100% 동일. 상세 계약은 그 훅의
  // docblock 참조).
  const backendSsotMirror = useBackendSsotMirrorPoll();

  const transferCurrentStation = useMemo(() => {
    if (!backendSsotMirror) return currentStation;
    const fresh = Date.now() - backendSsotMirror.receivedAt <= BACKEND_SSOT_MIRROR_MAX_AGE_MS;
    if (!fresh) return currentStation;
    const resolved = resolveBackendSsotMirrorStation(
      backendSsotMirror,
      lock ? lock.boardingLine : undefined,
    );
    return resolved ?? currentStation;
  }, [backendSsotMirror, currentStation, lock]);

  const context = useMemo(
    () => findActiveTransferContext(lock, route, destinationName, transferCurrentStation),
    [lock, route, destinationName, transferCurrentStation],
  );

  const transferStationName = context?.transferStationInToLine.name ?? null;
  const transferLine = context?.nextLine ?? null;
  const { arrival, loading, refetch } = useArrivalInfo(transferStationName, transferLine, arrivalProvider);

  // #814 — 환승 알람 imminent 시점부터 다음 노선 arrival을 사전 폴링한다.
  // findUpcomingTransferPrefetch는 lock 활성 + transfer 라우트 + 다음 환승까지 잔여 stops ≤ 1
  // (또는 이미 환승역 위)일 때만 target을 반환한다. 비환승 trip(direct route)이면 항상 null —
  // prefetch가 자연스럽게 skip되어 불필요 폴링이 발생하지 않는다.
  // prefetchArrival 자체가 cache TTL(30s) 내 valid 엔트리가 있으면 no-op이라 같은 trigger가
  // 여러 번 호출돼도 중복 네트워크 호출이 없다.
  const upcomingTransfer = useMemo(
    () => findUpcomingTransferPrefetch(lock, route, destinationName, transferCurrentStation),
    [lock, route, destinationName, transferCurrentStation],
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
  //
  // #2305 — 같은 활성화 전이(null→non-null)가 곧 fusion(lock+route+currentStation 합의)이
  // 환승 waypoint 도달을 확정하는 지점이다. 이 사실을 `useLegAdvanceStore`에 durable stamp해
  // 사용자 탭/hop-end 프롬프트 응답과 무관하게 `getApproachLine`이 다음 leg 노선을 유지하도록
  // 한다. RCA(2026-08-12 건대입구 7→2 환승): transfer auto-lock(create:other)이 생성된 직후
  // release되며 legAdvance stamp가 없어 route의 동결된 stopsToTransfer fallback으로 line이
  // 구노선(7)으로 붕괴했다 — lock 생성/해제 여부와 무관한 이 지점이 유일한 durable 신호여야 한다.
  const prevContextActiveRef = useRef(false);
  useEffect(() => {
    const active = context !== null;
    if (active && !prevContextActiveRef.current) {
      refetch();
      void useLegAdvanceStore.getState().stampLegAdvance(context.nextLine);
    }
    prevContextActiveRef.current = active;
  }, [context, refetch]);

  // #2319 — lockless trip(=origin lock 자체가 없는 trip) 환승 진행 시 durable legAdvance stamp 갭.
  // 위 effect는 `context`(lock-bound `findActiveTransferContext`)의 null→non-null 전이에서만
  // 발화하므로 lock이 아예 없는 trip은 영원히 stamp되지 않는다 (#2318 선행 검증 판정, PR #2313
  // Deviation 절). lock이 있으면 위 effect가 이미 stamp를 책임지므로(lock 존재 시 `context`가
  // 동일 waypoint에서 활성화됨), 이 effect는 lock=null 상태에서만 lock-비종속 신호
  // (`findLocklessTransferWaypoint`)로 같은 stamp를 보완 발화한다. arrivals/refetch/autoLock은
  // 여전히 lock-bound `context`만 사용 — stamp 전용 보완 경로다.
  const locklessWaypoint = useMemo(
    () =>
      lock ? null : findLocklessTransferWaypoint(route, destinationName, transferCurrentStation),
    [lock, route, destinationName, transferCurrentStation],
  );
  const prevLocklessWaypointKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = locklessWaypoint
      ? `${locklessWaypoint.transferStationInToLine.id}|${locklessWaypoint.nextLine}`
      : null;
    if (key && key !== prevLocklessWaypointKeyRef.current) {
      void useLegAdvanceStore.getState().stampLegAdvance(locklessWaypoint!.nextLine);
    }
    prevLocklessWaypointKeyRef.current = key;
  }, [locklessWaypoint]);

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
        // #897 Seam A: 환승 leg 탑승 시점 ETA 스냅샷. 새 폴 응답이 이보다 +180s 이상이면 지연 신호.
        initialEtaSeconds: train.arrivalSeconds,
      // #2290 P1 — 이 함수는 사용자가 BoardingTrainList에서 직접 탭한 경우에만 호출된다
      // (#2154 — D5 device auto-swap effect 삭제, 무탭 트리거 전량 제거). 탑승 확정 evidence가
      // 아니므로 evidence=false — `hasConsumedOriginWait`가 위 initialEtaSeconds 경과 여부로 판정한다.
      }, false);
    },
    [context, lock, route, createLock],
  );

  return { context, arrivals, loading, createTransferLock };
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
