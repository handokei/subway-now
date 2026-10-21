/**
 * #2981 — "탭 → lock 생성 → 매역 발사" 축 게이트.
 *
 * ## 왜 이 테스트가 필요한가
 *
 * `replay_library.full.test.ts`는 발사 역 집합을 정확히 assert하는 좋은 게이트인데, 모든
 * 엔트리가 `seedTrips`로 trip 상태를 **미리 확정**하고 시작한다:
 *   - `makeLine7SynthLockTrip` / `makeDesk20260913LockTrip` → lock 있음 → 매역
 *   - `makeRide20260918LocklessTrip`                        → lockless  → 매역
 *
 * 그래서 **"사용자 탭이 lock을 만드는가"는 어느 엔트리도 타지 않는다.** 그 결과
 * `#2975`(leg-1 boarding-confirm이 device가 보낸 trainCode를 `releasedForLegSwitch` 게이트
 * 때문에 열어보지도 않고 버림)가 2026-10-13 매역 알림 전멸의 root였는데도 `Backend Validation`
 * CI는 **그 결함이 있는 상태로 계속 green**이었다.
 *
 * **날짜 문제가 아니다** — 10/13 캡처로 새 fixture를 만들어도 `seedTrips`가 lock/lockless 중
 * 하나로 상태를 확정하는 순간 같은 사각지대다. 그래서 **기존 9/18 fixture를 그대로** 쓰고,
 * 재생 중에 boarding-confirm을 주입한다(`beforeTick` 훅).
 *
 * ## `seedPositionSeries`를 주지 않는 것이 핵심 assert다
 *
 * 두 경로의 device position 의존이 다르다:
 *   - **lock 활성** → `runTrainCodeTracking`이 Seoul arvlCd로 발사. **position 불필요.**
 *     (10/13 실측: 마지막 sync 06:36:26, lock 확정 06:43:32 이후 06:45:32 성수 / 06:46:56 뚝섬이
 *      **sync 없이** 발사됐고 그때도 지하였다. `recordFireAttempt`는 cron 전용 — scheduled.ts:3633)
 *   - **lockless** → `runLocklessIntermediate`가 position/motion 게이트에 의존한다
 *     (`seedPositionSeries` 주석 #2718: 주입 없으면 motion='unknown'으로 결정론적 차단).
 *
 * 즉 position series를 주지 않은 채 3역이 발사되면 그것은 **lock이 생겨서** 발사된 것이다.
 * 10/13 침묵의 기전(lock 부재 + position 부재가 둘 다 필요조건)을 9/18 데이터로 재현한다.
 *
 * ## 대조군
 *
 * `replay_20260918_lock_seeded_contrast.test.ts`가 **lock을 미리 심은** 같은 fixture로
 * `['군자(능동)', '어린이대공원(세종대)', '중곡']` + 용마산 `destination-arrived`를 이미
 * 고정한다. 이 테스트는 **그 결과를 탭으로 도달할 수 있는가**를 묻는다 — 기대값이 같아야 한다.
 *
 * ## 되돌리면 깨진다 (acceptance)
 *
 * `index.ts`의 body trainCode 경로를 다시 `releasedForLegSwitch &&`로 게이트하면(= #2976 revert)
 * confirm이 lock을 만들지 못해 lockless로 흐르고, position series가 없으므로 매역 발사가 0건이
 * 된다 → 이 테스트가 실패한다.
 */
import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import {
  makeRide20260918LocklessTrip,
  RIDE_20260918_TRAIN,
} from './helpers/ride20260918Trip';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { parseReplayFixture } from '../replayFixture';
import fixtureJson from './fixtures/replayLibrary/capture_20260918_line7_yongmasan_overshoot.fixture.json';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip } from '../types';

const fixture = parseReplayFixture(fixtureJson);
const TRIP_TOKEN = 'leg1-confirm-axis';

