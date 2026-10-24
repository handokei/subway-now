import type { BoardingLock } from '../types/boardingLock';
import type { LineNumber } from '../types/station';

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

/**
 * #2393 — in-trip 판정 공통 헬퍼. HomeScreen(FG 표시 ETA)과 stationPipeline(BG 알림 body ETA)이
 * 동일 판정을 쓰도록 추출 — 중복/드리프트 방지(이슈 스펙 "주의" 항목).
 *
 * RCA: lockless(boardingLock 없음) + legAdvance stamp 없음(하차 응답 미발생) 조합에서는
 * 기존 두 신호(`hasConsumedOriginWait`, `legAdvanceLine`)가 모두 false로 떨어져, 이미 device가
 * station-passed/도착 알람을 발사(주행 중 evidence)한 뒤에도 ETA가 출발 대기를 계속 합산했다
 * (2026-08-27 성수→뚝섬 evidence: 실제 1분 hop인데 "6분"으로 표시).
 *
 * 신호 3개는 대체가 아니라 OR — 하나라도 "이미 탑승/주행 중" evidence면 in-trip.
 * - `hasConsumedOriginWait(lock, now)` — #2290, lock 기반 탑승 evidence.
 * - `legAdvanceLine !== null` — #2278, 사용자 하차 응답(다음 leg 진입 확정).
 * - `hasFiredThisTrip` — #2393, 이 trip에 station-passed/도착 알람이 이미 발사됨
 *   (`getFiredAlarms(destination.id)` non-empty). 발사됐다 = 주행 중이다(device-authority 정합).
 *   #2154 준수 — 기존 firedAlarms 원장만 재사용, 새 감지 경로 신설 아님.
 *
 * @param lock - 현재 활성 BoardingLock.
 * @param now - 판정 시각(ms epoch).
 * @param legAdvanceLine - `useLegAdvanceStore`의 `nextLine`(하차 응답 stamp).
 * @param hasFiredThisTrip - 이 trip destination에 대해 firedAlarms 원장이 non-empty인지 여부.
 */
export function isInTripByEvidence(
  lock: BoardingLock | null,
  now: number,
  legAdvanceLine: LineNumber | null,
  hasFiredThisTrip: boolean,
): boolean {
  return hasConsumedOriginWait(lock, now) || legAdvanceLine !== null || hasFiredThisTrip;
}
