/**
 * #1421 — PR-AutoLock-1 측정 인프라.
 *
 * Ring buffer 기반 stability 판정. SSOT consensus가 산출한 후보 stationId가 N=5 폴링 사이클 중
 * threshold=3 회 이상 동일 station을 가리키면 "stable"으로 본다 — 1~2회 잘못된 신호로 lock 산출
 * 회귀를 차단하는 1차 게이트.
 *
 * pure 함수 인터페이스: factory가 closure로 buffer를 들고, push/snapshot/reset 메서드만 노출.
 * React/AsyncStorage 의존 없음. 호출 hook이 매 폴링마다 push, 결과의 `stable`을 inferAutoLockCandidate에 전달.
 *
 * 임계값 근거:
 *   - size=5: 30s 폴링 기준 150s window — 한 역 정착 시간(평균 ~30~60s) 보다 길게, 정상 진행 trip이
 *     stale stable 신호를 만들지 않도록.
 *   - threshold=3: majority vote(5 중 다수). 단일 false consensus가 stable로 흘러가지 않게.
 *
 * null push는 buffer 미기록 — 신호 부재(예: arrival API 일시 실패)를 stable 카운트 깎는 사고로
 * 해석하지 않는다. SSOT 합의 자체가 미성립인 경우 호출자가 결과를 사용하지 않으므로 안전.
 */

/** Buffer 크기 기본값 — 30s 폴링 × 5건 = 150s window. */
const DEFAULT_SIZE = 5;
/** Stable 판정 임계 — 다수결(5중 3). */
const DEFAULT_THRESHOLD = 3;

export interface ConsensusStabilityOptions {
  size?: number;
  threshold?: number;
}

export interface ConsensusStabilitySnapshot {
  /** 가장 많이 카운트된 station이 threshold 이상 — auto-lock 산출 게이트 입력. */
  stable: boolean;
  /** 다수 station id. count < threshold면 stable=false이지만 가장 많은 station을 노출(디버깅용). */
  stationId: string | null;
  /** 다수 station의 buffer 내 카운트. */
  count: number;
}

export interface ConsensusStabilityBuffer {
  /** stationId 신호를 buffer에 기록 (null은 no-op). 결과는 push 직후 snapshot. */
  push(stationId: string | null): ConsensusStabilitySnapshot;
  /** 마지막 push 결과 재조회 (DebugModal 출력용). */
  snapshot(): ConsensusStabilitySnapshot;
  /** Buffer 비우기 (trip end 등). */
  reset(): void;
}

function computeSnapshot(
  entries: readonly string[],
  threshold: number,
): ConsensusStabilitySnapshot {
  if (entries.length === 0) return { stable: false, stationId: null, count: 0 };
  const counts = new Map<string, number>();
  for (const id of entries) counts.set(id, (counts.get(id) ?? 0) + 1);
  let topId: string | null = null;
  let topCount = 0;
  for (const [id, c] of counts) {
    if (c > topCount) {
      topCount = c;
      topId = id;
    }
  }
  return { stable: topCount >= threshold, stationId: topId, count: topCount };
}

export function createConsensusStabilityBuffer(
  options: ConsensusStabilityOptions = {},
): ConsensusStabilityBuffer {
  const size = options.size ?? DEFAULT_SIZE;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  let entries: string[] = [];

  return {
    push(stationId) {
      if (stationId !== null) {
        entries.push(stationId);
        if (entries.length > size) entries = entries.slice(entries.length - size);
      }
      return computeSnapshot(entries, threshold);
    },
    snapshot() {
      return computeSnapshot(entries, threshold);
    },
    reset() {
      entries = [];
    },
  };
}
