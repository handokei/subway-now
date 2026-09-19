/**
 * #1534 (S1, T9b, ADR-016) — backend가 추론한 lock 제안 reader hook.
 *
 * 배경: lockless trip 등록 직후 backend가 GPS + arvlcd + trainCode 종합으로 origin/train을
 * 추론한 결과(`TripPositionSSoT.lockSuggestion`)를 silent push payload + POST /position
 * response 양쪽이 BACKEND_SSOT_MIRROR_KEY에 영속화한다. 본 hook은 그 mirror에서
 * lockSuggestion을 reader-only로 노출한다.
 *
 * 단일 책임:
 *   - AsyncStorage 폴링(5s 간격) — silent push handler / position upload response가 mirror를
 *     write하면 다음 tick에서 read.
 *   - LockSuggestion 형식 검증은 backendSsotMirror.parseLockSuggestion이 책임.
 *   - 채택 정책(1순위 lockSuggestion / 2순위 9-AND gate fallback)은 consumer
 *     (`useBoardingLockController`)가 책임 — 본 hook은 raw state만 노출.
 *
 * Wire-completion (5단):
 *   1. Orphan 없음: caller = useBoardingLockController.
 *   2. V/X dashboard: DebugModal "Backend SSoT mirror" 섹션이 BACKEND_SSOT_MIRROR_KEY 전체를
 *      이미 노출 (lockSuggestion 필드 포함, 추가 wiring 불필요).
 *   3. 의존 PR: backend lockSuggestion write site (본 PR 같은 atomic 변경).
 *   4. 측정 plan: production lockSuggestion 채택율 — alarmLog forward(P0-3)의 ssotMirror
 *      snapshot에서 1주 측정. V2(lockless 첫 station miss ≤2) 직접 검증.
 *   5. Device verify: 실기기 trip(currentStation=null start) → lockSuggestion 채택 →
 *      BoardingLockHopCard 활성화 시나리오.
 */

import { useEffect, useState } from 'react';
import {
  readBackendSsotMirror,
  type BackendSsotMirrorEntry,
  type LockSuggestionMirror,
} from '../utils/backendSsotMirror';

/**
 * BACKEND_SSOT_MIRROR_KEY 폴링 간격 (ms). useFusedNearestStation의 5s tick과 정합.
 * backend silent push가 cycle(~30s)마다 발사되므로 5s는 충분히 빈번.
 */
export const LOCK_SUGGESTION_POLL_INTERVAL_MS = 5_000;

/**
 * lockSuggestion이 set된 후 device가 staleness로 판단하기 시작하는 임계 (ms).
 *
 * 5분(300s) — backend가 직전 cycle에 set한 lockSuggestion이 그 후 cycle에서 갱신 없이 유지되는
 * 정상 case (트레인이 멈춰있는 동안 등)를 포용한다. 5분 초과 시 device는 stale로 보고 채택
 * 차단 — 사용자가 다른 trip으로 전환했는데 mirror가 stale인 회귀(Mirror leak #3)를 방어.
 *
 * 본 임계는 cascade picker(BACKEND_SSOT_MIRROR_MAX_AGE_MS=180s)와 별개 — lockSuggestion 채택
 * 결정은 보수적으로 더 짧은 1차 윈도우를 두지 않는다 (사용자 의향 trip 영구 보호 vs false
 * positive 차단의 trade-off는 receivedAt drift로 자연 해소).
 */
export const LOCK_SUGGESTION_MAX_AGE_MS = 5 * 60_000;

/**
 * `useLockSuggestion` hook 결과.
 *
 * 채택 정책(1순위 / fallback)은 caller가 결정. 본 hook은:
 *   - suggestion: backend lockSuggestion 또는 null (미존재 / stale / 형식 오류 시 null)
 *   - decidedAt: backend가 결정한 epoch ms (caller의 UI/디버그 노출용)
 *   - sourceReceivedAt: device가 mirror를 수신한 epoch ms (staleness 검증 별도 활용 가능)
 */
export interface LockSuggestionResult {
  suggestion: LockSuggestionMirror | null;
  decidedAt: number | null;
  sourceReceivedAt: number | null;
}

/**
 * BACKEND_SSOT_MIRROR_KEY를 폴링해 lockSuggestion을 노출하는 reader-only hook.
 *
 * 빈 상태(null) → backend가 아직 lockSuggestion을 set하지 않은 trip 또는 mirror staleness.
 * caller는 null일 때 기존 9-AND gate fallback으로 동작해야 한다.
 *
 * `now`는 jest 테스트가 `jest.useFakeTimers()` + `Date.now` mock 없이 staleness를 결정적으로
 * 제어할 수 있게 옵션 주입. production은 `Date.now`가 기본값.
 */
export function useLockSuggestion(options?: {
  now?: () => number;
}): LockSuggestionResult {
  const now = options?.now ?? Date.now;
  const [state, setState] = useState<LockSuggestionResult>({
    suggestion: null,
    decidedAt: null,
    sourceReceivedAt: null,
  });

  useEffect(() => {
    let cancelled = false;
    const handleEntry = (entry: BackendSsotMirrorEntry | null): void => {
      if (cancelled) return;
      const next = computeNextState(entry, now());
      setState((prev) => mergeSuggestionState(prev, next));
    };
    const tick = (): void => {
      void readBackendSsotMirror().then(handleEntry);
    };
    // 첫 read는 폴링 첫 tick에 맡긴다 — useFusedNearestStation BACKEND_SSOT_MIRROR_KEY 폴링과
    // 동일 패턴. 마운트 직후 동기 read의 microtask resolve가 첫 render commit phase와 겹쳐
    // act() warning을 발생시키는 회귀 차단(jest-expo setup).
    const id = setInterval(tick, LOCK_SUGGESTION_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [now]);

  return state;
}

const NULL_STATE: LockSuggestionResult = {
  suggestion: null,
  decidedAt: null,
  sourceReceivedAt: null,
};

/**
 * 폴링 entry를 LockSuggestionResult로 변환. 부재 / stale entry는 null state, valid 정상은 매칭
 * suggestion entry를 반환. 본 함수는 순수 — `useEffect` 안 nested function 깊이를 4 미만으로 유지.
 */
function computeNextState(
  entry: BackendSsotMirrorEntry | null,
  nowMs: number,
): LockSuggestionResult {
  if (!entry?.lockSuggestion) return NULL_STATE;
  const ageMs = nowMs - entry.receivedAt;
  if (ageMs > LOCK_SUGGESTION_MAX_AGE_MS) return NULL_STATE;
  return {
    suggestion: entry.lockSuggestion,
    decidedAt: entry.lockSuggestion.decidedAt,
    sourceReceivedAt: entry.receivedAt,
  };
}

/**
 * setState reducer — 동일 state 비교로 무용한 update 차단 (re-render 폭주 방지).
 */
function mergeSuggestionState(
  prev: LockSuggestionResult,
  next: LockSuggestionResult,
): LockSuggestionResult {
  if (next.suggestion === null) {
    if (prev.suggestion === null) return prev;
    return NULL_STATE;
  }
  if (
    prev.suggestion !== null &&
    prev.suggestion.stationId === next.suggestion.stationId &&
    prev.suggestion.trainCode === next.suggestion.trainCode &&
    prev.suggestion.lineId === next.suggestion.lineId &&
    prev.suggestion.confidence === next.suggestion.confidence &&
    prev.decidedAt === next.decidedAt &&
    prev.sourceReceivedAt === next.sourceReceivedAt
  ) {
    return prev;
  }
  return next;
}
