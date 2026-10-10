/**
 * #2610 (code review 2번) — mirror-sourced LA writer(`useForegroundLaMirrorSync` →
 * `updateLiveActivityFromMirrorStation`)가 GPS 기반 writer(`updateStationNotification`, ETA/알람
 * 배지를 포함해 content state를 쓴다)가 방금 쓴 값을 blank(mirror 경로는 ETA/alarmEvent를 계산하지
 * 않아 항상 null로 넘김)로 덮어쓰는 것을 막는 최소 arbitration.
 *
 * 근본 해결(마지막으로 알려진 etaMinutes/alarmEvent를 mirror write에도 실어 보내기)은 GPS writer와
 * mirror writer가 그 값을 담는 공유 상태를 신설해야 해 범위가 커진다. 대신 "GPS writer가 최근에
 * 썼으면 mirror writer는 그 사이 양보한다"는 recency 기반 arbitration으로 최소 수정 — GPS writer가
 * `ARBITRATION_WINDOW_MS` 내에 쓴 적이 없으면(예: WhileInUse 사용자 BG 구간처럼 GPS writer가 드물게
 * 도는 상황) mirror writer가 정상적으로 station을 갱신한다.
 *
 * in-memory 모듈 레벨 상태 — 두 writer가 같은 JS 인스턴스(FG 프로세스)에서 도는 동안만 유효하다.
 * `updateStationNotification`이 BG task(Always 권한, `backgroundLocationTask` → `stationPipeline`)에서
 * 별도 headless JS 인스턴스로 실행되는 경우 이 상태가 공유되지 않을 수 있다 — 그 경우 mirror writer는
 * 기존과 동일하게(arbitration 없이) 동작해 최소한 station 전진은 보장한다. 완전한 cross-process 공유는
 * 이 PR 범위 밖(#2610 RCA 후속).
 */

/** GPS writer가 최근에 썼다고 간주할 유예 창(ms). backend cron(~30s)보다 훨씬 짧게 잡아 mirror
 * writer가 station 전진을 과도하게 놓치지 않도록 한다. */
export const GPS_WRITE_ARBITRATION_WINDOW_MS = 5_000;

let lastDeviceGpsLiveActivityWriteAt = 0;

/** GPS writer(`updateStationNotification`)가 실제로 native LA를 쓴 직후 호출한다. */
export function markDeviceGpsLiveActivityWrite(now: number = Date.now()): void {
  lastDeviceGpsLiveActivityWriteAt = now;
}

/** GPS writer가 arbitration 창 내에 최근 썼는지. true면 mirror writer는 이번 tick을 양보한다. */
export function isDeviceGpsLiveActivityWriteRecent(now: number = Date.now()): boolean {
  return now - lastDeviceGpsLiveActivityWriteAt <= GPS_WRITE_ARBITRATION_WINDOW_MS;
}

/** 테스트 전용 — 모듈 레벨 상태를 초기화해 테스트 간 누수를 방지한다. */
export const __test__ = {
  reset(): void {
    lastDeviceGpsLiveActivityWriteAt = 0;
  },
};
