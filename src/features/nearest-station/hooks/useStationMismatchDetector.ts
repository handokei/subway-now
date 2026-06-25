/* eslint-disable import/no-restricted-paths --
 * Phase 6.1 (#1844) Sub-step 5 — cold start 선택 역과 진행 중 신호 mismatch 감지.
 * alarm slice의 appendAlarmLog를 사용해 측정 적재. useStationAlarm / useFusedNearestStation 등
 * 다른 cross-feature orchestrator와 동일 패턴 — CLAUDE.md `디렉토리 경계 룰` 헤더 opt-in.
 */
import { useEffect, useRef } from 'react';
import { appendAlarmLog } from '../../alarm/utils/alarmLog';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { NearestStationResult, Station } from '../../../shared/types/station';
import type { Environment } from '../utils/inferEnvironment';
import { getStationById } from '../../../shared/utils/stationRoute';

/**
 * Phase 6.1 Sub-step 5 (#1844) — cold start 선택 역과 진행 중 신호 mismatch 감지.
 *
 * 배경
 * ====
 * cold start 환경(지하·GPS 약)에서 사용자가 잘못된 역을 선택한 채 trip이 진행되면
 * lock.boardingLine / arcStations 기반 알람이 계속 오발사된다. 진행 중 신호(fusion
 * 결과·environment·arc 진행)와 선택 시작점이 N회 연속 불일치하면 재확인 prompt를 trigger.
 *
 * Mismatch Reason 정의
 * ====================
 * - 'route-diverged'        : observed 역이 arc 위 expected window(±HOP_THRESHOLD) 밖 — 3회 연속
 * - 'line-mismatch'         : lock.boardingLine ≠ fusedResult.station.line — 3회 연속
 * - 'environment-mismatch'  : lock 탑승역 type=underground + observed environment=surface — 3회 연속
 *
 * 한 번 일치 → 해당 reason 카운터 reset (false positive 차단).
 *
 * Wire-completion
 * ===============
 * HomeScreen / trip controller에서 useStationMismatchDetector를 호출한다.
 * detected=true 시 ActionBanner("재선택")를 표시해 사용자에게 재확인 기회를 준다.
 * alarmLog reason='cold-start-mismatch'로 1주 production 빈도 측정.
 *
 * Race condition guards
 * =====================
 * - lock=null / fusedResult=null → 즉시 no-op(detected=false).
 * - arcStations 빈 배열 → route-diverged 감지 비활성 (arc 없으면 diverge 판단 불가).
 * - 1분 dedup 윈도우 — 같은 reason 연속 적재 차단.
 */

/** line-mismatch 감지 연속 임계값. */
export const LINE_MISMATCH_THRESHOLD = 3;

/** environment-mismatch 감지 연속 임계값. */
export const ENV_MISMATCH_THRESHOLD = 3;

/** route-diverged 감지 연속 임계값. */
export const ROUTE_DIVERGE_THRESHOLD = 3;

/** arc 위 ±N hop 이탈 시 diverge 카운트 증가. */
export const ROUTE_DIVERGE_HOP_THRESHOLD = 3;

/** alarmLog 중복 적재 차단 윈도우(ms). */
export const MISMATCH_LOG_DEDUP_WINDOW_MS = 60 * 1000;

export type MismatchReason = 'route-diverged' | 'line-mismatch' | 'environment-mismatch';

export interface StationMismatchResult {
  /** mismatch 감지 여부. */
  detected: boolean;
  /** 감지 사유. detected=false 시 null. */
  reason: MismatchReason | null;
}

export interface UseStationMismatchDetectorInput {
  /** 현재 진행 중 lock. null이면 감지 비활성. */
  boardingLock: BoardingLock | null;
  /** useFusedNearestStation 결과 현재역. null이면 감지 비활성. */
  fusedResult: NearestStationResult | null;
  /** 현재 arc(탑승~waypoint). 빈 배열이면 route-diverged 감지 비활성. */
  arcStations: readonly Station[];
  /** 현재 추정 hop index. null이면 route-diverged 감지 비활성. */
  currentHopIndex: number | null;
  /** 환경 분류. environment-mismatch 감지용. */
  environment: Environment;
}

const NO_MISMATCH: StationMismatchResult = { detected: false, reason: null };

/**
 * 감지 결과를 계산하는 순수 함수.
 * 모든 카운터를 외부에서 받아 side effect 없이 다음 카운터를 반환.
 *
 * 우선순위: route-diverged > line-mismatch > environment-mismatch
 */