/**
 * 환승역에서 7호선 승차를 탭한 시점 — fixture 창 시작 + 1 cycle.
 *
 * #3057 — 2→1. 프롬프트가 도착 확정({arvlCd 1,2}/position)에서만 발사되도록 바뀌어, 첫 프롬프트가
 * tick 1 cron에서 먼저 도착한 7254를 제시하고 `recentPromptCandidates=['7254']`를 stamp한다.
 * tick 2에서 탭(7256)하면 #2824 corroboration gate가 "제시된 적 없는 열차"로 거부한다(탭 자체가
 * 아니라 이 fixture의 타이밍 문제). 프롬프트 stamp 이전(tick 1 beforeTick)에 탭하면 이 테스트의
 * 관심사(탭 → lock → 매역 발사)가 그대로 검증된다.
 */
const CONFIRM_AFTER_TICKS = 1;

function destinationArrivedFired(pushes: CapturedPush[]): boolean {
  return pushes.some((push) => {
    if (push.headers.pushType !== 'alert') return false;
    const data = push.body.data as Record<string, unknown> | undefined;
    return data?.kind === 'trip-ended' && data?.reason === 'destination-arrived';
  });
}

/**
 * 재생 시각(tick)으로 `Date.now`를 고정한 채 boarding-confirm을 POST한다.
 *
 * HTTP 핸들러는 `Date.now()`를 직접 쓰므로 고정하지 않으면 실 벽시계(현재)가 들어가
 * stamp 신선도/TTL 판정이 재생 시각과 어긋난다. 타이머 전체를 fake로 바꾸지 않고
 * `Date.now`만 스파이하는 이유: harness 내부 `await` 체인을 건드리지 않기 위해서다.
 */
async function postBoardingConfirmAt(tick: number, env: Env, trainCode: string): Promise<Response> {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
  try {
    return await app.fetch(
      new Request(`http://example.com/trips/${TRIP_TOKEN}/boarding-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'boarded',
          station: '건대입구',
          line: '7',
          trainCode,
        }),
      }),
      env,
    );
  } finally {
    spy.mockRestore();
  }
}

describe('#2981 탭 → lock 생성 → 매역 발사 (9/18 캡처, position series 없음)', () => {
  it('lockless trip에 boarding-confirm(trainCode)을 주입하면 lock-seeded와 동일하게 3역이 발사된다', async () => {
    let confirmStatus: number | null = null;

    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeRide20260918LocklessTrip(TRIP_TOKEN)],
      apns: 'capture',
      // seedPositionSeries 의도적 미제공 — 위 헤더 "핵심 assert" 참고.
      beforeTick: async ({ tick, tickIndex, env }) => {
        if (tickIndex !== CONFIRM_AFTER_TICKS) return;
        // #3144 (v8 D2, ADR-043) — 탭의 trainCode는 backend가 프롬프트로 제시한 열차여야 lock이 된다
        // (증거 없음 = 거부). 이 테스트의 관심사는 "응답 -> lock -> 매역 발사"이므로 탭 직전에 프롬프트가
        // 7256을 제시했다는 stamp를 둔다(실측 ride의 사용자는 7256에 응답했다).
        const trip = await getTrip(env.TRIPS, TRIP_TOKEN);
        await putTrip(env.TRIPS, {
          ...(trip as Trip),
          recentPromptCandidates: { trainCodes: [RIDE_20260918_TRAIN], firedAt: tick - 1_000 },
        });
        const res = await postBoardingConfirmAt(tick, env, RIDE_20260918_TRAIN);
        confirmStatus = res.status;
      },
    });

    // 탭 자체가 성공해야 한다 — 404/400이면 아래 발사 assert가 "다른 이유로" 실패한다.
    expect(confirmStatus).toBe(200);

    const fired = firedStationOccurrences(result.pushes);
    expect([...fired].sort()).toEqual(['군자(능동)', '어린이대공원(세종대)', '중곡'].sort());
    expect(destinationArrivedFired(result.pushes)).toBe(true);
  });
});
