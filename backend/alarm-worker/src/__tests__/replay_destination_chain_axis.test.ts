/**
 * #2991 — 목적지 **사슬** 축 게이트: 1역 전 역 도착 알림 → 목적지 도착 → trip 종료.
 *
 * ## #2510 반전(2026-11-02)
 *
 * 비취침 "1역 전 준비 알림"(`prepare-` push, alarm.wav)은 철거됐다 — 알람은 취침 전용이다. 이 사슬의 "1역 전"
 * 기준점은 **마지막 intermediate의 도착 push**(일반 알림)로 옮겼고, 비취침 trip에서 1역 전 알람·alarm.wav가
 * **0건**임을 사슬 1단에서 고정한다(아래 표의 "1역 전 준비 알림" 행은 철거 전 실측 기록).
 *
 * ## 왜 이 테스트가 필요한가 (기존 커버리지 실측)
 *
 * 종료 발사자(`sendTripEndedAlertPush`)는 mutation 측정에서 **12건**으로 덮여 있다(2026-10-14,
 * backend 4001개 대상). 그런데 **사슬이 연결 assert된 곳이 없다** — 사용자 신고 4건이 전부
 * "함수가 틀렸다"가 아니라 "함수에 안 갔다"였던 그 축이다.
 *
 * 기존 자산이 보는 것과 안 보는 것(코드로 확인):
 *   - `replay_library.full.test.ts` + `replayLibrary.ts` — `firedStations`(집합)·
 *     `tripEnded.reason`을 본다. **집합이지 순서가 아니다.** 준비 알림이 종료 **뒤에** 와도,
 *     종료가 2번 와도, trip이 KV에 남아도 통과한다.
 *   - `prepareAlarmTargets`는 **lockless 엔트리(`capture_20260918...`)에만** 있다 — lock 활성
 *     엔트리(`capture_20260912_line7_synth`)에는 준비 알림 assert가 **없다**.
 *   - `replay_20260918_lock_seeded_contrast.test.ts` — 3역 발사 + `destination-arrived` +
 *     trainCode 신원을 본다. **준비 알림을 전혀 보지 않고**, 순서/중복/cleanup도 안 본다.
 *   - `scheduled.test.ts` — (철거 전) `evaluatePrepareAlarmTrigger`/`maybeFirePrepareAlarm` 단위. 즉
 *     "발사자는 맞게 쏘는가"만 묻고 "발사자에 **도달하는가**"는 묻지 않는다.
 *
 * ## 두 무대를 **둘 다** 돈다 (편측 방지)
 *
 * lock 활성 목적지 경로가 두 fixture에서 **서로 다르게** 끝난다 — 실측:
 *
 * | | A) `capture_20260912_line7_synth` | C) `capture_20260918_...`(lock seed) |
 * | --- | --- | --- |
 * | 1역 전 준비 알림 | ✅ +300s 용 중곡 | ✅ +541s 용 용마산 |
 * | 목적지 **도착** push(`kind='destination'`) | ✅ +420s | ❌ **0건** |
 * | `trip-ended(destination-arrived)` | ✅ +420s | ✅ +661s |
 * | KV cleanup | ✅ | ✅ |
 *
 * 한쪽만 게이트하면 편측이 된다(`/audit-sides` 룰). 그래서 두 무대를 각각 돈다 —
 * **C의 도착 push 0건은 "정상 설계"가 아니라 "현재 실측"일 뿐이다**(아래 describe 주석).
 * 그 비대칭 자체를 pin해 두면, 누가 C에 도착 확정을 넣을 때 **의도된 변경**으로 드러난다
 * (조용히 드리프트하지 않는다 — HANDOFF §6의 "현재 실측과 일치일 뿐" 선례와 동일 취급).
 *
 * ## 이 테스트의 규율
 *
 * 1. **역명/열차를 하드코딩하지 않는다** — 목적지·마지막 intermediate·lock trainCode를 전부
 *    seed trip의 `waypoints`/`boardingLock`에서 파생한다(경로가 바뀌어도 코드 수정 불필요).
 * 2. **집합이 아니라 순서와 횟수를 본다** — 1역 전 도착 알림이 종료보다 **먼저**, 종료는 **정확히 1회**,
 *    trip은 **KV에서 사라진다**. 집합 assert는 이미 라이브러리가 한다 — 중복하지 않는다.
 * 3. **"1역 전"을 시각으로 고정한다** — 준비 알림은 **마지막 intermediate의 도착 push와 같은
 *    cycle**에 떠야 한다. "준비 알림이 떴다"만 보면 목적지 3정거장 전에 떠도 통과한다.
 */
