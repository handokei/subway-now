/**
 * #2754 (요구사항 4, 회귀 고정) — leg-2 cron 자동 resolve가 9/18 실캡처(뚝섬→건대입구 환승→
 * 용마산, 실제 탑승 7256)에서 사용자가 타지 않은 열차를 lock하지 않는다.
 *
 * 구 설계("같은 trainCode가 LEG_RESOLVE_STREAK_THRESHOLD회 연속 ARRIVED/APPROACHING")는
 * "사용자가 탄 열차는 타자마자 출발하므로 ARRIVED를 2 cycle 연속 유지할 수 없다"는 실측
 * 제약과 정반대로 동작해 정답(7256, 17:40:31 ARRIVED → 17:41:32 DEPARTED로 즉시 후보
 * 탈락)을 배제하고, 9분 뒤 플랫폼에 새로 들어와 2 cycle 연속 ARRIVED로 관측된 무관한 열차
 * 7260을 lock했다(`replayLibrary.ts` 해당 entry 주석 참고).
 *
 * 이 테스트는 `REPLAY_LIBRARY`의 `capture_20260918_line7_yongmasan_overshoot` entry(동일
 * seed/실측 motion series)를 그대로 재사용해 재생하고, 발사된 어떤 push도 trainCode:'7260'을
 * 싣지 않는다는 것만 확인한다 — 7256이 잡히거나(정답) 아무것도 안 잡히는 것(안전, lock 미형성)
 * 은 모두 허용한다.
 */
import { describe, expect, it } from 'vitest';
import { REPLAY_LIBRARY } from './replayLibrary';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';

const ENTRY = REPLAY_LIBRARY.find(
  (entry) => entry.slug === 'capture_20260918_line7_yongmasan_overshoot',
);
if (!ENTRY) {
  throw new Error('capture_20260918_line7_yongmasan_overshoot entry missing from REPLAY_LIBRARY');
}

/** 어떤 채널이든 push body.data.trainCode로 실린 trainCode 전부(중복 포함, 시간순). */
function pushTrainCodes(pushes: CapturedPush[]): string[] {
  const codes: string[] = [];
  for (const push of pushes) {
    const data = push.body.data as Record<string, unknown> | undefined;
    if (typeof data?.trainCode === 'string') codes.push(data.trainCode);
  }
  return codes;
}

describe('#2754 — 9/18 실캡처 leg-2 자동 resolve 오탑승 lock 회귀 고정', () => {
  it('7260(사용자가 타지 않은, 9분 뒤 플랫폼에 들어온 열차)이 lock되어 push를 발사하지 않는다', async () => {
    const fixture = ENTRY!.loadFixture();
    const result = await runCaptureReplay({
      fixture,
      seedTrips: ENTRY!.seedTrips(),
      cronIntervalMs: ENTRY!.cronIntervalMs === 'recorded' ? undefined : ENTRY!.cronIntervalMs,
      phaseOffsetMs: 0,
      apns: 'capture',
      seedPositionSeries: ENTRY!.seedPositionSeries?.(),
    });

    const trainCodes = pushTrainCodes(result.pushes);
    // 정답(7256)이 아닌 값이 하나라도 나오면 그 자체가 오탑승 lock 회귀다.
    for (const code of trainCodes) {
      expect(code).toBe('7256');
    }
    expect(trainCodes).not.toContain('7260');
  });
});
