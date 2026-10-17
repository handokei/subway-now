/**
 * post-#2709 leg-2 lock 활성 완주 시나리오(2026-09-20 정정, `tasks/scenario-matrix-2026-09-20.md`) —
 * "device lock(7256, 17:40:32 생성, 건대입구 환승 후 leg-2 열차)이 `/boarding-lock/sync`로
 * 정상 전달돼 backend에 부착되면 어떻게 동작하는가"를
 * `capture_20260918_line7_yongmasan_overshoot.fixture.json`(실측 캡처)로 검증한다.
 *
 * ## 라벨 정정 (2026-09-20, main coordinator 지적)
 * 최초 작성 시점(#2718)에는 이 시나리오를 "대조군(실측 아님) — #2709 fix 가정"으로 불렀다.
 * **#2709(`0a5a0f89`, "lock → backend 전달 경로 통합")가 그 사이 dev에 머지됐다** — 더 이상
 * 가정이 아니라 **현재 코드의 실제 동작**이다. 2026-09-18 그 라이드 자체는 여전히 실측상
 * lock이 backend에 도달하지 못했다(아래 원 결론 그대로 보존, 사실관계 불변) — 라벨이 바뀌는
 * 부분은 "이 seed가 오늘 재현되면 어떻게 될까"라는 질문의 답이 가정에서 현재형으로 바뀐 것뿐,
 * seed 구성(boardingLock 수동 부여)과 기대값(firedStations/tripEnded)은 그대로다.
 *
 * `REPLAY_LIBRARY`(replayLibrary.ts)에는 **등록하지 않는다** — `replay_library.full.test.ts`의
 * "디렉터리 *.fixture.json ↔ REPLAY_LIBRARY 1:1 대조" 테스트가 같은 fixture 파일을 가리키는
 * 두 번째 entry(이 lock-seeded 시나리오 vs `replayLibrary.ts`의 lockless 실측 entry)를 허용하지
 * 않는다 — fixture 파일을 복제해야만 등록 가능한데, 이 시나리오는 파일 신설 없이 기존 실캡처를
 * 재사용하는 것이 목적이라 복제하지 않는다. 대신 이 standalone 파일 자체가 `Backend Validation`
 * CI job(backend vitest 전체 실행)으로 이미 매 PR 상시 게이트된다 — 등록 여부와 무관하게 회귀가
 * 생기면 CI가 즉시 잡는다. `replay_harness_line7.test.ts`와 동일한 패턴(직접 `runCaptureReplay`
 * 호출)의 별도 파일로 유지한다.
 *
 * 결론(실측 대비): 실측(lockless, `replayLibrary.ts`의 `capture_20260918_line7_yongmasan_overshoot`
 * entry)은 15 cycle 전체에서 station-passed 채널 발사 0건이다(`locklessMotionGateBlocked`
 * — device GPS position series 부재). 이 시나리오(lock 부착)는 동일 R2 캡처로 어린이대공원/
 * 군자(능동)/중곡이 정상 발사되고 목적지(용마산)도 `trip-ended(destination-arrived)`로
 * 정상 완결된다 — **lock 부착 여부가 이 사건의 유일한 분기점**이었음을 보여준다. #2709
 * (lock 동기화 실패)가 근본 원인이었고, 그 fix가 머지된 지금은 이 발사 결과가 실제 backend의
 * 현재 동작이다.
 */
import { describe, expect, it } from 'vitest';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import { makeRide20260918LockSeededTrip, RIDE_20260918_TRAIN } from './helpers/ride20260918Trip';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { parseReplayFixture } from '../replayFixture';
import fixtureJson from './fixtures/replayLibrary/capture_20260918_line7_yongmasan_overshoot.fixture.json';

const fixture = parseReplayFixture(fixtureJson);

function destinationArrivedFired(pushes: CapturedPush[]): boolean {
  return pushes.some((push) => {
    if (push.headers.pushType !== 'alert') return false;
    const data = push.body.data as Record<string, unknown> | undefined;
    return data?.kind === 'trip-ended' && data?.reason === 'destination-arrived';
  });
}

describe('post-#2709 leg-2 lock 활성 완주 — lock이 부착된 leg-2(건대입구 환승 후)로 동일 R2 캡처가 정상 발사된다', () => {
  it('어린이대공원/군자(능동)/중곡이 station-passed 채널로 발사되고 용마산 도착이 완결된다', async () => {
    const result = await runCaptureReplay({
      fixture,
      seedTrips: [makeRide20260918LockSeededTrip('contrast-lock-seeded')],
      apns: 'capture',
    });

    const fired = firedStationOccurrences(result.pushes);
    expect([...fired].sort()).toEqual(['군자(능동)', '어린이대공원(세종대)', '중곡'].sort());
    expect(destinationArrivedFired(result.pushes)).toBe(true);

    const trainCodes = result.pushes
      .filter((p) => p.headers.pushType === 'alert')
      .map((p) => (p.body.data as Record<string, unknown> | undefined)?.trainCode)
      .filter((v): v is string => typeof v === 'string');
    for (const code of trainCodes) {
      expect(code).toBe(RIDE_20260918_TRAIN);
    }
  });
});