export function computeMismatch(
  input: UseStationMismatchDetectorInput,
  counters: { routeDiverged: number; lineMismatch: number; envMismatch: number },
): {
  result: StationMismatchResult;
  next: { routeDiverged: number; lineMismatch: number; envMismatch: number };
} {
  const { boardingLock, fusedResult, arcStations, currentHopIndex, environment } = input;

  if (!boardingLock || !fusedResult) {
    return { result: NO_MISMATCH, next: { routeDiverged: 0, lineMismatch: 0, envMismatch: 0 } };
  }

  // ── route-diverged ───────────────────────────────────────────────────────────
  let routeDiverged = counters.routeDiverged;
  if (arcStations.length > 0 && currentHopIndex !== null) {
    const observedIdx = arcStations.findIndex((s) => s.id === fusedResult.station.id);
    const isDiverged =
      observedIdx === -1 ||
      Math.abs(observedIdx - currentHopIndex) > ROUTE_DIVERGE_HOP_THRESHOLD;
    routeDiverged = isDiverged ? routeDiverged + 1 : 0;
  } else {
    // arc 없음 / hopIndex 없음 → route-diverged 감지 비활성, 카운터 유지 안 함
    routeDiverged = 0;
  }

  // ── line-mismatch ────────────────────────────────────────────────────────────
  const observedLine = fusedResult.station.line;
  const lineMismatch =
    observedLine !== boardingLock.boardingLine ? counters.lineMismatch + 1 : 0;

  // ── environment-mismatch ─────────────────────────────────────────────────────
  // lock.boardingStationId로 탑승역 조회 → environment 확인
  const boardingStation = getStationById(boardingLock.boardingStationId);
  let envMismatch = counters.envMismatch;
  if (boardingStation?.environment === 'underground' && environment === 'surface') {
    envMismatch = counters.envMismatch + 1;
  } else if (boardingStation !== undefined) {
    // 탑승역 조회 성공, 조건 미충족 → reset
    envMismatch = 0;
  }
  // boardingStation=undefined 시 카운터 유지 (조회 실패는 neutral)

  const next = { routeDiverged, lineMismatch, envMismatch };

  // ── 우선순위 판정 ────────────────────────────────────────────────────────────
  if (routeDiverged >= ROUTE_DIVERGE_THRESHOLD) {
    return { result: { detected: true, reason: 'route-diverged' }, next };
  }
  if (lineMismatch >= LINE_MISMATCH_THRESHOLD) {
    return { result: { detected: true, reason: 'line-mismatch' }, next };
  }
  if (envMismatch >= ENV_MISMATCH_THRESHOLD) {
    return { result: { detected: true, reason: 'environment-mismatch' }, next };
  }
  return { result: NO_MISMATCH, next };
}

/**
 * cold start 선택 역과 진행 중 신호 mismatch를 감지한다.
 *
 * @returns StationMismatchResult — detected=true 시 재확인 UI를 트리거.
 */
export function useStationMismatchDetector(
  input: UseStationMismatchDetectorInput,
): StationMismatchResult {
  const countersRef = useRef({ routeDiverged: 0, lineMismatch: 0, envMismatch: 0 });
  const resultRef = useRef<StationMismatchResult>(NO_MISMATCH);
  const lastLogRef = useRef<{ reason: MismatchReason; ts: number } | null>(null);

  // 입력 deps로 effect 재실행 — 매 polling tick마다 fusedResult/environment가 갱신됨
  const { boardingLock, fusedResult, arcStations, currentHopIndex, environment } = input;

  useEffect(() => {
    const { result, next } = computeMismatch(
      { boardingLock, fusedResult, arcStations, currentHopIndex, environment },
      countersRef.current,
    );
    countersRef.current = next;
    resultRef.current = result;

    if (!result.detected || !result.reason) return;

    // alarmLog 적재 (dedup 60s 윈도우)
    const now = Date.now();
    const last = lastLogRef.current;
    if (last?.reason === result.reason && now - last.ts < MISMATCH_LOG_DEDUP_WINDOW_MS) return;
    lastLogRef.current = { reason: result.reason, ts: now };

    // fusedResult는 detected=true 시 항상 non-null (null guard at top of computeMismatch).
    appendAlarmLog({
      ts: now,
      source: 'fg-evaluated',
      outcome: 'suppressed',
      reason: 'cold-start-mismatch',
      // stationName 슬롯에 관측된 현재역 id 적재 — 디버그 시 "어떤 역에서 mismatch?" 가시
      stationName: fusedResult!.station.id,
      // expectedStationAtFire 슬롯에 reason 적재 — 기존 AlarmLogStamp 스키마 재사용
      expectedStationAtFire: result.reason,
    });
  }, [boardingLock, fusedResult, arcStations, currentHopIndex, environment]);

  return resultRef.current;
}
