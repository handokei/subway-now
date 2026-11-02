/**
 * #3036 (Part of #2997) — 2026-11-02 아침 출발역(용마산) 탑승 질문 미발사 실측 replay. PR-2: fixture + 현행 baseline.
 *
 * 입력은 불변 실측 — `fixtures/originPrompt/capture_20261102_morning_yongmasan_b00dd879.fixture.json`
 * (R2 `seoul-capture` 16 cycle, 06:27:45~06:42:45 KST, `scripts/fixtureFromTrip.mjs --token-hash b00dd879 --trip-index 2`).
 * 통과시키려 조정 금지. cycle에는 position(7호선/2호선)만 있고 arrival(용마산)은 0건 — 실제 production이
 * 출발역 arrival 조회 이전 게이트에서 return했다는 사실(plan §1.3)과 일치한다.
 *
 * 실측 불가 device 입력은 합성 변형으로 분리한다(`helpers/ride20261102MorningTrips.ts` 주석):
 *  - V-a: 근접 정보 없음 / V-b: 등록 스냅샷 원거리(2000m, acc 20)
 *  - alarmAt 변형: alarm0 / alarm1 / alarm7
 *
 * 열차(실측, plan §1.4): 용마산 도착 확정 tick = 7035 @06:28:46, 7039 @06:34:45, 7043 @06:40:45(+replay exec lag 1s).
 *
 * 이 파일은 **현행 코드 baseline**이다: trackingOptIn-only 두 변형은 질문 0건(= 11/02 재현), 대조군(promptOptIn)은
 * 위 3건 발사(= 하네스·fixture 자체 검증). O3 창 구현(PR-3b)이 이 baseline을 뒤집는다.
 */
import { describe, expect, it } from 'vitest';
import {
  boardingPromptsOf,
  replayRide20261102,
} from './helpers/originPromptReplay';
import {
  makeRide20261102GeoContext,
  makeRide20261102MorningTrip,
  type Ride20261102AlarmVariant,
} from './helpers/ride20261102MorningTrips';

const ALARM_VARIANTS: Ride20261102AlarmVariant[] = ['alarm0', 'alarm1', 'alarm7'];

// alarm7: 폴링 창 게이트(alarmAt-now>5분, scheduled.ts 1839)가 06:28:46 tick을 가려 7035가 빠진다(plan §17.9) —
// promptOptIn은 tripHasDeclaredIntent에 포함되지 않아 이 게이트를 우회하지 못한다(실측 확인).
const CONTROL_EXPECTED: Record<Ride20261102AlarmVariant, Array<[string, string]>> = {
  alarm0: [['06:28:46', '7035'], ['06:34:46', '7039'], ['06:40:46', '7043']],
  alarm1: [['06:28:46', '7035'], ['06:34:46', '7039'], ['06:40:46', '7043']],
  alarm7: [['06:34:46', '7039'], ['06:40:46', '7043']],
};

describe('#3036 — 11/02 아침 대조군: 안내 시작(promptOptIn) trip은 도착 확정마다 발사', () => {
  it.each(ALARM_VARIANTS)('%s: 실제 APNs 요청이 도착 확정 tick과 일치', async (alarm) => {
    const result = await replayRide20261102((at) =>
      makeRide20261102MorningTrip('replay-20261102-control', at, { intent: 'promptOptIn', alarm }),
    );
    expect(result.lossyCapture).toBe(false);
    const prompts = boardingPromptsOf(result);
    expect(prompts).toEqual(CONTROL_EXPECTED[alarm]);
  });
});

describe('#3036 — 11/02 아침 현행 baseline: trackingOptIn-only는 근접 실측 없이 질문 0건', () => {
  const VARIANTS = [
    { label: 'V-a 근접 정보 없음', geo: () => undefined },
    {
      label: 'V-b 등록 스냅샷 원거리(2000m, acc 20)',
      geo: () => makeRide20261102GeoContext({ originDistanceM: 2000, originAccuracyM: 20 }),
    },
  ];
  for (const { label, geo } of VARIANTS) {
    it.each(ALARM_VARIANTS)(`${label} / %s: boarding-prompt 요청 0건 + 사유 = trackingOptIn 근접 fail-closed`, async (alarm) => {
      const result = await replayRide20261102((at) =>
        makeRide20261102MorningTrip('replay-20261102-tracking', at, { intent: 'tracking', alarm, geo: geo() }),
      );
      expect(boardingPromptsOf(result)).toEqual([]);
      const blocked = result.cycles.reduce((sum, c) => sum + c.stats.trackingOptInProximityMissingBlocked, 0);
      const fired = result.cycles.reduce((sum, c) => sum + c.stats.originGpsFreeBoardingPromptFired, 0);
      expect(fired).toBe(0);
      expect(blocked).toBeGreaterThan(0);
    });
  }
});
