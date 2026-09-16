/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useMemo, useRef } from 'react';
import { useArrivalInfo } from '../../arrival/hooks/useArrivalInfo';
import { resolveTripDirection } from '../../route/utils/tripDirection';
import { findStationByNameAndLine, getStopSeconds } from '../../../shared/utils/stationRoute';
import type { Route } from '../../../shared/utils/stationRoute';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { LineNumber, Station } from '../../../shared/types/station';
import type { ArrivalProvider } from '../../../shared/types/providers';
import { PREV_TRAIN_CANDIDATE_TTL_MS } from '../../../shared/constants/eta';

export interface UsePrevTrainCandidateInputs {
  route: Route;
  destinationName: string | null;
  /** 출발역(사용자가 탑승할 역) — trip origin. */
  currentStation: Station | null;
  /** 출발역의 route 진행 방향 바로 다음 인접역 이름. */
  nextStationName: string | null;
  /** null이면(호선 미확정) 후보 산출 skip. */
  line: LineNumber | null;
  /** 출발역 도착 list — 이미 이 목록에 있는 trainCode는 "아직 출발 전"이라 전열차 후보에서 제외. */
  currentArrivals: ArrivalInfo[];
  arrivalProvider?: ArrivalProvider;
}

export interface PrevTrainCandidate {
  train: ArrivalInfo;
  /** 출발역을 떠난 지 대략 몇 초 지났는지(추정, 0 미만은 0으로 clamp). */
  elapsedSeconds: number;
}

export interface UsePrevTrainCandidateResult {
  prevTrain: PrevTrainCandidate | null;
  /** 다음역 도착 정보 첫 폴링 완료 전 true. */
  loading: boolean;
}

/**
 * "전열차"(출발역을 방금 떠난 열차) 후보 도출 — #2139.
 *
 * 도착정보 API는 "도착 예정" 열차만 반환하므로 이미 출발한 열차는 출발역 응답에서 사라지고
 * 다음역 응답에 나타난다. 이 성질을 이용해 다음역 arrivals를 조회하고, 동일 line + 동일 진행
 * 방향 열차 중 출발역 arrivals(`currentArrivals`)에 없는 trainCode를 후보로 추린 뒤
 * arrivalSeconds가 가장 작은(=다음역에 가장 먼저 닿는) 열차를 "방금 출발한 열차"로 채택한다.
 *
 * currentStation/nextStationName/direction 중 하나라도 산출 불가하면 null(=UI가 기존 동작 유지).
 *
 * #2179 — 탑승한 열차가 다음 역마저 통과하면 도착정보 API 응답(현재역/다음역 모두)에서 완전히
 * 사라져 pool이 비고 candidate가 0건이 된다("탑승 직후 못 누르고 뒤늦게 누르려 하면 목록에 없다"는
 * 실사용자 재발 #2179). 직전에 산출됐던 후보를 `PREV_TRAIN_CANDIDATE_TTL_MS` 동안 캐시로 보존해,
 * 이 구간에서도 최소 1건은 탭 가능하게 한다. 캐시는 trip context(출발역+호선+방향)가 바뀌면
 * 즉시 무효화되고, 살아있는 동안은 경과 시간을 실제 wall clock으로 계속 갱신한다.
 */
export function usePrevTrainCandidate({
  route,
  destinationName,
  currentStation,
  nextStationName,
  line,
  currentArrivals,
  arrivalProvider,
}: UsePrevTrainCandidateInputs): UsePrevTrainCandidateResult {
  const { arrival, loading } = useArrivalInfo(nextStationName, line, arrivalProvider);

  const direction = useMemo(() => {
    if (!route || !destinationName || !currentStation) return null;
    return resolveTripDirection(route, destinationName, currentStation.id);
  }, [route, destinationName, currentStation]);

  const contextKey = `${currentStation?.id ?? ''}|${line ?? ''}|${direction ?? ''}`;
  const cacheRef = useRef<{ contextKey: string; candidate: PrevTrainCandidate; cachedAtMs: number } | null>(null);

  const freshCandidate = useMemo<PrevTrainCandidate | null>(() => {
    if (!arrival || !currentStation || !nextStationName || !line) return null;
    const nextStation = findStationByNameAndLine(nextStationName, line);
    if (!nextStation) return null;

    const pool =
      direction === 'up' ? arrival.up : direction === 'down' ? arrival.down : [...arrival.up, ...arrival.down];
    const currentCodes = new Set(currentArrivals.map((t) => t.trainCode));
    const candidates = pool.filter(
      (t) => t.line === line && t.arrivalSeconds >= 0 && !currentCodes.has(t.trainCode),
    );
    if (candidates.length === 0) return null;

    const closest = candidates.reduce(
      (min, cur) => (cur.arrivalSeconds < min.arrivalSeconds ? cur : min),
      candidates[0],
    );
    const stopSeconds = getStopSeconds(line, currentStation.id, nextStation.id);
    const elapsedSeconds = Math.max(0, stopSeconds - closest.arrivalSeconds);
    return { train: closest, elapsedSeconds };
  }, [arrival, currentStation, nextStationName, direction, currentArrivals, line]);

  const prevTrain = useMemo<PrevTrainCandidate | null>(() => {
    const cache = cacheRef.current;
    if (cache && cache.contextKey !== contextKey) {
      cacheRef.current = null;
    }

    if (freshCandidate) {
      cacheRef.current = { contextKey, candidate: freshCandidate, cachedAtMs: Date.now() };
      return freshCandidate;
    }

    const cached = cacheRef.current;
    if (!cached || cached.contextKey !== contextKey) return null;
    const ageMs = Date.now() - cached.cachedAtMs;
    if (ageMs >= PREV_TRAIN_CANDIDATE_TTL_MS) {
      cacheRef.current = null;
      return null;
    }
    return { train: cached.candidate.train, elapsedSeconds: cached.candidate.elapsedSeconds + Math.floor(ageMs / 1000) };
  }, [freshCandidate, contextKey]);

  return { prevTrain, loading };
}