import { describe, expect, it } from 'vitest';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import { makeLine7SynthLockTrip } from './helpers/line7SynthTrip';
import { makeRide20260918LockSeededTrip } from './helpers/ride20260918Trip';
import { parseReplayFixture, type ReplayFixture } from '../replayFixture';
import synthFixtureJson from './fixtures/replayLibrary/capture_20260912_line7_synth.fixture.json';
import ride20260918FixtureJson from './fixtures/replayLibrary/capture_20260918_line7_yongmasan_overshoot.fixture.json';
import { getTrip } from '../trips';
import type { Env, Trip } from '../types';

const synthFixture = parseReplayFixture(synthFixtureJson);
const ride20260918Fixture = parseReplayFixture(ride20260918FixtureJson);

/**
 * seed trip의 waypoints에서 목적지 경계를 파생한다 — 역명 하드코딩 금지(글로벌 룰 3).
 * "1역 전"의 기준점은 목적지 **직전** waypoint다(철거 전 `evaluatePrepareAlarmTrigger`가 보던 바로
 * 그 조합 — `waypoint.kind==='intermediate'` + `nextWaypoint.kind==='destination'`).
 */
function resolveDestinationBoundary(trip: Trip): {
  destinationStation: string;
  lastIntermediateStation: string;
  lockTrainCode: string;
} {
  const destinationIndex = trip.waypoints.findIndex((waypoint) => waypoint.kind === 'destination');
  const destinationWaypoint = trip.waypoints[destinationIndex];
  const lastIntermediate = trip.waypoints[destinationIndex - 1];
  const { boardingLock } = trip;
  // 전제가 깨지면(helper 경로 변경) 조용히 통과하지 않고 여기서 멈춘다.
  expect(destinationWaypoint, 'seed trip에 destination waypoint가 있어야 한다').toBeDefined();
  expect(lastIntermediate?.kind, '목적지 직전 waypoint는 intermediate여야 한다').toBe('intermediate');
  expect(boardingLock, 'seed trip은 lock을 갖고 시작해야 한다(lock 활성 경로)').toBeDefined();
  return {
    destinationStation: destinationWaypoint.stationName,
    lastIntermediateStation: lastIntermediate.stationName,
    lockTrainCode: boardingLock!.trainCode,
  };
}

/** station-passed 계열 alert push의 payload(`data`) — `nextWaypoint`로 대상 역을 자기 식별한다. */
function stationPushData(push: CapturedPush): Record<string, unknown> | undefined {
  if (push.headers.pushType !== 'alert') return undefined;
  return push.body.data as Record<string, unknown> | undefined;
}

interface DestinationChainRun {
  /** 1역 전 알람(`prepare-`/`alarm-` collapse) 또는 alarm.wav 소리가 실린 push — 비취침이라 0건이어야 한다. */
  alarmPushes: CapturedPush[];
  /** 마지막 intermediate의 "도착" push 시각 — "1역 전" 기준점. */
  lastIntermediateArrivalAtMs: number | undefined;
  /** 목적지 자체의 "도착" push(`kind==='destination'`) — 무대에 따라 부재할 수 있다(위 표). */
  destinationArrival: { atMs: number; station: unknown; trainCode: unknown } | undefined;
  /** `trip-ended(destination-arrived)` push — 시각 목록(중복 종료 탐지용). */
  tripEndedAtMs: number[];
  /** 재생 종료 후 trip이 KV에 남아 있는가(남으면 cleanup 실패). */
  tripStillInKv: boolean;
}

