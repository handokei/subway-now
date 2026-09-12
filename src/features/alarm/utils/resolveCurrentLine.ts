import type { LineNumber, Station } from '../../../shared/types/station';

/**
 * Epic #1204 N8 — Phase 알람 evaluator의 `currentLine` 입력 SSOT.
 *
 * 우선순위:
 *   1) `boardingLine` — 사용자 명시 의향 trip의 노선 (lock 활성 시 GPS jitter보다 우선)
 *   2) `nearestStation.line` — GPS 기반 fusion fallback (lockless trip 또는 lock 부재)
 *   3) null — 둘 다 없으면 `evaluateAlarmPhase`가 silent skip
 *
 * 회귀 evidence (22:52:40): 5호선 답십리 lock 활성 중 fusion이 2호선 상왕십리를
 * nearest로 잡으면 currentLine='2'로 잘못 평가되어 다른 leg의 hop fire 가능.
 * boardingLine='5' 우선으로 GPS jitter 무시 (ADR-014 사용자 명시 의향 trip 보호).
 *
 * 호출자는 BoardingLock 전체를 가지고 있지 않아도 `boardingLine`만 전달하면 된다 —
 * useStationAlarm은 동기 mirror state(`currentLockLine`)만 보관한다.
 */
export function resolveCurrentLine(
  boardingLine: LineNumber | null,
  nearestStation: Station | null,
): LineNumber | null {
  return boardingLine ?? nearestStation?.line ?? null;
}
