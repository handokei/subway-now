/**
 * 재생(replay) 결과에서 발사된 push를 채널별로 추출하는 공용 assertion helper (#2615 리뷰
 * F9 — `replay_library.full.test.ts`와 `2615_midcycle_repoll.test.ts` 둘 다 동일 로직을
 * 각자 복제하지 않도록 이 파일 하나로 합친다).
 */
import type { CapturedPush } from './replayHarness';

/**
 * alert push 중 station-passed(`data.nextWaypoint`, arvlcd/vanish-fallback/mid-cycle-fire
 * `buildStationPassedImminentPayload`) 채널로 발사된 것 전부 — 시간순, **중복 제거하지
 * 않는다**. 같은 역이 두 번 발사되면(회귀) 그 중복이 그대로 남아야 sorted exact-match가
 * 이를 잡아낸다.
 *
 * hop-end-prompt 채널(`firedHopEndPromptStations`)과 반드시 분리 집계한다(#2600 코드리뷰
 * 항목1) — 한 리스트에 합산하면 둘 다 정상 발사되는 transfer trip(예: 어린이대공원 fire와
 * 무관하게 항상 뜨는 hop-end-prompt + SSoT 신선도를 만족해 같이 뜨는 station-passed alert)
 * 에서 같은 역이 2회로 잡혀, registry의 단일 `firedStations` 기대와 어긋나는 false-red를
 * 만든다.
 */
export function firedStationOccurrences(pushes: CapturedPush[]): string[] {
  const occurrences: string[] = [];
  for (const push of pushes) {
    if (push.headers.pushType !== 'alert') continue;
    const data = push.body.data as Record<string, unknown> | undefined;
    const station = data?.nextWaypoint;
    if (typeof station === 'string' && station.length > 0) occurrences.push(station);
  }
  return occurrences;
}

/**
 * #2718 — lockless intermediate 통과(`runLocklessIntermediate`, #816 C `infoModeEnabled`)
 * 채널로 발사된 것 전부. `firedStationOccurrences`(lock 활성 arvlcd/vanish-fallback, alert
 * push)와 **wire 계약이 다르다** — 이 채널은 `pushType: 'background'`(silent push, device가
 * 로컬 알림을 구성) + `data.kind === 'intermediate'` + `data.origin === 'lockless'`로 식별한다.
 * lock-active 채널과 혼동해 한 리스트에 합산하면 안 된다(서로 다른 trip 상태에서만 배타적으로
 * 발생하므로 실제로 섞일 일은 없지만, 채널 자체가 다르다는 사실을 명시해 향후 오용을 막는다).
 * `kind==='destination'` waypoint는 `runLocklessIntermediate`가 코드로 명시 skip하므로
 * (types.ts:184 주석) 이 채널에서 목적지 역은 원리적으로 나타나지 않는다.
 */
export function firedLocklessIntermediateStations(pushes: CapturedPush[]): string[] {
  const occurrences: string[] = [];
  for (const push of pushes) {
    if (push.headers.pushType !== 'background') continue;
    const data = push.body.data as Record<string, unknown> | undefined;
    if (data?.kind !== 'intermediate' || data?.origin !== 'lockless') continue;
    const station = data?.nextWaypoint;
    if (typeof station === 'string' && station.length > 0) occurrences.push(station);
  }
  return occurrences;
}

/**
 * #2718 — "1정거장 전" 준비 알림(`maybeFirePrepareAlarm`, 진동/사운드 있는 실제 alert push,
 * "곧 OO에 도착합니다. 하차 준비하세요!")이 발사된 목적지(prepare target) 목록.
 * `collapseId`가 `prepare-<tokenPrefix>-<targetStation>` 형태라 다른 alert 채널과
 * 구분된다. lock 활성/lockless 무관하게 동작하는 채널 — 목적지 waypoint 자체의 "도착"
 * 확정 push(`destinationArrivedFired`/`firedStationOccurrences`의 destination 항목)와는
 * 별개로, "곧 도착"만 알린다(하차 확정 아님).
 */
export function firedPrepareAlarmTargets(pushes: CapturedPush[]): string[] {
  const occurrences: string[] = [];
  for (const push of pushes) {
    if (push.headers.pushType !== 'alert') continue;
    const collapseId = push.headers.collapseId;
    if (typeof collapseId !== 'string') continue;
    const match = collapseId.match(/^prepare-.+-(.+)$/);
    if (match) occurrences.push(match[1]);
  }
  return occurrences;
}
