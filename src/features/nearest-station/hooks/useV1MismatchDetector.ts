/* eslint-disable import/no-restricted-paths --
 * #1621 (Phase B) — cross-feature 측정 인프라. nearest-station 결과(UI currentStationId)와
 * alarm 슬라이스의 alarmLog를 cross로 연결해 V1 mismatch를 단일 출처(alarmLog reason)로 적재.
 * useStationAlarm/useFusedNearestStation 등 다른 cross-feature orchestrator와 동일 패턴 — CLAUDE.md
 * `디렉토리 경계 룰` 섹션에 따라 헤더 opt-in.
 */
import { useEffect, useRef } from 'react';
import { appendAlarmLog } from '../../alarm/utils/alarmLog';

/**
 * #1621 Phase B — V1 mismatch 자동 측정 hook.
 *
 * 배경
 * ====
 * Stage 1/2/3-1 (#1613/#1615/#1617) 누적 fix 후 V1(정확한 현재역)이 60-70% 회복 추정.
 * 그동안 V1 측정은 사용자 trip 직후 수동 annotation에만 의존 — 자동 측정 path 부재 (메모리
 * `feedback_wire_completion_gate`: "인프라 정의는 있는데 consumer 누락" 패턴 직접 evidence).
 *
 * 본 hook은 다음 두 signal을 비교해 mismatch를 alarmLog에 적재:
 *  - UI currentStation: `useFusedNearestStation`의 result.station.id (cascade picker 결과)
 *  - backend SSoT mirror: silent push handler가 영속화한 권위 currentStationId
 *
 * 두 값이 다르면 V1 회귀 신호 → 1분 dedup 윈도우로 entry 1건 적재.
 *
 * Wire-completion
 * ================
 * HomeScreen.tsx에서 호출 (consumer site 1개 — useFusedNearestStation 결과 + backendSsotMirror).
 * R2 archive 후 `/admin/alarm-log-stats` 응답의 `reasons['v1-mismatch']`로 1주 production 측정.
 *
 * Race condition guards
 * =====================
 *  - 둘 중 하나라도 null이면 비교 skip (graceful no-op).
 *  - 1분 dedup 윈도우 — 같은 (ui, ssot) 쌍 반복 mismatch는 1회만 적재.
 *  - SSoT mirror freshness는 caller (useFusedNearestStation)가 이미 60s 윈도우로 판정 후
 *    null로 두므로 본 hook은 단순 ID 비교만.
 *
 * @param uiCurrentStationId useFusedNearestStation.result.station.id (UI 표시 station)
 * @param ssotCurrentStationId backendSsotMirror.currentStationId (fresh일 때만)
 */
export function useV1MismatchDetector(
  uiCurrentStationId: string | null,
  ssotCurrentStationId: string | null,
): void {
  const lastMismatchRef = useRef<{ key: string; ts: number } | null>(null);
  useEffect(() => {
    if (uiCurrentStationId === null || ssotCurrentStationId === null) return;
    if (uiCurrentStationId === ssotCurrentStationId) return;
    const now = Date.now();
    const key = `${uiCurrentStationId}|${ssotCurrentStationId}`;
    const last = lastMismatchRef.current;
    if (last && last.key === key && now - last.ts < V1_MISMATCH_DEDUP_WINDOW_MS) return;
    lastMismatchRef.current = { key, ts: now };
    appendAlarmLog({
      ts: now,
      source: 'fg-evaluated',
      outcome: 'suppressed',
      reason: 'v1-mismatch',
      stationName: uiCurrentStationId,
      // ssot stationId는 expectedStationAtFire 슬롯 재사용 (새 schema 추가 회피).
      // DebugModal/baseline-check 응답에서 "expected vs actual" 한 줄로 가시.
      expectedStationAtFire: ssotCurrentStationId,
    });
  }, [uiCurrentStationId, ssotCurrentStationId]);
}

/** 같은 (ui, ssot) mismatch 쌍 dedup 윈도우. polling cycle 5s를 충분히 흡수. */
export const V1_MISMATCH_DEDUP_WINDOW_MS = 60 * 1000;
