import type { BoardingLock } from '../types/boardingLock';

/**
 * #2290 P1-1 — 출발 leg의 boarding 대기(다음 열차 대기)가 이미 소진됐는지 판정.
 *
 * RCA (PR #2295 리뷰): 원래 구현은 `Boolean(lock)`만으로 in-trip을 판정해 ETA에서 출발 대기를
 * 제외했다. 하지만 user-tap lock(BoardingTrainList 직접 탭, `createLockFromTrain`)은 생성
 * 시점에 "미래 열차를 선택"했을 뿐 실제 탑승 evidence가 없다 — 승강장에서 열차를 기다리는 중에도
 * "이미 탑승"으로 오판해 ETA를 과소표시했다(알림/LA/화면 3곳 공통 회귀).
 *
 * 일반 조건 — "lock 존재 여부"가 아니라 "출발 대기를 실제로 소진했는가":
 * - `lock.boardingEvidence === true` (device-side auto-lock: arvlCd ENTERING/ARRIVED/DEPARTED
 *   강 게이트 + 4-signal consensus 통과) → 생성 시점 자체가 탑승 evidence이므로 즉시 소진.
 * - 그 외(user-tap 등 "미래 열차 선택"만 있는 lock) → `initialEtaSeconds`(#897 탑승 시점 ETA
 *   스냅샷) 경과 여부로 판정한다: `(now - boardedAt) >= initialEtaSeconds`.
 * - `initialEtaSeconds` 부재(레거시 lock/evidence 없는 자동 lock 등) → 보수적으로 false
 *   (대기 유지 — 과다표시가 과소표시보다 안전, ADR-014 첫 줄 정합).
 *
 * @param lock - 현재 활성 BoardingLock. null이면 lock 미활성 → false.
 * @param now - 판정 시각(ms epoch). 호출자가 `Date.now()`를 주입(테스트에서 monkeypatch 가능).
 */
export function hasConsumedOriginWait(lock: BoardingLock | null, now: number): boolean {
  if (!lock) return false;
  if (lock.boardingEvidence) return true;
  if (lock.initialEtaSeconds == null) return false;
  return now - lock.boardedAt >= lock.initialEtaSeconds * 1000;
}