async function runDestinationChain(opts: {
  fixture: ReplayFixture;
  seedTrip: Trip;
  cronIntervalMs?: number;
}): Promise<DestinationChainRun> {
  const token = opts.seedTrip.token;
  const { lastIntermediateStation } = resolveDestinationBoundary(opts.seedTrip);

  // cleanup 판정은 **재생이 끝난 뒤** 한 번 읽는다. `beforeTick`은 각 tick **직전** 상태를
  // 보므로 마지막 tick에서 일어나는 삭제를 원리적으로 못 본다(실측으로 확인 — A 무대는
  // 마지막 tick에 cleanup되어 beforeTick 기준으로는 "남아 있음"으로 보였다).
  let capturedEnv: Env | undefined;
  const result = await runCaptureReplay({
    fixture: opts.fixture,
    seedTrips: [opts.seedTrip],
    cronIntervalMs: opts.cronIntervalMs,
    apns: 'capture',
    // seedPositionSeries 의도적 미제공 — lock이 있으면 position 없이도 목적지까지 전진해야
    // 한다(#2981과 동일 규율). 주면 "lock이 position 의존을 없앴다"를 증명하지 못한다.
    beforeTick: async ({ env }) => {
      capturedEnv = env;
    },
  });
  // env를 못 받았다는 건 tick이 0회 실행됐다는 뜻 — 조용히 "cleanup됨"으로 통과시키지 않는다.
  expect(capturedEnv, '재생이 최소 1 tick은 실행돼야 한다').toBeDefined();
  const tripStillInKv = (await getTrip(capturedEnv!.TRIPS, token)) !== null;

  let lastIntermediateArrivalAtMs: number | undefined;
  let destinationArrival: DestinationChainRun['destinationArrival'];
  const tripEndedAtMs: number[] = [];

  for (const push of result.pushes) {
    const data = stationPushData(push);
    if (data === undefined) continue;
    if (data.kind === 'trip-ended' && data.reason === 'destination-arrived') {
      tripEndedAtMs.push(push.simNowMs);
    }
    if (data.kind === 'destination' && destinationArrival === undefined) {
      destinationArrival = {
        atMs: push.simNowMs,
        station: data.nextWaypoint,
        trainCode: data.trainCode,
      };
    }
    if (data.nextWaypoint === lastIntermediateStation && lastIntermediateArrivalAtMs === undefined) {
      lastIntermediateArrivalAtMs = push.simNowMs;
    }
  }

  const alarmPushes = result.pushes.filter(
    (push) =>
      /^(prepare|alarm)-/.test(push.headers.collapseId ?? '') ||
      (push.body.aps as { sound?: string } | undefined)?.sound === 'alarm.wav',
  );

  return {
    alarmPushes,
    lastIntermediateArrivalAtMs,
    destinationArrival,
    tripEndedAtMs,
    tripStillInKv,
  };
}

/**
 * 두 무대가 **공유하는** 사슬 — 1역 전 알람은 0건이고, 마지막 intermediate("1역 전")의 도착 알림이
 * 뜨고, 종료보다 **먼저** 오고, 종료는 정확히 1회이고, trip은 KV에서 사라진다. 목적지 "도착" push는 무대마다 달라(위 표) 여기서 다루지 않는다.
 */
function expectSharedDestinationChain(run: DestinationChainRun): void {
  // 1단 — 비취침 trip은 1역 전 알람·alarm.wav가 **0건**이다(#2510 반전: 알람은 취침 전용).
  expect(run.alarmPushes).toEqual([]);

  // 2단 — "1역 전"(마지막 intermediate)의 도착 알림은 발사된다(알림은 유지, 알람만 철거).
  expect(run.lastIntermediateArrivalAtMs).toBeDefined();

  // 3단 — 종료가 **정확히 1회**. 2회면 사용자에게 "안내 종료"가 중복 도달한다.
  expect(run.tripEndedAtMs).toHaveLength(1);

  // 4단 — 순서. 1역 전 도착 알림이 종료 **뒤**에 오면 알림으로서 무의미하다(집합 assert는 이걸 못 본다).
  expect(run.lastIntermediateArrivalAtMs!).toBeLessThan(run.tripEndedAtMs[0]);

  // 5단 — trip이 KV에서 정리됐다. 남으면 다음 cron이 유령 trip을 계속 추적한다(#2973 계보).
  expect(run.tripStillInKv).toBe(false);
}

