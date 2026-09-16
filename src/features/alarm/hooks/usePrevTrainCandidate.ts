/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useMemo, useState } from 'react';
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

/** 만료 재평가 tick 간격(ms) — 캐시가 존재하는 동안에만 이 주기로 재평가한다. */
const PREV_TRAIN_TTL_TICK_MS = 5_000;

interface PrevTrainCacheEntry {
  contextKey: string;
  candidate: PrevTrainCandidate;
  /** 이 후보를 마지막으로 실제 관측(폴링)한 시각 — "최초 목격 시각"이 아니다. */
  lastSeenAtMs: number;
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
 * 이 구간에서도 최소 1건은 탭 가능하게 한다. 캐시는 trip context(출발역+다음역+호선+방향)가
 * 바뀌면 즉시 무효화된다.
 *
 * TTL 시계는 "최초 목격 시각"이 아니라 "마지막으로 관측된 시각"부터 흐른다(#2656 리뷰 MEDIUM-1).
 * 떠난 열차가 다음역 도착목록에 보통 2~2.5분 머무르므로, 최초 목격 시각을 고정하면 캐시가 실제로
 * 쓰이기 시작하는 시점(pool이 비는 순간)엔 이미 TTL의 상당 부분이 소진돼 있어 "탑승 후 뒤늦게
 * 누르려는" 사용자 요구를 깎는다. 그래서 동일 후보가 계속 관측되는 동안에도 `lastSeenAtMs`를
 * 매 폴링마다 갱신한다 — 캐시 실제 사용 구간(pool이 빈 이후)에 TTL을 온전히 쓸 수 있다.
 *
 * 캐시는 state(`cacheEntry`)로 보관하고 갱신/무효화는 전부 effect 안에서만 일어난다(렌더 중 ref
 * mutation 금지 — StrictMode 이중 렌더나 discard된 렌더에서 캐시가 오염될 수 있다). 캐시 갱신
 * effect는 `arrival`(useArrivalInfo가 실제로 새 데이터를 받았을 때만 참조가 바뀜 — 동일 content는
 * arrivalEqual로 걸러져 setState 자체가 안 일어난다) 변경에 걸어, "렌더가 일어난 매 순간"이 아니라
 * "진짜 새 폴링이 도착한 순간"에만 재기록되게 한다. 이렇게 하지 않고 `freshCandidate`(파생 객체라
 * caller가 currentArrivals/route 등을 매 렌더 새 참조로 넘기면 내용이 같아도 매번 다른 객체) 자체를
 * 의존성으로 쓰면 setState→리렌더→effect 재실행이 무한 반복될 수 있다(실제로 재현된 버그).
 *
 * 만료 판정은 `now` tick(자체 interval, `PREV_TRAIN_TTL_TICK_MS` 간격)에 의존한다. 이 interval은
 * 캐시가 존재하는 동안에만 등록되고(#2656 리뷰 — 캐시가 없을 때 5초마다 리렌더를 만드는 건 순수
 * 낭비이자 재렌더/발열 이슈(#2594)와 방향이 어긋난다), 캐시가 만료되거나 무효화되면 정지한다.
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

  // #2656 리뷰 LOW-3 — nextStationName을 key에 포함. origin/line/direction이 같아도 경로 재계산 등으로
  // 하류 기준역(nextStationName)만 바뀌면 이전 후보는 다른 구간 기준으로 뽑힌 것이라 무효화해야 한다.
  const contextKey = `${currentStation?.id ?? ''}|${nextStationName ?? ''}|${line ?? ''}|${direction ?? ''}`;

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

  const [cacheEntry, setCacheEntry] = useState<PrevTrainCacheEntry | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // 캐시 갱신/무효화 — "진짜 새 폴링(arrival 참조 변경)"에서만 실행. freshCandidate를 의도적으로
  // deps에서 제외한다(위 함수 doc 참조 — 무한 렌더 루프 재발 방지).
  useEffect(() => {
    if (freshCandidate) {
      setCacheEntry({ contextKey, candidate: freshCandidate, lastSeenAtMs: Date.now() });
      return;
    }
    setCacheEntry((prev) => (prev && prev.contextKey !== contextKey ? null : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrival, contextKey]);

  // 만료된 캐시를 실제로 비운다 — 이게 있어야 아래 interval 게이팅이 "캐시 없음"으로 판정해
  // tick을 멈출 수 있다.
  useEffect(() => {
    if (!cacheEntry) return;
    if (now - cacheEntry.lastSeenAtMs >= PREV_TRAIN_CANDIDATE_TTL_MS) {
      setCacheEntry(null);
    }
  }, [now, cacheEntry]);

  // #2656 리뷰 — 캐시가 있을 때만 tick을 돌린다. 만료 대상이 없는데 5초마다 리렌더를 만드는 건
  // 순수 낭비이고, 이 hook은 HomeScreen에서 2회 마운트되므로(prevTrain + transferPrevTrain) 상시
  // interval 2개를 추가하는 셈 — 재렌더/발열 문제(#2594)와 방향이 어긋난다.
  const hasCache = cacheEntry !== null;
  useEffect(() => {
    if (!hasCache) return;
    const id = setInterval(() => setNow(Date.now()), PREV_TRAIN_TTL_TICK_MS);
    return () => clearInterval(id);
  }, [hasCache]);

  const prevTrain = useMemo<PrevTrainCandidate | null>(() => {
    if (freshCandidate) return freshCandidate;
    if (!cacheEntry || cacheEntry.contextKey !== contextKey) return null;
    const ageMs = now - cacheEntry.lastSeenAtMs;
    if (ageMs >= PREV_TRAIN_CANDIDATE_TTL_MS) return null;
    return {
      train: cacheEntry.candidate.train,
      elapsedSeconds: cacheEntry.candidate.elapsedSeconds + Math.floor(ageMs / 1000),
    };
  }, [freshCandidate, cacheEntry, contextKey, now]);

  return { prevTrain, loading };
}
