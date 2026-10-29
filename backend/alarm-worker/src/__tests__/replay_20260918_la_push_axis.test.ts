/**
 * #2983 — backend LA push 발사 축 게이트.
 *
 * ## 왜
 *
 * LA 이슈가 반복된다: #2667(push 24h 0건) → #2806 → #2828 → #2805 → #2854 → #2962 → 그리고
 * **#2667 증상 재발**(2026-10-13 `laPushDelivery=0% (0/0)`). 사슬은
 * `device JS → native Swift(ActivityKit) → APNs → 렌더`인데 **Swift 층은 테스트가 0개**다
 * (Swift 14파일, `*Tests.swift` 전무 — `check-swift-mirror.sh`는 사본 diff만 본다).
 *
 * 그런데 **backend → APNs LA push 축은 테스트 가능한데도 비어 있었다.** 측정:
 * 9/18 lock-seeded replay의 push를 타입별로 집계하면 `{"background":3,"alert":5}` —
 * **`liveactivity` 0건**이다. seed trip에 `activityPushToken`이 없기 때문이고, harness는
 * `apns-push-type`을 캡처하므로(`replayHarness.ts:205`) 토큰이 있으면 캡처된다.
 *
 * ## 고정하는 계약 (경로별로 다르다 — verify-plan 검사 #8 반증 반영)
 *
 * 게이트가 4곳에 중복돼 있고 경로에 따라 threshold가 더 걸린다:
 * ```
 * scheduled.ts:2114   토큰+live → maybeFireLiveActivityUpdate   (heartbeat: ΔETA≥30s ∨ hb≥90s)
 * scheduled.ts:6299   토큰+live → fireLiveActivityUpdate        (waypoint advance: threshold 없음)
 * liveActivity.ts:249 / :336   fire 본체의 동일 게이트
 * ```
 * 따라서 *"토큰이 있으면 쏜다"* 는 계약으로 **부정확하다** — 토큰을 심어도 threshold 미달이면
 * 0건이고 그걸 "게이트 작동"으로 오독할 수 있다(`tasks/lessons.md` L28).
 *
 * **고정 대상은 advance 경로다.** 9/18 재생은 어린이대공원/군자/중곡 **3역 advance**가 이미
 * 확인돼 있다(`replay_20260918_lock_seeded_contrast.test.ts`) → 토큰을 심으면 LA push가 나가야
 * 한다. heartbeat 경로(threshold 단독 축)는 범위 밖.
 *
 * ## 전제 (전부 확인됨)
 *
 * - `types.ts:147` `activityState?: 'live' | 'ended'` — 2값뿐, 다른 상태 없음
 * - `apns.ts:825` `'apns-push-type': 'liveactivity'` — 실제 발사 헤더
 * - `replayHarness.ts:210` 가짜 APNs는 **항상 200** → `liveActivity.ts:290` 토큰 clear(410) 분기에
 *   도달하지 않는다. 즉 재생 중 토큰이 지워져 테스트가 다른 이유로 움직이는 일이 없다
 * - `ride20260918Trip.ts`에 `lastLaPush*` 없음 → 첫 push가 threshold를 통과
 *
 * ## acceptance
 *
 * `liveActivity.ts:249`의 가드를 무조건 `return`으로 바꾸면(= LA push 경로 사망) 고정 테스트가
 * 실패해야 한다. 거부 케이스 2종은 revert 전후 모두 green이어야 한다.
 */
import { describe, expect, it } from 'vitest';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import {
  makeRide20260918LaTrip,
  makeRide20260918LockSeededTrip,
} from './helpers/ride20260918Trip';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { parseReplayFixture } from '../replayFixture';
import fixtureJson from './fixtures/replayLibrary/capture_20260918_line7_yongmasan_overshoot.fixture.json';

const fixture = parseReplayFixture(fixtureJson);

