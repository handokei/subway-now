import { RANK_TIE_EPSILON_SECONDS } from '../constants/routeRanking';
import type { RouteCandidate } from './stationRoute';
import { getTransferSeconds } from './transferTimes';

/**
 * #1480 PR-1 — 경로 후보 정렬. 키는 정거장 수·주행 분(travelMinutes)이 아니라 `journeyTimeline` 엔진의
 * 총 소요(출발·환승 대기 포함, `RouteCandidate.elapsed`)다. 순수 함수 — 엔진 호출은 `attachElapsed`(stationRoute) 소관.
 *
 * - elapsed 모드(최적경로): 총 소요가 가장 짧은 후보. |Δ|<=ε(2분)인 근사 동률은 환승 횟수 -> 환승 도보 합 -> 정거장 수.
 * - transferFirst 모드(최소환승): 환승 횟수 -> (그룹 안에서) elapsed 모드와 같은 규칙.
 * - waitUnknown(대기 하한)은 확정 후보보다 ε를 넘게 빠를 때만 앞선다.
 * - lastTrainEnded는 항상 맨 뒤(그 안에서는 travelMinutes 순).
 */
export type RankMode = 'elapsed' | 'transferFirst';

function elapsedOf(c: RouteCandidate): NonNullable<RouteCandidate['elapsed']> {
  return c.elapsed ?? { seconds: c.travelMinutes * 60, waitUnknown: false, lastTrainEnded: false };
}

function transferWalkSeconds(route: RouteCandidate['route']): number {
  if (route.type === 'direct') return 0;
  if (route.type === 'transfer') return getTransferSeconds(route.fromLine, route.toLine, route.transferName);
  return route.transfers.reduce((sum, t) => sum + getTransferSeconds(t.fromLine, t.toLine, t.transferName), 0);
}

function tieBreak(a: RouteCandidate, b: RouteCandidate): number {
  return (
    a.transferCount - b.transferCount ||
    transferWalkSeconds(a.route) - transferWalkSeconds(b.route) ||
    a.totalStops - b.totalStops ||
    elapsedOf(a).seconds - elapsedOf(b).seconds
  );
}

/** 종료되지 않은 후보 풀에서 1위를 고른다(풀은 비어 있지 않다). */
function pickBest(pool: readonly RouteCandidate[]): RouteCandidate {
  const known = pool.filter((c) => !elapsedOf(c).waitUnknown);
  let eligible = pool;
  if (known.length > 0) {
    const bestKnown = Math.min(...known.map((c) => elapsedOf(c).seconds));
    eligible = pool.filter((c) => !elapsedOf(c).waitUnknown || elapsedOf(c).seconds < bestKnown - RANK_TIE_EPSILON_SECONDS);
  }
  const best = Math.min(...eligible.map((c) => elapsedOf(c).seconds));
  const tied = eligible.filter((c) => elapsedOf(c).seconds <= best + RANK_TIE_EPSILON_SECONDS);
  return [...tied].sort(tieBreak)[0];
}

function rankPool(pool: readonly RouteCandidate[]): RouteCandidate[] {
  const remaining = [...pool];
  const ranked: RouteCandidate[] = [];
  while (remaining.length > 0) {
    const best = pickBest(remaining);
    ranked.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }
  return ranked;
}

export function rankCandidates(candidates: readonly RouteCandidate[], mode: RankMode): RouteCandidate[] {
  const live = candidates.filter((c) => !elapsedOf(c).lastTrainEnded);
  const ended = candidates.filter((c) => elapsedOf(c).lastTrainEnded).sort((a, b) => a.travelMinutes - b.travelMinutes);
  if (mode === 'elapsed') return [...rankPool(live), ...ended];
  const transferCounts = [...new Set(live.map((c) => c.transferCount))].sort((a, b) => a - b);
  const grouped = transferCounts.flatMap((count) => rankPool(live.filter((c) => c.transferCount === count)));
  return [...grouped, ...ended];
}
