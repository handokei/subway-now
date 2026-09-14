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