/**
 * `apns-push-type: liveactivity`는 **두 채널이 공유**한다 — `event:'update'`(content-state
 * 교체, `fireLiveActivityUpdate`)와 `event:'end'`(종료 dismissal,
 * `liveActivity.ts:329 fireLiveActivityDismissal`). 둘을 합쳐 세면 안 된다.
 *
 * 실측으로 확인한 함정: `fireLiveActivityUpdate` 본체를 죽여도(revert 시뮬레이션) 트립 종료
 * dismissal 1건이 남아 "liveactivity ≥ 1"이 **그대로 통과**했다. 즉 합산 카운트로는 발사 축이
 * 죽은 것을 감지하지 못한다 — event로 반드시 가른다.
 */
function countLaUpdatePushes(pushes: CapturedPush[]): number {
  return pushes.filter((p) => {
    if (p.headers.pushType !== 'liveactivity') return false;
    const aps = (p.body as Record<string, unknown>).aps as Record<string, unknown> | undefined;
    return aps?.event === 'update';
  }).length;
}

function countLaEndPushes(pushes: CapturedPush[]): number {
  return pushes.filter((p) => {
    if (p.headers.pushType !== 'liveactivity') return false;
    const aps = (p.body as Record<string, unknown>).aps as Record<string, unknown> | undefined;
    return aps?.event === 'end';
  }).length;
}

describe('#2983 backend LA push 발사 축 (9/18 캡처)', () => {
  it('activityPushToken + activityState=live면 LA push가 발사된다', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [
        makeRide20260918LaTrip('la-axis-live', {
          activityPushToken: 'la-token-live',
          activityState: 'live',
        }),
      ],
      apns: 'capture',
    });

    // 실측: 정상 상태에서 update 11건. 종료 dismissal(event:'end')과 합산하지 않는다 —
    // 합산하면 발사 경로가 죽어도 dismissal 1건이 남아 통과한다(위 helper 주석).
    expect(countLaUpdatePushes(result.pushes)).toBeGreaterThanOrEqual(1);
    // 채널 분리 명시 — dismissal은 별개로 1건 나간다(destination-arrived 종료).
    expect(countLaEndPushes(result.pushes)).toBeGreaterThanOrEqual(1);
  });

  // 교차 고정 — LA push가 추가돼도 기존 alert 채널(station-passed)을 밀어내지 않는다.
  // #2600 채널 분리 계약. 대조군(`replay_20260918_lock_seeded_contrast.test.ts`)과 동일 집합.
  it('LA push가 추가돼도 station-passed alert 3역은 무변경이다', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [
        makeRide20260918LaTrip('la-axis-channels', {
          activityPushToken: 'la-token-live',
          activityState: 'live',
        }),
      ],
      apns: 'capture',
    });

    const fired = firedStationOccurrences(result.pushes);
    // #3223 U1 포함(10/29): 목적지 용마산도 진입(sttus0) tick 에 알림이 발사된다 — 이전엔 3역만(목적지 도착 push 부재, #2991).
    expect([...fired].sort()).toEqual(['군자(능동)', '어린이대공원(세종대)', '중곡', '용마산'].sort());
  });

  // 거부 ① — 토큰이 없으면 0건. 현재 라이브러리 엔트리가 전부 이 상태라 축이 비어 있었다.
  it('[거부] activityPushToken이 없으면 LA push 0건', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeRide20260918LockSeededTrip('la-axis-notoken')],
      apns: 'capture',
    });

    expect(countLaUpdatePushes(result.pushes)).toBe(0);
  });

  // 거부 ② — 토큰이 있어도 activityState가 'ended'면 0건. `liveActivity.ts:249`의 두 조건이
  // AND가 아니라 OR-가드(`!token || state !== 'live'`)라 둘 중 하나만 깨져도 차단돼야 한다.
  it('[거부] activityState=ended면 토큰이 있어도 LA push 0건', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [
        makeRide20260918LaTrip('la-axis-ended', {
          activityPushToken: 'la-token-ended',
          activityState: 'ended',
        }),
      ],
      apns: 'capture',
    });

    expect(countLaUpdatePushes(result.pushes)).toBe(0);
  });
});