describe('#2991 목적지 사슬 축 — A) 합성 캡처(lock 7204, 중곡 destination): 도착 push까지 전부 발사', () => {
  it('1역 전 도착 알림 → 목적지 도착 → 종료가 순서대로 일어나고(1역 전 알람 0) trip이 정리된다', async () => {
    const seedTrip = makeLine7SynthLockTrip('dest-chain-synth', synthFixture.window.fromMs);
    const { destinationStation, lockTrainCode } = resolveDestinationBoundary(seedTrip);

    const run = await runDestinationChain({
      fixture: synthFixture,
      seedTrip,
      // 라이브러리 엔트리와 동일 — 이 fixture는 15s 샘플이라 production cron cadence(60s)를
      // 명시해야 "위상 무관하게 발사되는가"를 재생한다(`replayLibrary.ts` 주석 참고).
      cronIntervalMs: 60_000,
    });

    expectSharedDestinationChain(run);

    // 이 무대 고유 — 목적지 자체의 "도착" push가 실제로 뜨고, **lock된 그 열차**를 실어
    // 보낸다. 신원이 어긋나면(다른 열차로 도착 통보) 사용자는 엉뚱한 열차의 도착을 받는다.
    expect(run.destinationArrival).toBeDefined();
    expect(run.destinationArrival?.station).toBe(destinationStation);
    expect(run.destinationArrival?.trainCode).toBe(lockTrainCode);

    // 순서 — 1역 전 도착 알림 < 목적지 도착 ≤ 종료. 도착과 종료는 **같은 cycle**에 함께 발사되는 것이
    // 정상이다(서로 다른 채널, #2600 계약) — 그래서 `≤`다.
    expect(run.lastIntermediateArrivalAtMs!).toBeLessThan(run.destinationArrival!.atMs);
    expect(run.destinationArrival!.atMs).toBeLessThanOrEqual(run.tripEndedAtMs[0]);
  }, 60_000);
});

/**
 * B) 실캡처(2026-09-18 라이드) + lock seed — 같은 lock 활성 경로인데 **목적지 "도착" push가
 * 0건**이다(실측). 사용자는 "곧 용마산에 도착합니다"(1역 전 준비) 다음에 바로 "안내
 * 종료"를 받고, 목적지 **도착 확정** 알림은 받지 못한다.
 *
 * **이건 정상 설계라고 주장하지 않는다 — 현재 실측과 일치할 뿐이다.** 기존
 * `replay_20260918_lock_seeded_contrast.test.ts`는 `firedStations`에 용마산을 넣지 않고
 * `destination-arrived`(종료) 발사만 확인해 이 부재를 **구조적으로 드러내지 않았다**.
 * 아래에서 `destinationArrival`을 명시적으로 `undefined`로 pin하는 이유는, 누가 이 무대에
 * 도착 확정을 넣을 때 red로 떠서 **의도된 변경**임이 드러나게 하려는 것이다(조용한 드리프트
 * 차단). 도착 확정을 넣는 것이 옳다고 판단되면 그때 이 pin을 **같은 PR에서** 갱신한다.
 */
describe('#2991 목적지 사슬 축 — B) 실캡처(lock 7256, 용마산 destination): 도착 push 부재를 pin', () => {
  it('1역 전 도착 알림 → 목적지 알림(진입 tick, #3223 U1) → 종료가 순서대로 일어난다(1역 전 알람 0)', async () => {
    const seedTrip = makeRide20260918LockSeededTrip('dest-chain-ride20260918');
    const { destinationStation, lockTrainCode } = resolveDestinationBoundary(seedTrip);

    const run = await runDestinationChain({
      fixture: ride20260918Fixture,
      seedTrip,
      // 실 P0-a 캡처 — 실제 cron cycle 시각 그대로 재생한다('recorded' cadence).
    });

    expectSharedDestinationChain(run);

    // #3223 U1 포함(10/29) — 이전엔 이 pin 이 도착 push 부재를 고정했다(위 describe 주석: 도착 확정을 넣으면 같은 PR 에서 갱신).
    // 이제 목적지는 진입(sttus0) tick 에 알림이 발사되고, lock 된 그 열차를 싣는다. 1역 전 도착 알림 < 알림 ≤ 종료 순서도 유지.
    expect(run.destinationArrival).toBeDefined();
    expect(run.destinationArrival?.station).toBe(destinationStation);
    expect(run.destinationArrival?.trainCode).toBe(lockTrainCode);
    expect(run.lastIntermediateArrivalAtMs!).toBeLessThan(run.destinationArrival!.atMs);
    expect(run.destinationArrival!.atMs).toBeLessThanOrEqual(run.tripEndedAtMs[0]);
  }, 60_000);
});
