/**
 * 대조군(**실측 아님**, #2718 fidelity 정정 후속) — "device lock(7256, 17:40:32 생성)이
 * `/boarding-lock/sync`로 정상 전달돼 backend에 부착됐다면 어떻게 동작했을까"를
 * `capture_20260918_line7_yongmasan_overshoot.fixture.json`(실측 캡처)로 대조한다.
 *
 * `REPLAY_LIBRARY`(replayLibrary.ts)에는 **등록하지 않는다** — 그 라이브러리는 실측 재현
 * entry만 담는다는 계약(#2585)을 지키기 위해, 이 대조군은 `replay_harness_line7.test.ts`와
 * 동일한 패턴(직접 `runCaptureReplay` 호출)의 별도 파일로 둔다.
 *
 * 결론(실측 대비): 실측(lockless, `replayLibrary.ts`의 `capture_20260918_line7_yongmasan_overshoot`
 * entry)은 15 cycle 전체에서 station-passed 채널 발사 0건이다(`locklessMotionGateBlocked`
 * — device GPS position series 부재). 이 대조군(lock 부착 가정)은 동일 R2 캡처로 어린이대공원/
 * 군자(능동)/중곡이 정상 발사되고 목적지(용마산)도 `trip-ended(destination-arrived)`로
 * 정상 완결된다 — **lock 부착 여부가 이 사건의 유일한 분기점**이었음을 보여준다. #2709
 * (lock 동기화 실패)가 근본 원인이라는 근거.
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

describe('대조군(실측 아님) — lock이 부착됐다면(#2709 fix 가정) 동일 R2 캡처가 정상 발사됐을 것', () => {
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
